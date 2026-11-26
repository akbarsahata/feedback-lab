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
import { MAX_DATASET_SOURCES, parseDatasetPackage, type DatasetPackageFiles } from './dataset-package';
import { dispatchRun } from './dispatch';
import { formString } from './forms';
import { requireResearcher } from './guard';
import { messagePage } from './html';
import { htmlResponse, methodNotAllowed, redirect } from './http';
import { datasetDetailPage, datasetLibraryPage, type DatasetPageNotice } from './dataset-pages';
import { readLimitedBody, UploadError } from './upload';
import { parseJsonValue } from './json';

const DETAIL_PATH = /^\/datasets\/([^/]+)$/;
const ACTION_PATH = /^\/datasets\/([^/]+)\/(sign-off|runs|freeze|release)$/;
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

  const action = ACTION_PATH.exec(path);
  if (action !== null) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return blockedPage(session);
    }
    if (authenticatedPostError(request, session, formString(form, '_csrf')) !== null) {
      return blockedPage(session);
    }
    return applyDatasetAction(env, session, action[1]!, action[2]!, form);
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
  } catch (error) {
    const tooLarge = error instanceof UploadError && error.status === 413;
    return htmlResponse(
      datasetLibraryPage(session, await listDatasets(env.DB), {
        uploadErrors: [tooLarge
          ? 'The package upload is too large.'
          : 'The package form could not be read. Choose the package files again.'],
      }),
      tooLarge ? 413 : 422,
    );
  }
  if (authenticatedPostError(request, session, formString(form, '_csrf')) !== null) {
    return blockedPage(session);
  }

  const parsedFiles: DatasetPackageFiles = {
    manifest: null,
    scoring: null,
    verification: null,
  };
  const uploadErrors: string[] = [];
  for (const name of ['manifest', 'scoring', 'verification'] as const) {
    const [file, ...duplicates] = form.getAll(name);
    if (!(file instanceof File) || duplicates.length > 0) {
      uploadErrors.push(`Choose exactly one ${name} JSON file.`);
      continue;
    }
    try {
      const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
        .decode(await file.arrayBuffer());
      parseJsonValue(source); // Reject duplicate keys and excessive nesting before hashing.
      parsedFiles[name] = JSON.parse(source);
    } catch {
      uploadErrors.push(`The ${name} file is not valid JSON.`);
    }
  }
  const pythonFiles = form.getAll('sources');
  if (pythonFiles.length > MAX_DATASET_SOURCES) {
    uploadErrors.push(`Use at most ${MAX_DATASET_SOURCES} Python files.`);
  } else {
    const sources = new Map<string, Uint8Array>();
    for (const file of pythonFiles) {
      if (file instanceof File && file.name === '' && file.size === 0) continue;
      if (!(file instanceof File) || sources.has(file.name) || !/^[a-z0-9_-]+\.py$/.test(file.name)) {
        uploadErrors.push('Python files need unique, flat filenames ending in .py.');
        break;
      }
      sources.set(file.name, new Uint8Array(await file.arrayBuffer()));
    }
    if (sources.size > 0) parsedFiles.sources = sources;
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

async function applyDatasetAction(
  env: Env,
  session: SessionUser,
  revisionId: string,
  action: string,
  form: FormData,
): Promise<Response> {
  const now = new Date().toISOString();
  try {
    switch (action) {
      case 'sign-off':
        await recordDatasetSignoff(
          env.DB, revisionId, formString(form, 'caseKey'), session.id, formString(form, 'evidenceNote'), now,
        );
        return redirect(`/datasets/${revisionId}?notice=signed-off`);
      case 'runs': {
        const { runId } = await launchDatasetRun(
          env.DB, revisionId, formString(form, 'submissionId'), session.id, now,
        );
        await dispatchRun(env, runId);
        return redirect(`/runs/${runId}`);
      }
      case 'freeze':
        await freezeDataset(env.DB, revisionId, session.id, now);
        return redirect(`/datasets/${revisionId}?notice=frozen`);
      case 'release':
        await releaseDataset(env.DB, revisionId, session.id, formString(form, 'studyProtocolRef'), now);
        return redirect(`/datasets/${revisionId}?notice=released`);
      default:
        return notFoundPage(session);
    }
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
    if (error instanceof DatasetStateError) {
      return htmlResponse(
        datasetDetailPage(session, await getDatasetRevision(env.DB, revisionId), {
          notice: { kind: 'error', message: error.message },
        }),
        409,
      );
    }
    throw error;
  }
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
