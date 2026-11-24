import { canonicalizeJson, JsonParseError, parseJsonValue } from './json';

export const COMPARISON_RULE = 'function-value-v1';

export const LIMITS = {
  title: 200,
  description: 10_000,
  entryPoint: 128,
  itemId: 64,
  itemText: 2_000,
  jsonText: 10_000,
  rows: 100,
} as const;

export interface RawCriterion {
  id: string;
  description: string;
  expectedBehavior: string;
}

export interface RawTest {
  id: string;
  arguments: string;
  expectedReturn: string;
}

export interface RawConfig {
  title: string;
  description: string;
  entryPoint: string;
  criteria: RawCriterion[];
  tests: RawTest[];
}

export interface Criterion {
  id: string;
  description: string;
  expectedBehavior: string;
}

export interface TestCase {
  id: string;
  argumentsJson: string;
  expectedReturnJson: string;
  comparisonRule: typeof COMPARISON_RULE;
}

export interface ValidatedConfig {
  title: string;
  description: string;
  entryPoint: string;
  criteria: Criterion[];
  tests: TestCase[];
}

export type RowFieldErrors = Record<string, string>;

export interface RowGroupErrors {
  message?: string;
  rows: Record<number, RowFieldErrors>;
}

export interface ConfigErrors {
  title?: string;
  description?: string;
  entryPoint?: string;
  criteria?: RowGroupErrors;
  tests?: RowGroupErrors;
  form?: string;
}

export type ConfigValidation =
  | { ok: true; config: ValidatedConfig }
  | { ok: false; errors: ConfigErrors };

export interface ConfigChanges {
  metadata: boolean;
  rubric: boolean;
  tests: boolean;
}

const PYTHON_KEYWORDS = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

const ID_PATTERN = /^[a-z0-9_-]+$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateConfig(raw: RawConfig): ConfigValidation {
  const errors: ConfigErrors = {};
  const title = raw.title.trim();
  const description = raw.description.trim();
  const entryPoint = raw.entryPoint.trim();

  if (title === '') {
    errors.title = 'Enter a title.';
  } else if (title.length > LIMITS.title) {
    errors.title = `Use ${LIMITS.title} characters or fewer for the title.`;
  }

  if (description === '') {
    errors.description = 'Enter a task description.';
  } else if (description.length > LIMITS.description) {
    errors.description = `Use ${LIMITS.description} characters or fewer for the task description.`;
  }

  if (entryPoint === '') {
    errors.entryPoint = 'Enter the function name the tests should call.';
  } else if (entryPoint.length > LIMITS.entryPoint) {
    errors.entryPoint = `Use ${LIMITS.entryPoint} characters or fewer for the entry point.`;
  } else if (!IDENTIFIER_PATTERN.test(entryPoint)) {
    errors.entryPoint =
      'Use a Python identifier such as first_positive (letters, digits, and underscores, not starting with a digit). Enter a function name only.';
  } else if (PYTHON_KEYWORDS.has(entryPoint)) {
    errors.entryPoint = `"${entryPoint}" is a Python keyword. Choose a different function name.`;
  }

  const criteria = validateCriteria(raw.criteria, errors);
  const tests = validateTests(raw.tests, errors);

  if (hasErrors(errors)) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: {
      title,
      description,
      entryPoint,
      criteria,
      tests,
    },
  };
}

function validateCriteria(rawRows: RawCriterion[], errors: ConfigErrors): Criterion[] {
  const rows = rawRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !isBlank(row.id) || !isBlank(row.description) || !isBlank(row.expectedBehavior));

  const group: RowGroupErrors = { rows: {} };
  const criteria: Criterion[] = [];
  const seen = new Map<string, number>();

  if (rows.length === 0) {
    group.message = 'Add at least one rubric criterion.';
  } else if (rows.length > LIMITS.rows) {
    group.message = `Use ${LIMITS.rows} rubric criteria or fewer.`;
  } else {
    for (const { row, index } of rows) {
      const rowErrors: RowFieldErrors = {};
      const id = row.id.trim();
      const description = row.description.trim();
      const expectedBehavior = row.expectedBehavior.trim();

      validateItemId(id, seen, 'rubric', index, rowErrors);
      if (description === '') {
        rowErrors.description = 'Enter a description for this criterion.';
      } else if (description.length > LIMITS.itemText) {
        rowErrors.description = `Use ${LIMITS.itemText} characters or fewer.`;
      }
      if (expectedBehavior === '') {
        rowErrors.expectedBehavior = 'Enter the expected behavior for this criterion.';
      } else if (expectedBehavior.length > LIMITS.itemText) {
        rowErrors.expectedBehavior = `Use ${LIMITS.itemText} characters or fewer.`;
      }

      if (Object.keys(rowErrors).length > 0) {
        group.rows[index] = rowErrors;
      } else {
        criteria.push({ id, description, expectedBehavior });
      }
    }
  }

  if (group.message !== undefined || Object.keys(group.rows).length > 0) {
    errors.criteria = group;
  }
  return criteria;
}

