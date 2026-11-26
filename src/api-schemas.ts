import { z } from 'zod';
import { createDocument } from 'zod-openapi';
import {
  COMPARISON_RULE,
  SCRIPT_COMPARISON_RULE,
  type RawConfig,
} from './config';
import { parseJsonValue } from './json';

const emailSchema = z.string().meta({
  description: 'Provisioned account email address.',
  example: 'researcher@example.edu',
});

const textInput = z.string().nullish();
const stableId = textInput.meta({
  description: 'Stable ID, unique within its list, using lowercase letters, digits, underscores, or hyphens.',
  example: 't1',
});
const criterionRequestSchema = z.object({
  id: stableId,
  description: textInput.meta({ example: 'Iteration order' }),
  expectedBehavior: textInput.meta({ example: 'Checks every item from index 0.' }),
}).transform((row) => ({
  id: row.id ?? '',
  description: row.description ?? '',
  expectedBehavior: row.expectedBehavior ?? '',
}));

const functionTestRequestSchema = z.object({
  id: stableId,
  arguments: z.unknown().optional().meta({
    description: 'JSON text for the positional argument array. Use this or argumentsJson.',
    example: '[[4, -1]]',
  }),
  expectedReturn: z.unknown().optional().meta({
    description: 'JSON text for the expected return value. Use this or expectedReturnJson.',
    example: '4',
  }),
  argumentsJson: textInput.meta({
    description: 'Lossless JSON text for the positional argument array; takes precedence over arguments.',
    example: '[[4,-1]]',
  }),
  expectedReturnJson: textInput.meta({
    description: 'Lossless JSON text for the expected return value; takes precedence over expectedReturn.',
    example: '4',
  }),
  stdin: z.unknown().optional(),
  expectedStdout: z.unknown().optional(),
}).superRefine((row, context) => {
  for (const field of ['arguments', 'expectedReturn'] as const) {
    if (row[`${field}Json`] === undefined && row[field] != null && typeof row[field] !== 'string') {
      context.addIssue({ code: 'custom', path: [field], message: 'Must be JSON text.' });
    }
  }
}).transform((row) => ({
  id: row.id ?? '',
  arguments: functionJsonText(row.argumentsJson, row.arguments),
  expectedReturn: functionJsonText(row.expectedReturnJson, row.expectedReturn),
  ...(Object.hasOwn(row, 'stdin') ? { stdin: '' } : {}),
  ...(Object.hasOwn(row, 'expectedStdout') ? { expectedStdout: '' } : {}),
})).meta({
  id: 'FunctionTestRequest',
  description: 'A function test. The JSON text fields preserve Python numeric kinds and duplicate-key detection.',
});

function functionJsonText(canonical: string | null | undefined, alias: unknown): string {
  if (canonical !== undefined) return canonical ?? '';
  return typeof alias === 'string' ? alias : '';
}

// Preserve the required string input in OpenAPI while allowing domain
// validation to report a missing or invalid field alongside other row errors.
const scriptTextInput = z.string().transform((text): string | undefined => text).catch(undefined);
const scriptTestRequestSchema = z.object({
  id: z.string().refine((id) => id.trim() !== '', 'Enter a stable test ID.').meta({
    description: 'Stable test ID, unique within the suite.',
    example: 'two-values',
  }),
  stdin: scriptTextInput.meta({
    description: 'Exact UTF-8 standard input, at most 16 KiB in encoded bytes. An explicit empty string is valid.',
    example: '1\n2\n',
  }),
  expectedStdout: scriptTextInput.meta({
    description: 'Exact expected UTF-8 standard output, at most 16 KiB in encoded bytes. An explicit empty string is valid.',
    example: '3\n',
  }),
}).passthrough().transform((row) => ({
  id: row.id,
  stdin: row.stdin,
  expectedStdout: row.expectedStdout,
  ...(Object.hasOwn(row, 'arguments') || Object.hasOwn(row, 'argumentsJson') ? { arguments: '' } : {}),
  ...(Object.hasOwn(row, 'expectedReturn') || Object.hasOwn(row, 'expectedReturnJson') ? { expectedReturn: '' } : {}),
})).meta({
  id: 'ScriptTestRequest',
  description: 'A script test. Standard input is supplied without trimming and closed at EOF.',
});

