import { canonicalizeJson, JsonParseError, parseJsonValue } from './json';

export const COMPARISON_RULE = 'function-value-v1';

export const MAX_ROWS_PER_LIST = 100;
export const MAX_CONFIG_MIB = 1;
const encoder = new TextEncoder();

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
  criteria: RawCriterion[];
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
const IDENTIFIER_PATTERN = /^[_\p{ID_Start}]\p{ID_Continue}*$/u;
const CONTINUATION_PATTERN = /^\p{ID_Continue}+$/u;
const JOIN_CONTROL = /[\u200c\u200d]/u;

function isPythonIdentifier(value: string): boolean {
  if (!IDENTIFIER_PATTERN.test(value) || JOIN_CONTROL.test(value)) return false;
  // Python's XID rules require each character's NFKC expansion to stay
  // within the appropriate identifier class, not just the whole name.
  let pattern = IDENTIFIER_PATTERN;
  for (const character of value) {
    if (!pattern.test(character.normalize('NFKC'))) return false;
    pattern = CONTINUATION_PATTERN;
  }
  return true;
}

export function validateConfig(raw: RawConfig): ConfigValidation {
  const errors: ConfigErrors = {};
  const title = configText(raw.title);
  const description = configText(raw.description);
  const enteredName = raw.entryPoint.trim();
  const entryPoint = enteredName.normalize('NFKC');

  if (title === '') {
    errors.title = 'Enter a title.';
  }

  if (description === '') {
    errors.description = 'Enter a task description.';
  }

  if (enteredName === '') {
    errors.entryPoint = 'Enter the function name the tests should call.';
  } else if (!isPythonIdentifier(enteredName)) {
    errors.entryPoint =
      'Use a Python identifier such as first_positive (letters, digits, and underscores, not starting with a digit). Enter a function name only.';
  } else if (PYTHON_KEYWORDS.has(entryPoint)) {
    errors.entryPoint = `"${entryPoint}" is a Python keyword. Choose a different function name.`;
  }

  const criteria = validateRows(
    raw.criteria, errors, 'criteria',
    (row, id, rowErrors) => {
      const description = configText(row.description);
      const expectedBehavior = configText(row.expectedBehavior);
      if (description === '') rowErrors.description = 'Enter a description for this criterion.';
      if (expectedBehavior === '') rowErrors.expectedBehavior = 'Enter the expected behavior for this criterion.';
      return { id, description, expectedBehavior };
    },
  );
  const tests = validateRows(
    raw.tests, errors, 'tests',
    (row, id, rowErrors): TestCase => ({
      id,
      argumentsJson: validateTestJson(row.arguments, 'arguments', rowErrors),
      expectedReturnJson: validateTestJson(row.expectedReturn, 'expectedReturn', rowErrors),
      comparisonRule: COMPARISON_RULE,
    }),
  );

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const bytes = [title, description, entryPoint,
    ...criteria.flatMap((row) => [row.id, row.description, row.expectedBehavior]),
    ...tests.flatMap((row) => [row.id, row.argumentsJson, row.expectedReturnJson]),
  ].reduce((size, text) => size + encoder.encode(text).byteLength, 0);
  if (bytes > MAX_CONFIG_MIB * 1024 * 1024) {
    return {
      ok: false,
      errors: { form: `The saved configuration exceeds ${MAX_CONFIG_MIB} MiB. Shorten the text or use smaller JSON values and try again.` },
    };
  }

  return { ok: true, config: { title, description, entryPoint, criteria, tests } };
}

function validateRows<RawRow extends { id: string }, SavedRow>(
  rawRows: RawRow[],
  errors: ConfigErrors,
  key: 'criteria' | 'tests',
  validateFields: (row: RawRow, id: string, rowErrors: RowFieldErrors) => SavedRow,
): SavedRow[] {
  const isRubric = key === 'criteria';
  const rows = rawRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => Object.values(row).some((value) => value.trim() !== ''));

  const group: RowGroupErrors = { rows: {} };
  const saved: SavedRow[] = [];
  const seen = new Map<string, number>();

  if (rows.length === 0) {
    group.message = `Add at least one ${isRubric ? 'rubric criterion' : 'test'}.`;
  } else if (rows.length > MAX_ROWS_PER_LIST) {
    group.message = `Use ${MAX_ROWS_PER_LIST} ${isRubric ? 'rubric criteria' : 'tests'} or fewer. Remove some rows and try again.`;
  } else {
    for (const { row, index } of rows) {
      const rowErrors: RowFieldErrors = {};
      const id = row.id.trim();
      validateItemId(id, seen, isRubric ? 'rubric' : 'test suite', index, rowErrors);
      const item = validateFields(row, id, rowErrors);
      if (Object.keys(rowErrors).length > 0) {
        group.rows[index] = rowErrors;
      } else {
        saved.push(item);
      }
    }
  }

  if (group.message !== undefined || Object.keys(group.rows).length > 0) {
    errors[key] = group;
  }
  return saved;
}

function validateTestJson(
  text: string,
  field: 'arguments' | 'expectedReturn',
  errors: RowFieldErrors,
): string {
  const help = field === 'arguments'
    ? 'Enter arguments as a JSON array, for example [] or [[4, -1]].'
    : 'Enter an expected return value as JSON. Use null for Python None.';
  if (text.trim() === '') {
    errors[field] = help;
    return '';
  }
  try {
    const value = parseJsonValue(text);
    if (field !== 'arguments' || Array.isArray(value)) return canonicalizeJson(value);
    errors[field] = `Arguments must be a JSON array. ${help}`;
  } catch (error) {
    if (!(error instanceof JsonParseError)) throw error;
    errors[field] = `${error.message}. ${help}`;
  }
  return '';
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
  if (!ID_PATTERN.test(id)) {
    rowErrors.id = 'Use only lowercase letters, digits, hyphens, or underscores.';
    return;
  }
  const previous = seen.get(id);
  if (previous !== undefined) {
    rowErrors.id = `ID "${id}" is already used in this ${listName} (row ${previous + 1}). Use a unique ID.`;
    return;
  }
  seen.set(id, rowIndex);
}

function configText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
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

function criteriaEqual(a: RawCriterion[], b: RawCriterion[]): boolean {
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
