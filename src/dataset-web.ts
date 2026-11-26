import { authenticatedPostError, type SessionUser } from './auth';
import {
  DatasetFreezeError,
  DatasetNotFoundError,
  DatasetRevisionConflictError,
  DatasetStateError,
  freezeDataset,
  getDatasetRevision,
  importDatasetPackage,
  launchDatasetRun,
  listDatasets,
  recordDatasetSignoff,
  releaseDataset,
} from './dataset-repository';
import { parseDatasetPackage } from './dataset-package';
import { dispatchRun } from './dispatch';
import { requireResearcher } from './guard';
import { messagePage } from './html';
import { htmlResponse, methodNotAllowed, redirect } from './http';
import { datasetDetailPage, datasetLibraryPage, type DatasetPageNotice } from './dataset-pages';
import { readLimitedBody } from './upload';

const DETAIL_PATH = /^\/datasets\/([^/]+)$/;
const SIGN_OFF_PATH = /^\/datasets\/([^/]+)\/sign-off$/;
const RUNS_PATH = /^\/datasets\/([^/]+)\/runs$/;
const FREEZE_PATH = /^\/datasets\/([^/]+)\/freeze$/;
const RELEASE_PATH = /^\/datasets\/([^/]+)\/release$/;
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

export async function handleDatasetsHtml(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path !== '/datasets' && !path.startsWith('/datasets/')) return null;

  const guarded = await requireResearcher(request, env, 'html');
  if (!guarded.ok) return guarded.response;

  try {
    return await routeDatasetsHtml(request, env, path, guarded.session);
  } catch (error) {
    if (error instanceof DatasetNotFoundError) return notFoundPage(guarded.session);
    throw error;
  }
}

async function routeDatasetsHtml(
  request: Request,
  env: Env,
  path: string,
  session: SessionUser,
): Promise<Response> {
  if (path === '/datasets') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return htmlResponse(datasetLibraryPage(session, await listDatasets(env.DB)));
  }

  if (path === '/datasets/import') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return importPackage(request, env, session);
  }

  const signOff = SIGN_OFF_PATH.exec(path);
  if (signOff !== null) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return signOffCase(request, env, session, signOff[1] as string);
  }

  const runs = RUNS_PATH.exec(path);
  if (runs !== null) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return launchStudyRun(request, env, session, runs[1] as string);
  }

  const freeze = FREEZE_PATH.exec(path);
  if (freeze !== null) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return freezeRevision(request, env, session, freeze[1] as string);
  }

  const release = RELEASE_PATH.exec(path);
  if (release !== null) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return releaseRevision(request, env, session, release[1] as string);
  }

  const detail = DETAIL_PATH.exec(path);
  if (detail !== null) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return detailPage(env, session, detail[1] as string, noticeFromUrl(request));
  }

  return notFoundPage(session);
}

function noticeFromUrl(request: Request): DatasetPageNotice | undefined {
  const value = new URL(request.url).searchParams.get('notice');
  if (value === 'imported') return { kind: 'ok', message: 'The package was imported as a draft.' };
  if (value === 'unchanged') return { kind: 'ok', message: 'This revision was already imported; nothing changed.' };
  if (value === 'frozen') return { kind: 'ok', message: 'The dataset revision is frozen.' };
  if (value === 'signed-off') return { kind: 'ok', message: 'The case sign-off is recorded.' };
  if (value === 'released') return { kind: 'ok', message: 'Held-out cases are released for the main study.' };
  return undefined;
}

async function detailPage(
  env: Env,
  session: SessionUser,
  revisionId: string,
  notice: DatasetPageNotice | undefined,
): Promise<Response> {
  const dataset = await getDatasetRevision(env.DB, revisionId);
  return htmlResponse(datasetDetailPage(session, dataset, { notice }));
}

async function importPackage(
  request: Request,
  env: Env,
  session: SessionUser,
): Promise<Response> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number.parseInt(declared, 10) > MAX_IMPORT_BYTES) {
    return htmlResponse(
      datasetLibraryPage(session, await listDatasets(env.DB), {
        uploadErrors: ['The package upload is too large.'],
      }),
      413,
    );
  }

  let form: FormData;
  try {
    const body = await readLimitedBody(request, MAX_IMPORT_BYTES);
    form = await new Request('https://upload.invalid', {
      method: 'POST',
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
      body,
    }).formData();
  } catch {
    return htmlResponse(
      datasetLibraryPage(session, await listDatasets(env.DB), {
        uploadErrors: ['The package form could not be read. Choose the three JSON files again.'],
      }),
      422,
    );
  }
  if (authenticatedPostError(request, session, formString(form, '_csrf')) !== null) {
    return blockedPage(session);
  }

  const parsedFiles: Record<'manifest' | 'scoring' | 'verification', unknown> = {
    manifest: null,
    scoring: null,
    verification: null,
  };
  const uploadErrors: string[] = [];
  for (const name of ['manifest', 'scoring', 'verification'] as const) {
    const file = form.get(name);
    if (!(file instanceof File)) {
      uploadErrors.push(`Choose a ${name} JSON file.`);
      continue;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      uploadErrors.push(`The ${name} file is too large.`);
      continue;
    }
    try {
      parsedFiles[name] = JSON.parse(await file.text());
    } catch {
      uploadErrors.push(`The ${name} file is not valid JSON.`);
    }
  }
  if (uploadErrors.length > 0) {
    return htmlResponse(
      datasetLibraryPage(session, await listDatasets(env.DB), { uploadErrors }),
      422,
    );
  }

  const parsed = parseDatasetPackage(parsedFiles);
  if (!parsed.ok) {
    return htmlResponse(
      datasetLibraryPage(session, await listDatasets(env.DB), {
        packageErrors: parsed.errors,
      }),
      422,
    );
  }

  try {
    const imported = await importDatasetPackage(
      env.DB,
      parsed.package,
      parsedFiles,
      session.id,
      new Date().toISOString(),
    );
    return redirect(`/datasets/${imported.revisionId}?notice=${imported.created ? 'imported' : 'unchanged'}`);
  } catch (error) {
    if (error instanceof DatasetRevisionConflictError) {
      return htmlResponse(
        datasetLibraryPage(session, await listDatasets(env.DB), {
          notice: {
            kind: 'error',
            message: 'This revision label was already imported with different contents. Bump the revision.',
          },
        }),
        409,
      );
    }
    if (error instanceof DatasetStateError) {
      return htmlResponse(
        datasetLibraryPage(session, await listDatasets(env.DB), {
          notice: { kind: 'error', message: error.message },
        }),
        409,
      );
    }
    throw error;
  }
}