const configFields = {
  title: textInput.meta({ example: 'First positive value' }),
  description: textInput.meta({ example: 'Return the first positive integer, or None.' }),
  criteria: z.array(criterionRequestSchema).nullish().meta({ description: 'Ordered rubric criteria.' }),
};
const functionConfigRequestSchema = z.object({
  ...configFields,
  format: z.literal('function').optional(),
  entryPoint: textInput.meta({ description: 'The Python function name.', example: 'first_positive' }),
  tests: z.array(functionTestRequestSchema).nullish(),
});
const scriptConfigRequestSchema = z.object({
  ...configFields,
  format: z.literal('script'),
  entryPoint: textInput.meta({ description: 'Omit for scripts; there is no function entry point.' }),
  tests: z.array(scriptTestRequestSchema).prefault([]).meta({
    description: 'Supply at least one script test.',
  }),
});

const configRequestSchema = z.discriminatedUnion('format', [
  functionConfigRequestSchema, scriptConfigRequestSchema,
]).transform((config): RawConfig => ({
  title: config.title ?? '',
  description: config.description ?? '',
  format: config.format ?? 'function',
  entryPoint: config.entryPoint ?? '',
  criteria: config.criteria ?? [],
  tests: config.tests ?? [],
})).meta({
  id: 'Config',
  description: 'Each suite uses only the test fields for its format (default: function). Supply a rubric and a test suite with unique IDs, at most 100 rows each, and at most 1 MiB of saved configuration.',
});

const bareCreateRequestSchema = configRequestSchema.and(
  z.object({ config: z.never().optional() }),
);
export const createRequestSchema = z.union([
  z.object({ config: configRequestSchema }).transform(({ config }) => config),
  bareCreateRequestSchema,
]).meta({ id: 'CreateAssignmentRequest' });

export const reviseRequestSchema = z.object({
  baseVersionId: z.string().refine((id) => id.trim() !== '', 'baseVersionId is required.'),
}).and(createRequestSchema)
  .transform(({ baseVersionId, ...config }) => ({ baseVersionId, config }))
  .meta({ id: 'ReviseAssignmentRequest' });

const rubricCriterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  expectedBehavior: z.string(),
});

const functionTestResponseSchema = z.object({
  id: z.string(),
  argumentsJson: z.string().refine((text) => checkSavedJson(text, true)).meta({
    description: 'Lossless JSON text encoding a positional argument array.',
  }),
  expectedReturnJson: z.string().refine((text) => checkSavedJson(text, false)).meta({
    description: 'Lossless JSON text encoding the expected return value.',
  }),
  comparisonRule: z.literal(COMPARISON_RULE),
});

function checkSavedJson(text: string, arrayRequired: boolean): boolean {
  try {
    const value = parseJsonValue(text);
    return !arrayRequired || Array.isArray(value);
  } catch {
    return false;
  }
}

const scriptTestResponseSchema = z.object({
  id: z.string(),
  stdin: z.string(),
  expectedStdout: z.string(),
  comparisonRule: z.literal(SCRIPT_COMPARISON_RULE),
});

const versionBase = {
  id: z.string(),
  assignmentId: z.string(),
  versionNumber: z.number().int().nonnegative(),
  title: z.string(),
  description: z.string(),
  rubricVersionId: z.string(),
  testSuiteVersionId: z.string(),
  createdAt: z.string(),
  createdBy: z.object({ id: z.string(), email: z.string() }),
  rubric: z.object({
    versionId: z.string(),
    criteria: z.array(rubricCriterionSchema),
  }),
};

const functionVersionSchema = z.object({
  ...versionBase,
  format: z.literal('function'),
  entryPoint: z.string(),
  testSuite: z.object({
    versionId: z.string(),
    comparisonRule: z.literal(COMPARISON_RULE),
    tests: z.array(functionTestResponseSchema),
  }),
});

const scriptVersionSchema = z.object({
  ...versionBase,
  format: z.literal('script'),
  testSuite: z.object({
    versionId: z.string(),
    comparisonRule: z.literal(SCRIPT_COMPARISON_RULE),
    tests: z.array(scriptTestResponseSchema),
  }),
});

export const assignmentVersionSchema = z.discriminatedUnion('format', [
  functionVersionSchema,
  scriptVersionSchema,
]).meta({ id: 'AssignmentVersion' });
export type AssignmentVersionPayload = z.infer<typeof assignmentVersionSchema>;

export const versionResponseSchema = z.object({
  changed: z.boolean().optional(),
  version: assignmentVersionSchema,
}).meta({ id: 'VersionResponse' });

