import { canonicalizeJson, JsonParseError, parseJsonValue } from './json';

export const COMPARISON_RULE = 'function-value-v1';
export const SCRIPT_COMPARISON_RULE = 'script-stdout-v1';
export const MAX_ROWS_PER_LIST = 100;
export const MAX_CONFIG_MIB = 1;
export const MAX_SCRIPT_FIELD_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type AssignmentFormat = 'function' | 'script';
export type ComparisonRule = typeof COMPARISON_RULE | typeof SCRIPT_COMPARISON_RULE;

export interface RawCriterion {
  id: string;
  description: string;
  expectedBehavior: string;
}

// A draft can contain fields from both formats so validation can report the
// offending fields. A saved TestCase always uses one comparison rule.
export interface RawTest {
  id: string;
  arguments?: string;
  expectedReturn?: string;
  stdin?: string;
  expectedStdout?: string;
}

export interface RawConfig {
  title: string;
  description: string;
  format?: AssignmentFormat;
  entryPoint?: string;
  criteria: RawCriterion[];
  tests: RawTest[];
}

export interface FunctionTestCase {
  id: string;
  argumentsJson: string;
  expectedReturnJson: string;
  comparisonRule: typeof COMPARISON_RULE;
}

export interface ScriptTestCase {
  id: string;
  stdin: string;
  expectedStdout: string;
  comparisonRule: typeof SCRIPT_COMPARISON_RULE;
}

export type TestCase = FunctionTestCase | ScriptTestCase;

interface ValidatedConfigBase {
  title: string;
  description: string;
  criteria: RawCriterion[];
}

export type FunctionConfig = ValidatedConfigBase & {
  format: 'function';
  entryPoint: string;
  tests: FunctionTestCase[];
};

export type ScriptConfig = ValidatedConfigBase & {
  format: 'script';
  tests: ScriptTestCase[];
};

export type ValidatedConfig = FunctionConfig | ScriptConfig;

export type RowFieldErrors = Record<string, string>;

export interface RowGroupErrors {
  message?: string;
  rows: Record<number, RowFieldErrors>;
}

export interface ConfigErrors {
  title?: string;
  description?: string;
  format?: string;
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
  const format = raw.format ?? 'function';

  if (format !== 'function' && format !== 'script') {
    errors.format = 'Choose Function or Script.';
    return { ok: false, errors };
  }

  if (title === '') {
    errors.title = 'Enter a title.';
  }

  if (description === '') {
    errors.description = 'Enter a task description.';
  }

  const enteredName = (raw.entryPoint ?? '').trim();
  const entryPoint = enteredName.normalize('NFKC');

