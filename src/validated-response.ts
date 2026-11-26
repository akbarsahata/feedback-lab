import type { z } from 'zod';
import { jsonResponse } from './http';

/**
 * Sends a JSON API payload only after its shared Zod schema accepts it. A
 * failed validation must not leak the rejected payload or credentials.
 */
export function validatedJsonResponse(
  schema: z.ZodTypeAny,
  value: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    console.error('Outgoing JSON API response failed schema validation.');
    return jsonResponse({ error: 'internal_error' }, 500);
  }
  return jsonResponse(parsed.data, status, extraHeaders);
}