const assignmentSummarySchema = z.object({
  id: z.string(),
  activeVersionId: z.string(),
  versionNumber: z.number().int().nonnegative(),
  title: z.string(),
  format: z.enum(['function', 'script']),
  criteriaCount: z.number().int().nonnegative(),
  testsCount: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

export const assignmentsResponseSchema = z.object({
  assignments: z.array(assignmentSummarySchema),
}).meta({ id: 'AssignmentsResponse' });

const versionSummarySchema = z.object({
  id: z.string(),
  versionNumber: z.number().int().nonnegative(),
  title: z.string(),
  createdAt: z.string(),
  createdBy: z.object({ id: z.string(), email: z.string() }),
  isActive: z.boolean(),
});

export const versionsResponseSchema = z.object({
  versions: z.array(versionSummarySchema),
}).meta({ id: 'VersionsResponse' });

const sessionUserSchema = z.object({
  id: z.string(),
  email: emailSchema,
  role: z.enum(['researcher', 'member']),
});

export const sessionResponseSchema = z.union([
  z.object({ authenticated: z.literal(false) }),
  z.object({
    authenticated: z.literal(true),
    user: sessionUserSchema,
    csrfToken: z.string().meta({
      description: 'Send this value in the X-CSRF-Token header for authenticated writes.',
    }),
  }),
]).meta({ id: 'SessionResponse' });

const rowFieldErrorsSchema = z.record(z.string(), z.string());
const rowGroupErrorsSchema = z.object({
  message: z.string().optional(),
  rows: z.record(z.string(), rowFieldErrorsSchema),
});
const configErrorsSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  format: z.string().optional(),
  entryPoint: z.string().optional(),
  criteria: rowGroupErrorsSchema.optional(),
  tests: rowGroupErrorsSchema.optional(),
  form: z.string().optional(),
});

export const errorResponseSchema = z.object({
  error: z.enum([
    'forbidden',
    'internal_error',
    'invalid_csrf',
    'invalid_origin',
    'invalid_request',
    'method_not_allowed',
    'not_found',
    'stale_version',
    'unauthenticated',
  ]),
  message: z.string().optional(),
  currentVersionId: z.string().optional(),
}).meta({ id: 'ErrorResponse', description: 'A documented JSON API failure body.' });

export const validationErrorResponseSchema = z.object({
  error: z.literal('validation_failed'),
  errors: configErrorsSchema,
}).meta({ id: 'ValidationErrorResponse' });

export const badRequestResponseSchema = z.union([
  errorResponseSchema,
  validationErrorResponseSchema,
]);

const json = (schema: z.ZodTypeAny) => ({
  'application/json': { schema },
});

const csrfHeader = {
  in: 'header',
  name: 'X-CSRF-Token',
  required: true,
  description: 'Per-session CSRF token from GET /api/session.',
  schema: { type: 'string' },
} as const;

const assignmentIdPath = z.object({
  assignmentId: z.string().meta({ param: { description: 'Assignment ID.' } }),
});
const versionIdPath = z.object({
  assignmentId: z.string().meta({ param: { description: 'Assignment ID.' } }),
  versionId: z.string().meta({ param: { description: 'Exact assignment version ID.' } }),
});

const errorContent = {
  '400': { description: 'Invalid request or configuration.', content: json(badRequestResponseSchema) },
  '401': { description: 'Not signed in.', content: json(errorResponseSchema) },
  '403': { description: 'Signed in without researcher access, or CSRF/origin rejected.', content: json(errorResponseSchema) },
  '404': { description: 'Assignment or version not found.', content: json(errorResponseSchema) },
  '405': { description: 'Method not allowed.', content: json(errorResponseSchema) },
  '500': { description: 'Generic server error.', content: json(errorResponseSchema) },
};