async function signOffCase(
  request: Request,
  env: Env,
  session: SessionUser,
  revisionId: string,
): Promise<Response> {
  const form = await request.formData();
  if (authenticatedPostError(request, session, formString(form, '_csrf')) !== null) {
    return blockedPage(session);
  }
  const caseKey = formString(form, 'caseKey');
  const evidenceNote = formString(form, 'evidenceNote');
  try {
    await recordDatasetSignoff(
      env.DB,
      revisionId,
      caseKey,
      session.id,
      evidenceNote,
      new Date().toISOString(),
    );
  } catch (error) {
    if (error instanceof DatasetStateError || error instanceof DatasetNotFoundError) {
      return htmlResponse(
        datasetDetailPage(session, await getDatasetRevision(env.DB, revisionId), {
          notice: { kind: 'error', message: error.message },
        }),
        error instanceof DatasetNotFoundError ? 404 : 409,
      );
    }
    throw error;
  }
  return redirect(`/datasets/${revisionId}?notice=signed-off`);
}

async function launchStudyRun(
  request: Request,
  env: Env,
  session: SessionUser,
  revisionId: string,
): Promise<Response> {
  const form = await request.formData();
  if (authenticatedPostError(request, session, formString(form, '_csrf')) !== null) {
    return blockedPage(session);
  }
  const submissionId = formString(form, 'submissionId');
  try {
    const launched = await launchDatasetRun(
      env.DB,
      revisionId,
      submissionId,
      session.id,
      new Date().toISOString(),
    );
    await dispatchRun(env, launched.runId);
    return redirect(`/runs/${launched.runId}`);
  } catch (error) {
    if (error instanceof DatasetStateError || error instanceof DatasetNotFoundError) {
      return htmlResponse(
        datasetDetailPage(session, await getDatasetRevision(env.DB, revisionId), {
          notice: { kind: 'error', message: error.message },
        }),
        error instanceof DatasetNotFoundError ? 404 : 409,
      );
    }
    throw error;
  }
}

async function freezeRevision(
  request: Request,
  env: Env,
  session: SessionUser,
  revisionId: string,
): Promise<Response> {
  const form = await request.formData();
  if (authenticatedPostError(request, session, formString(form, '_csrf')) !== null) {
    return blockedPage(session);
  }
  try {
    await freezeDataset(env.DB, revisionId, session.id, new Date().toISOString());
  } catch (error) {
    if (error instanceof DatasetFreezeError) {
      return htmlResponse(
        datasetDetailPage(session, await getDatasetRevision(env.DB, revisionId), {
          freezeIssues: error.issues,
          notice: { kind: 'warn', message: 'Resolve the listed checks, then freeze again.' },
        }),
        409,
      );
    }
    if (error instanceof DatasetStateError || error instanceof DatasetNotFoundError) {
      return htmlResponse(
        datasetDetailPage(session, await getDatasetRevision(env.DB, revisionId), {
          notice: { kind: 'error', message: error.message },
        }),
        error instanceof DatasetNotFoundError ? 404 : 409,
      );
    }
    throw error;
  }
  return redirect(`/datasets/${revisionId}?notice=frozen`);
}

async function releaseRevision(
  request: Request,
  env: Env,
  session: SessionUser,
  revisionId: string,
): Promise<Response> {
  const form = await request.formData();
  if (authenticatedPostError(request, session, formString(form, '_csrf')) !== null) {
    return blockedPage(session);
  }
  try {
    await releaseDataset(
      env.DB,
      revisionId,
      session.id,
      formString(form, 'studyProtocolRef'),
      new Date().toISOString(),
    );
  } catch (error) {
    if (error instanceof DatasetStateError || error instanceof DatasetNotFoundError) {
      return htmlResponse(
        datasetDetailPage(session, await getDatasetRevision(env.DB, revisionId), {
          notice: { kind: 'error', message: error.message },
        }),
        error instanceof DatasetNotFoundError ? 404 : 409,
      );
    }
    throw error;
  }
  return redirect(`/datasets/${revisionId}?notice=released`);
}

function blockedPage(session: SessionUser): Response {
  return htmlResponse(
    messagePage({
      title: 'Request blocked',
      message: 'The form could not be verified. Reload the page and try again.',
      user: session,
    }),
    403,
  );
}

function notFoundPage(session: SessionUser): Response {
  return htmlResponse(
    messagePage({
      title: 'Dataset not found',
      message: 'That dataset revision does not exist.',
      user: session,
    }),
    404,
  );
}

function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}
