import {
  authenticatedPostError,
  type SessionUser,
} from './auth';
import { validateConfig, type RawConfig } from './config';
import { parseAssignmentForm } from './forms';
import { formatJsonForDisplay, parseJsonValue } from './json';
import { requireResearcher } from './guard';
import { escapeHtml, messagePage, shell } from './html';
import { htmlResponse, methodNotAllowed, redirect } from './http';
import {
  assignmentDetailPage,
  assignmentFormPage,
  historyPage,
  libraryPage,
} from './pages';
import {
  AssignmentNotFoundError,
  createAssignment,
  getActiveVersion,
  getVersion,
  listAssignments,
  listVersions,
  reviseAssignment,
  StaleVersionError,
  type AssignmentVersionDetail,
} from './repository';

const ASSIGNMENT_PATH = /^\/assignments\/([^/]+)$/;
const EDIT_PATH = /^\/assignments\/([^/]+)\/edit$/;
const HISTORY_PATH = /^\/assignments\/([^/]+)\/history$/;
const VERSION_PATH = /^\/assignments\/([^/]+)\/versions\/([^/]+)$/;

export async function handleAssignmentsHtml(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path !== '/assignments' && !path.startsWith('/assignments/')) {
    return null;
  }

  const guarded = await requireResearcher(request, env, 'html');
  if (!guarded.ok) {
    return guarded.response;
  }
  try {
    return await routeAssignmentsHtml(request, env, path, guarded.session);
  } catch (error) {
    if (error instanceof AssignmentNotFoundError) return notFoundPage(guarded.session);
    throw error;
  }
}

async function routeAssignmentsHtml(
  request: Request,
  env: Env,
  path: string,
  session: SessionUser,
): Promise<Response> {
  if (path === '/assignments') {
    if (request.method === 'GET') {
      const assignments = await listAssignments(env.DB);
      return htmlResponse(libraryPage(session, assignments));
    }
    if (request.method === 'POST') {
      return createAssignmentForm(request, env, session);
    }
    return methodNotAllowed('GET, POST');
  }

  if (path === '/assignments/new') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    return htmlResponse(
      assignmentFormPage({
        user: session,
        mode: 'create',
        raw: emptyConfig(),
      }),
    );
  }

  const versionMatch = VERSION_PATH.exec(path);
  if (versionMatch !== null) {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    const assignmentId = versionMatch[1] as string;
    const versionId = versionMatch[2] as string;
    const [version, active] = await Promise.all([
      getVersion(env.DB, assignmentId, versionId),
      getActiveVersion(env.DB, assignmentId),
    ]);
    return htmlResponse(assignmentDetailPage({
      user: session,
      version,
      isActive: version.id === active.id,
    }));
  }

  const editMatch = EDIT_PATH.exec(path);
  if (editMatch !== null) {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    const assignmentId = editMatch[1] as string;
    const active = await getActiveVersion(env.DB, assignmentId);
    const sourceVersionId = new URL(request.url).searchParams.get('version');
    if (sourceVersionId !== null && sourceVersionId !== active.id) {
      return htmlResponse(shell({
        title: 'A newer version is active',
        user: session,
        body: `<div class="alert alert-warn" role="alert">
  A newer version of this assignment is now active. The editor has not been opened.
  <a href="/assignments/${escapeHtml(assignmentId)}/edit">Open the active version to edit</a>.
</div>`,
      }), 409);
    }
    return htmlResponse(assignmentFormPage({
      user: session,
      mode: 'edit',
      assignmentId,
      baseVersionId: active.id,
      raw: rawFromVersion(active),
    }));
  }

  const historyMatch = HISTORY_PATH.exec(path);
  if (historyMatch !== null) {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    const assignmentId = historyMatch[1] as string;
    return htmlResponse(historyPage(session, assignmentId, await listVersions(env.DB, assignmentId)));
  }

  const assignmentMatch = ASSIGNMENT_PATH.exec(path);
  if (assignmentMatch !== null) {
    const assignmentId = assignmentMatch[1] as string;
    if (request.method === 'GET') {
      const active = await getActiveVersion(env.DB, assignmentId);
      const notice =
        new URL(request.url).searchParams.get('notice') === 'unchanged'
          ? 'No changes to save; the active version is unchanged.'
          : undefined;
      return htmlResponse(assignmentDetailPage({ user: session, version: active, notice }));
    }
    if (request.method === 'POST') {
      return reviseAssignmentForm(request, env, session, assignmentId);
    }
    return methodNotAllowed('GET, POST');
  }

  return notFoundPage(session);
}

async function createAssignmentForm(
  request: Request,
  env: Env,
  session: SessionUser,
): Promise<Response> {
  const parsed = parseAssignmentForm(await request.formData());
  if (authenticatedPostError(request, session, parsed.csrfToken) !== null) {
    return blockedPage(session);
  }

  const validation = validateConfig(parsed.raw);
  if (!validation.ok) {
    return htmlResponse(
      assignmentFormPage({
        user: session,
        mode: 'create',
        raw: parsed.raw,
        errors: validation.errors,
      }),
      422,
    );
  }

  const version = await createAssignment(env.DB, validation.config, session.id);
  return redirect(`/assignments/${version.assignmentId}`);
}

async function reviseAssignmentForm(
  request: Request,
  env: Env,
  session: SessionUser,
  assignmentId: string,
): Promise<Response> {
  const parsed = parseAssignmentForm(await request.formData());
  if (authenticatedPostError(request, session, parsed.csrfToken) !== null) {
    return blockedPage(session);
  }

  const baseVersionId = parsed.baseVersionId.trim() || undefined;
  const validation = validateConfig(parsed.raw);
  if (!validation.ok || baseVersionId === undefined) {
    await getActiveVersion(env.DB, assignmentId); // Preserve 404 for an unknown assignment.
    return htmlResponse(
      assignmentFormPage({
        user: session,
        mode: 'edit',
        assignmentId,
        baseVersionId,
        raw: parsed.raw,
        errors: validation.ok ? undefined : validation.errors,
      }),
      422,
    );
  }

  try {
    const result = await reviseAssignment(
      env.DB,
      assignmentId,
      baseVersionId,
      validation.config,
      session.id,
    );
    return result.changed
      ? redirect(`/assignments/${assignmentId}`)
      : redirect(`/assignments/${assignmentId}?notice=unchanged`);
  } catch (error) {
    if (error instanceof StaleVersionError) {
      return htmlResponse(
        assignmentFormPage({
          user: session,
          mode: 'edit',
          assignmentId,
          baseVersionId,
          raw: parsed.raw,
          conflict: true,
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
      title: 'Page not found',
      message: 'That assignment page does not exist.',
      user: session,
    }),
    404,
  );
}

function rawFromVersion(version: AssignmentVersionDetail): RawConfig {
  return {
    title: version.title,
    description: version.description,
    entryPoint: version.entryPoint,
    criteria: version.criteria,
    tests: version.tests.map((test) => ({
      id: test.id,
      arguments: formatJsonForDisplay(parseJsonValue(test.argumentsJson)),
      expectedReturn: formatJsonForDisplay(parseJsonValue(test.expectedReturnJson)),
    })),
  };
}

function emptyConfig(): RawConfig {
  return {
    title: '',
    description: '',
    entryPoint: '',
    criteria: [],
    tests: [],
  };
}