function validateTests(rawRows: RawTest[], errors: ConfigErrors): TestCase[] {
  const rows = rawRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !isBlank(row.id) || !isBlank(row.arguments) || !isBlank(row.expectedReturn));

  const group: RowGroupErrors = { rows: {} };
  const tests: TestCase[] = [];
  const seen = new Map<string, number>();

  if (rows.length === 0) {
    group.message = 'Add at least one test.';
  } else if (rows.length > LIMITS.rows) {
    group.message = `Use ${LIMITS.rows} tests or fewer.`;
  } else {
    for (const { row, index } of rows) {
      const rowErrors: RowFieldErrors = {};
      const id = row.id.trim();
      const argumentsText = row.arguments.trim();
      const expectedText = row.expectedReturn.trim();

      validateItemId(id, seen, 'test suite', index, rowErrors);

      if (argumentsText === '') {
        rowErrors.arguments =
          'Enter arguments as a JSON array, for example [] or [[4, -1]].';
      } else if (argumentsText.length > LIMITS.jsonText) {
        rowErrors.arguments = `Use ${LIMITS.jsonText} characters or fewer.`;
      } else {
        try {
          const parsed = parseJsonValue(argumentsText);
          if (!Array.isArray(parsed)) {
            rowErrors.arguments =
              'Arguments must be a JSON array. Use [] for no arguments, [4, -1] for two arguments, or [[4, -1]] for one list argument.';
          }
        } catch (error) {
          if (!(error instanceof JsonParseError)) throw error;
          rowErrors.arguments = `${error.message}. Enter arguments as a JSON array, for example [] or [[4, -1]].`;
        }
      }

      if (expectedText === '') {
        rowErrors.expectedReturn =
          'Enter an expected return value. Use null for Python None.';
      } else if (expectedText.length > LIMITS.jsonText) {
        rowErrors.expectedReturn = `Use ${LIMITS.jsonText} characters or fewer.`;
      } else {
        try {
          parseJsonValue(expectedText);
        } catch (error) {
          if (!(error instanceof JsonParseError)) throw error;
          rowErrors.expectedReturn = `${error.message}. Enter one JSON value; use null for Python None.`;
        }
      }

      if (Object.keys(rowErrors).length > 0) {
        group.rows[index] = rowErrors;
      } else {
        tests.push({
          id,
          argumentsJson: canonicalizeJson(parseJsonValue(argumentsText)),
          expectedReturnJson: canonicalizeJson(parseJsonValue(expectedText)),
          comparisonRule: COMPARISON_RULE,
        });
      }
    }
  }

  if (group.message !== undefined || Object.keys(group.rows).length > 0) {
    errors.tests = group;
  }
  return tests;
}

function validateItemId(
  id: string,
  seen: Map<string, number>,
  listName: string,
  rowIndex: number,
  rowErrors: RowFieldErrors,
): void {
  if (id === '') {
    rowErrors.id = 'Enter an ID.';
    return;
  }
  if (id.length > LIMITS.itemId || !ID_PATTERN.test(id)) {
    rowErrors.id = `Use 1–${LIMITS.itemId} lowercase letters, digits, hyphens, or underscores.`;
    return;
  }
  const previous = seen.get(id);
  if (previous !== undefined) {
    rowErrors.id = `ID "${id}" is already used in this ${listName} (row ${previous + 1}). Use a unique ID.`;
    return;
  }
  seen.set(id, rowIndex);
}

function isBlank(value: string): boolean {
  return value.trim() === '';
}

function hasErrors(errors: ConfigErrors): boolean {
  return (
    errors.title !== undefined ||
    errors.description !== undefined ||
    errors.entryPoint !== undefined ||
    errors.criteria !== undefined ||
    errors.tests !== undefined ||
    errors.form !== undefined
  );
}

export function compareConfigs(a: ValidatedConfig, b: ValidatedConfig): ConfigChanges {
  return {
    metadata:
      a.title !== b.title ||
      a.description !== b.description ||
      a.entryPoint !== b.entryPoint,
    rubric: !criteriaEqual(a.criteria, b.criteria),
    tests: !testsEqual(a.tests, b.tests),
  };
}

export function isChanged(changes: ConfigChanges): boolean {
  return changes.metadata || changes.rubric || changes.tests;
}

function criteriaEqual(a: Criterion[], b: Criterion[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (criterion, index) =>
        criterion.id === b[index]?.id &&
        criterion.description === b[index]?.description &&
        criterion.expectedBehavior === b[index]?.expectedBehavior,
    )
  );
}

function testsEqual(a: TestCase[], b: TestCase[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (test, index) =>
        test.id === b[index]?.id &&
        test.argumentsJson === b[index]?.argumentsJson &&
        test.expectedReturnJson === b[index]?.expectedReturnJson,
    )
  );
}