export function openApiDocument(): object {
  return createDocument({
    openapi: '3.1.0',
    info: {
      title: 'Feedback Lab JSON API',
      version: '1.0.0',
      description: [
        'Researcher-only JSON API for versioned assignments and test evidence.',
        'Authentication uses the first-party session cookie. Send X-CSRF-Token and a matching Origin for writes.',
        'The Swagger page enables Try it out for GET operations only; write request examples are documentation.',
        'Function responses expose lossless argumentsJson and expectedReturnJson. The former decoded arguments and expectedReturn response fields were removed in issue #3.',
      ].join(' '),
    },
    security: [{ cookieAuth: [] }],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'fl_session',
          description: 'Session cookie set by POST /sign-in.',
        },
      },
    },
    paths: {
      '/api/session': {
        get: {
          summary: 'Read the current session and CSRF token',
          security: [],
          responses: {
            '200': {
              description: 'Signed-out or signed-in session.',
              content: json(sessionResponseSchema),
            },
            '500': errorContent['500'],
          },
        },
      },
      '/api/assignments': {
        get: {
          summary: 'List assignment summaries',
          responses: {
            '200': { description: 'Assignment library.', content: json(assignmentsResponseSchema) },
            ...errorContent,
          },
        },
        post: {
          summary: 'Create a function or script assignment',
          description: 'Send a wrapped {"config": ...} body or a bare config. Writes require the CSRF header and a matching Origin when supplied.',
          parameters: [csrfHeader],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: createRequestSchema,
                examples: {
                  function: {
                    summary: 'Function assignment',
                    value: {
                      config: {
                        title: 'First positive value',
                        description: 'Return the first positive integer, or None.',
                        format: 'function',
                        entryPoint: 'first_positive',
                        criteria: [{ id: 'r1', description: 'Iteration order', expectedBehavior: 'Checks every item.' }],
                        tests: [{ id: 't1', argumentsJson: '[[4,-1]]', expectedReturnJson: '4' }],
                      },
                    },
                  },
                  script: {
                    summary: 'Script assignment',
                    value: {
                      config: {
                        title: 'Add two numbers',
                        description: 'Print the sum of integers read from stdin.',
                        format: 'script',
                        criteria: [{ id: 'r1', description: 'Reads to EOF', expectedBehavior: 'Reads every line.' }],
                        tests: [{ id: 'two-values', stdin: '1\n2\n', expectedStdout: '3\n' }],
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Created and activated.', content: json(versionResponseSchema) },
            ...errorContent,
          },
        },
      },
      '/api/assignments/{assignmentId}': {
        get: {
          summary: 'Read the active assignment version',
          requestParams: { path: assignmentIdPath },
          responses: {
            '200': { description: 'Active version.', content: json(versionResponseSchema) },
            ...errorContent,
          },
        },
      },
      '/api/assignments/{assignmentId}/versions': {
        get: {
          summary: 'List saved versions newest first',
          requestParams: { path: assignmentIdPath },
          responses: {
            '200': { description: 'Version history.', content: json(versionsResponseSchema) },
            ...errorContent,
          },
        },
        post: {
          summary: 'Revise from an exact base version',
          requestParams: { path: assignmentIdPath },
          parameters: [csrfHeader],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: reviseRequestSchema,
                examples: {
                  function: {
                    summary: 'Function revision',
                    value: {
                      baseVersionId: 'assignment-version-uuid',
                      config: {
                        title: 'First positive value',
                        description: 'Return the first positive integer, or None.',
                        format: 'function',
                        entryPoint: 'first_positive',
                        criteria: [{ id: 'r1', description: 'Iteration order', expectedBehavior: 'Checks every item.' }],
                        tests: [{ id: 't1', arguments: '[[4,-1]]', expectedReturn: '5' }],
                      },
                    },
                  },
                  script: {
                    summary: 'Script revision or format switch',
                    value: {
                      baseVersionId: 'assignment-version-uuid',
                      config: {
                        title: 'Add two numbers',
                        description: 'Print the sum of integers read from stdin.',
                        format: 'script',
                        criteria: [{ id: 'r1', description: 'Reads to EOF', expectedBehavior: 'Reads every line.' }],
                        tests: [{ id: 'two-values', stdin: '1\r\n2\r\n', expectedStdout: '3' }],
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'New version activated.', content: json(versionResponseSchema) },
            '200': { description: 'No-op; the active version is unchanged.', content: json(versionResponseSchema) },
            '409': {
              description: 'Stale base version; no rows were written.',
              content: json(errorResponseSchema),
            },
            ...errorContent,
          },
        },
      },
      '/api/assignments/{assignmentId}/versions/{versionId}': {
        get: {
          summary: 'Read one exact version without falling back',
          requestParams: { path: versionIdPath },
          responses: {
            '200': { description: 'Exact immutable version.', content: json(versionResponseSchema) },
            ...errorContent,
          },
        },
      },
    },
  });
}
