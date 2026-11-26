import {
  errorResponseSchema,
  studyCasesResponseSchema,
  studyEvidenceResponseSchema,
  studyScoringResponseSchema,
} from './api-schemas';
import {
  DatasetNotFoundError,
  getScoringRead,
  getStudyEvidence,
  listStudyCases,
  type StudyUse,
} from './dataset-repository';
import { requireResearcher } from './guard';
import { methodNotAllowed } from './http';
import { validatedJsonResponse } from './validated-response';

const CASES_PATH = /^\/api\/datasets\/([^/]+)\/study\/cases$/;
const EVIDENCE_PATH = /^\/api\/datasets\/([^/]+)\/study\/evidence\/([^/]+)$/;
const SCORING_PATH = /^\/api\/datasets\/([^/]+)\/study\/scoring\/([^/]+)$/;

export async function handleDatasetsApi(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (!path.startsWith('/api/datasets')) return null;
  const guarded = await requireResearcher(request, env, 'api');
  if (!guarded.ok) return guarded.response;
  if (request.method !== 'GET') {
    return methodNotAllowed('GET');
  }

  const url = new URL(request.url);
  const use = useParam(url.searchParams.get('use'));
  if (use === null) {
    return validatedJsonResponse(
      errorResponseSchema,
      { error: 'invalid_request', message: 'use must be pilot or main.' },
      400,
    );
  }

  try {
    const casesMatch = CASES_PATH.exec(path);
    if (casesMatch !== null) {
      const revisionId = casesMatch[1] as string;
      return validatedJsonResponse(studyCasesResponseSchema, {
        revisionId,
        use,
        cases: await listStudyCases(env.DB, revisionId, use),
      });
    }

    const evidenceMatch = EVIDENCE_PATH.exec(path);
    if (evidenceMatch !== null) {
      return validatedJsonResponse(studyEvidenceResponseSchema, {
        use,
        evidence: await getStudyEvidence(
          env.DB,
          evidenceMatch[1] as string,
          use,
          evidenceMatch[2] as string,
        ),
      });
    }

    const scoringMatch = SCORING_PATH.exec(path);
    if (scoringMatch !== null) {
      return validatedJsonResponse(studyScoringResponseSchema, {
        use,
        scoring: await getScoringRead(
          env.DB,
          scoringMatch[1] as string,
          use,
          scoringMatch[2] as string,
        ),
      });
    }
  } catch (error) {
    if (error instanceof DatasetNotFoundError) {
      return validatedJsonResponse(errorResponseSchema, { error: 'not_found' }, 404);
    }
    throw error;
  }

  return validatedJsonResponse(errorResponseSchema, { error: 'not_found' }, 404);
}

function useParam(value: string | null): StudyUse | null {
  return value === 'pilot' || value === 'main' ? value : null;
}