  if (format === 'function') {
    if (enteredName === '') {
      errors.entryPoint = 'Enter the function name the tests should call.';
    } else if (!isPythonIdentifier(enteredName)) {
      errors.entryPoint =
        'Use a Python identifier such as first_positive (letters, digits, and underscores, not starting with a digit). Enter a function name only.';
    } else if (PYTHON_KEYWORDS.has(entryPoint)) {
      errors.entryPoint = `"${entryPoint}" is a Python keyword. Choose a different function name.`;
    }
  } else if (enteredName !== '') {
    errors.entryPoint =
      'Script assignments do not have an entry point. Remove the function name or choose the Function format.';
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
  const base = { title, description, criteria };
  const config: ValidatedConfig = format === 'function'
    ? {
        ...base,
        format,
        entryPoint,
        tests: validateRows(raw.tests, errors, 'tests', validateFunctionTest, hasScriptFields),
      }
    : {
        ...base,
        format,
        tests: validateRows(raw.tests, errors, 'tests', validateScriptTest, hasFunctionFields),
      };

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const bytes = [
    title,
    description,
    ...(format === 'function' ? [entryPoint] : []),
    ...criteria.flatMap((row) => [row.id, row.description, row.expectedBehavior]),
    ...config.tests.flatMap(testText),
  ].reduce((size, text) => size + encoder.encode(text).byteLength, 0);
  if (bytes > MAX_CONFIG_MIB * 1024 * 1024) {
    return {
      ok: false,
      errors: { form: `The saved configuration exceeds ${MAX_CONFIG_MIB} MiB. Shorten the text or use smaller JSON values and try again.` },
    };
  }

  return { ok: true, config };
}

function testText(test: TestCase): string[] {
  return test.comparisonRule === COMPARISON_RULE
    ? [test.id, test.argumentsJson, test.expectedReturnJson]
    : [test.id, test.stdin, test.expectedStdout];
}

function validateFunctionTest(
  row: RawTest,
  id: string,
  rowErrors: RowFieldErrors,
): FunctionTestCase {
  if (row.stdin !== undefined) {
    rowErrors.stdin = 'Standard input belongs to a Script assignment. Remove it or choose the Script format.';
  }
  if (row.expectedStdout !== undefined) {
    rowErrors.expectedStdout = 'Expected stdout belongs to a Script assignment. Remove it or choose the Script format.';
  }
  return {
    id,
    argumentsJson: validateTestJson(row.arguments ?? '', 'arguments', rowErrors),
    expectedReturnJson: validateTestJson(row.expectedReturn ?? '', 'expectedReturn', rowErrors),
    comparisonRule: COMPARISON_RULE,
  };
}

function validateScriptTest(
  row: RawTest,
  id: string,
  rowErrors: RowFieldErrors,
): ScriptTestCase {
  if (row.arguments !== undefined) {
    rowErrors.arguments = 'Positional arguments belong to a Function assignment. Remove them or choose the Function format.';
  }
  if (row.expectedReturn !== undefined) {
    rowErrors.expectedReturn = 'Expected return belongs to a Function assignment. Remove it or choose the Function format.';
  }
  return {
    id,
    stdin: validateScriptText(row.stdin, 'stdin', rowErrors),
    expectedStdout: validateScriptText(row.expectedStdout, 'expectedStdout', rowErrors),
    comparisonRule: SCRIPT_COMPARISON_RULE,
  };
}

type ScriptTextField = 'stdin' | 'expectedStdout';

function validateScriptText(
  value: string | undefined,
  field: ScriptTextField,
  rowErrors: RowFieldErrors,
): string {
  const label = field === 'stdin' ? 'Standard input' : 'Expected stdout';
  if (value === undefined) {
    rowErrors[field] = `${label} must be a string. Use an empty string when blank.`;
    return '';
  }
  if (!roundTripsAsUtf8(value)) {
    rowErrors[field] = `${label} must be valid UTF-8 text.`;
    return value;
  }
  const size = encoder.encode(value).byteLength;
  if (size > MAX_SCRIPT_FIELD_BYTES) {
    rowErrors[field] =
      `${label} exceeds ${MAX_SCRIPT_FIELD_BYTES / 1024} KiB (${size} bytes). Shorten it and try again.`;
  }
  return value;
}

function roundTripsAsUtf8(value: string): boolean {
  try {
    return decoder.decode(encoder.encode(value)) === value;
  } catch {
    return false;
  }
}

function hasScriptFields(row: RawTest): boolean {
  return row.stdin !== undefined || row.expectedStdout !== undefined;
}

function hasFunctionFields(row: RawTest): boolean {
  return row.arguments !== undefined || row.expectedReturn !== undefined;
}

function validateRows<RawRow extends { id: string }, SavedRow>(
  rawRows: RawRow[],
  errors: ConfigErrors,
  key: 'criteria' | 'tests',
  validateFields: (row: RawRow, id: string, rowErrors: RowFieldErrors) => SavedRow,
  hasWrongFormatFields?: (row: RawRow) => boolean,
): SavedRow[] {
  const isRubric = key === 'criteria';
  const rows = rawRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => hasWrongFormatFields?.(row) || Object.values(row).some(
      (value) => typeof value === 'string' && value.trim() !== '',
    ));

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
  if (a.format !== b.format) {
    return {
      metadata: true,
      rubric: !criteriaEqual(a.criteria, b.criteria),
      tests: true,
    };
  }
  const metadata =
    a.title !== b.title ||
    a.description !== b.description ||
    (a.format === 'function' && b.format === 'function' && a.entryPoint !== b.entryPoint);
  return {
    metadata,
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
    a.every((test, index) => {
      const other = b[index];
      if (other === undefined || test.id !== other.id) return false;
      if (test.comparisonRule !== other.comparisonRule) return false;
      if (test.comparisonRule === COMPARISON_RULE && other.comparisonRule === COMPARISON_RULE) {
        return (
          test.argumentsJson === other.argumentsJson &&
          test.expectedReturnJson === other.expectedReturnJson
        );
      }
      if (
        test.comparisonRule === SCRIPT_COMPARISON_RULE &&
        other.comparisonRule === SCRIPT_COMPARISON_RULE
      ) {
        return test.stdin === other.stdin && test.expectedStdout === other.expectedStdout;
      }
      return false;
    })
  );
}
