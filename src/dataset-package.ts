import {
  validateConfig,
  type AssignmentFormat,
  type RawConfig,
  type RawTest,
  type ValidatedConfig,
} from './config';
import { MAX_SOURCE_BYTES } from './runs';

export const DATASET_PACKAGE_FORMAT = 1;
export const MAX_DATASET_CASES = 200;
export const MAX_DATASET_ASSIGNMENTS = 100;
export const MAX_DATASET_SOURCES = 1000;
export const MAX_DATASET_SOURCE_BYTES = 2 * 1024 * 1024;

export type DatasetSplit = 'development' | 'held_out';

export interface DatasetPackageFiles {
  manifest: unknown;
  scoring: unknown;
  verification: unknown;
}

export interface DatasetPackageError {
  key: string;
  message: string;
}

export type KeyEvidence =
  | { kind: 'source'; path: string; startLine: number; endLine: number }
  | { kind: 'test'; testId: string };

export interface ExpectedError {
  id: string;
  requirement: string;
  evidence: KeyEvidence[];
  note: string;
}

export interface ScoringEntry {
  clean: boolean;
  errors: ExpectedError[];
}

export interface ParsedSubmission {
  version: 'single' | 'original' | 'corrected';
  path: string;
  assignmentRevision: string;
  source: string;
  sourceBytes: Uint8Array;
  key: ScoringEntry;
}

export interface AuthoringCheck {
  id: string;
  status: 'pass' | 'fail';
  note: string;
}

export interface ParsedDatasetCase {
  id: string;
  familyId: string;
  split: DatasetSplit;
  assignmentId: string;
  assignmentRevision: string;
  format: AssignmentFormat;
  pair: { targetedErrorIds: string[] } | null;
  submissions: ParsedSubmission[];
  authoringChecks: AuthoringCheck[];
}

export interface ParsedAssignment {
  id: string;
  config: ValidatedConfig;
}

export interface CoverageCell {
  clean: number;
  fixed: number;
  partial: number;
}

export interface DatasetCoverage {
  development: Record<AssignmentFormat, CoverageCell>;
  held_out: Record<AssignmentFormat, CoverageCell>;
}

export interface ParsedDatasetPackage {
  datasetId: string;
  revision: string;
  assignments: ParsedAssignment[];
  cases: ParsedDatasetCase[];
  coverage: DatasetCoverage;
}

export type DatasetPackageResult =
  | { ok: true; package: ParsedDatasetPackage }
  | { ok: false; errors: DatasetPackageError[] };

const REVISION_PATTERN = /^\d{4}-\d{2}-\d{2}\.\d+$/;
const ID_PATTERN = /^[a-z0-9_-]+$/;
const VERSIONS = new Set(['single', 'original', 'corrected']);

class PackageErrors {
  readonly errors: DatasetPackageError[] = [];

  add(key: string, message: string): void {
    if (this.errors.length >= 200) return;
    this.errors.push({ key, message });
  }
}

export function parseDatasetPackage(files: DatasetPackageFiles): DatasetPackageResult {
  const errors = new PackageErrors();
  const manifest = record(files.manifest, 'manifest', errors);
  const scoring = record(files.scoring, 'scoring', errors);
  const verification = record(files.verification, 'verification', errors);
  if (manifest === null || scoring === null || verification === null) {
    return { ok: false, errors: errors.errors };
  }

  if (manifest.format !== DATASET_PACKAGE_FORMAT) {
    errors.add('format', `Manifest format must be ${DATASET_PACKAGE_FORMAT}.`);
  }
  const datasetId = text(manifest.datasetId);
  if (!ID_PATTERN.test(datasetId)) {
    errors.add('datasetId', 'Use lowercase letters, digits, hyphens, or underscores.');
  }
  const revision = text(manifest.revision);
  if (!REVISION_PATTERN.test(revision)) {
    errors.add('revision', 'Use a dated revision such as 2026-11-27.1.');
  }
  for (const [name, value] of [['scoring', scoring], ['verification', verification]] as const) {
    if (text(value.datasetId) !== datasetId) {
      errors.add(`${name}.datasetId`, 'Must match the manifest dataset ID.');
    }
    if (text(value.revision) !== revision) {
      errors.add(`${name}.revision`, 'Must match the manifest revision.');
    }
  }

  const assignments = parseAssignments(manifest.assignments, errors);
  const sources = sourceFiles(manifest.submissions, errors);
  const cases = parseCases(manifest.cases, assignments, sources, errors);
  attachKeys(cases, assignments, scoring, errors);
  attachVerification(cases, verification, errors);

  if (errors.errors.length > 0) {
    return { ok: false, errors: errors.errors };
  }

  return {
    ok: true,
    package: {
      datasetId,
      revision,
      assignments: [...assignments.values()],
      cases,
      coverage: coverageForCases(cases),
    },
  };
}

function parseAssignments(
  value: unknown,
  errors: PackageErrors,
): Map<string, ParsedAssignment> {
  const result = new Map<string, ParsedAssignment>();
  if (!isRecord(value)) {
    errors.add('assignments', 'List each assignment by a stable ID.');
    return result;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) errors.add('assignments', 'Add at least one assignment.');
  if (entries.length > MAX_DATASET_ASSIGNMENTS) {
    errors.add('assignments', `Use at most ${MAX_DATASET_ASSIGNMENTS} assignments.`);
  }
  for (const [id, raw] of entries) {
    if (!ID_PATTERN.test(id)) {
      errors.add(`assignment.${id}`, 'Use a lowercase stable assignment ID.');
      continue;
    }
    const assignment = record(raw, `assignment.${id}`, errors);
    if (assignment === null) continue;
    if (Array.isArray(assignment.criteria)) {
      for (const [index, criterion] of assignment.criteria.entries()) {
        if (!isRecord(criterion) || text(criterion.id) === '') {
          errors.add(`assignment.${id}.criteria.${index}`, 'Use a criterion object with a stable ID.');
        }
      }
    }
    if (Array.isArray(assignment.tests)) {
      for (const [index, test] of assignment.tests.entries()) {
        if (!isRecord(test) || text(test.id) === '') {
          errors.add(`assignment.${id}.tests.${index}`, 'Use a test object with a stable ID.');
        }
      }
    }
    const rawConfig = assignmentConfig(assignment);
    if (rawConfig === null) {
      errors.add(`assignment.${id}.tests`, 'Use an ordered list of tests.');
      continue;
    }
    const validation = validateConfig(rawConfig);
    if (!validation.ok) {
      for (const [field, message] of flattenConfigErrors(validation.errors)) {
        errors.add(`assignment.${id}.${field}`, message);
      }
      continue;
    }
    result.set(id, {
      id,
      config: validation.config,
    });
  }
  return result;
}

function assignmentConfig(assignment: Record<string, unknown>): RawConfig | null {
  if (!Array.isArray(assignment.tests) || !Array.isArray(assignment.criteria)) return null;
  return {
    title: text(assignment.title),
    description: text(assignment.description),
    format: assignment.format === 'script' ? 'script' : 'function',
    entryPoint: text(assignment.entryPoint),
    criteria: assignment.criteria.map((criterion) => isRecord(criterion)
      ? {
          id: text(criterion.id),
          description: text(criterion.description),
          expectedBehavior: text(criterion.expectedBehavior),
        }
      : { id: '', description: '', expectedBehavior: '' }),
    tests: assignment.tests.map((test) => {
      const raw: RawTest = { id: isRecord(test) ? text(test.id) : '' };
      if (!isRecord(test)) return raw;
      if (test.arguments !== undefined) raw.arguments = text(test.arguments);
      if (test.expectedReturn !== undefined) raw.expectedReturn = text(test.expectedReturn);
      if (test.stdin !== undefined) raw.stdin = text(test.stdin);
      if (test.expectedStdout !== undefined) raw.expectedStdout = text(test.expectedStdout);
      return raw;
    }),
  };
}

function flattenConfigErrors(errors: unknown): [string, string][] {
  if (!isRecord(errors)) return [];
  const result: [string, string][] = [];
  for (const [field, value] of Object.entries(errors)) {
    if (typeof value === 'string') {
      result.push([field, value]);
    } else if (isRecord(value)) {
      result.push([field, text(value.message) || 'Invalid rows.']);
      if (isRecord(value.rows)) {
        for (const [row, rowErrors] of Object.entries(value.rows)) {
          if (!isRecord(rowErrors)) continue;
          for (const [name, message] of Object.entries(rowErrors)) {
            result.push([`${field}.${row}.${name}`, text(message)]);
          }
        }
      }
    }
  }
  return result;
}

interface SourceFile {
  text: string;
  bytes: Uint8Array;
}

function sourceFiles(value: unknown, errors: PackageErrors): Map<string, SourceFile> {
  const result = new Map<string, SourceFile>();
  if (!isRecord(value)) {
    errors.add('submissions', 'Provide the Python sources keyed by package path.');
    return result;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_DATASET_SOURCES) {
    errors.add('submissions', `Use at most ${MAX_DATASET_SOURCES} source files.`);
  }
  let total = 0;
  for (const [path, entry] of entries) {
    const key = `submission.${path}`;
    if (!path.endsWith('.py') || path.startsWith('/') || path.includes('..')) {
      errors.add(key, 'Use a relative .py path.');
      continue;
    }
    const source = record(entry, key, errors);
    if (source === null) continue;
    let bytes: Uint8Array;
    try {
      bytes = source.encoding === 'base64'
        ? base64Bytes(text(source.text))
        : new TextEncoder().encode(text(source.text));
    } catch {
      errors.add(key, 'The source is not valid base64.');
      continue;
    }
    total += bytes.byteLength;
    if (bytes.byteLength > MAX_SOURCE_BYTES) {
      errors.add(key, `Keep each source at most ${MAX_SOURCE_BYTES / 1024} KiB.`);
    }
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      result.set(path, { text: decoded, bytes });
    } catch {
      errors.add(key, 'The source must be valid UTF-8.');
    }
  }
  if (total > MAX_DATASET_SOURCE_BYTES) {
    errors.add('submissions', `Keep all sources under ${MAX_DATASET_SOURCE_BYTES / 1024 / 1024} MiB.`);
  }
  return result;
}

function parseCases(
  value: unknown,
  assignments: Map<string, ParsedAssignment>,
  sources: Map<string, SourceFile>,
  errors: PackageErrors,
): ParsedDatasetCase[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.add('cases', 'Add at least one case.');
    return [];
  }
  if (value.length > MAX_DATASET_CASES) {
    errors.add('cases', `Use at most ${MAX_DATASET_CASES} cases.`);
  }

  const cases: ParsedDatasetCase[] = [];
  const caseIds = new Set<string>();
  const familySplits = new Map<string, DatasetSplit>();
  const pathSplits = new Map<string, DatasetSplit>();

  for (const [index, raw] of value.entries()) {
    const datasetCase = record(raw, `cases.${index}`, errors);
    if (datasetCase === null) continue;
    const id = text(datasetCase.id);
    const key = `case.${id || index}`;
    if (!ID_PATTERN.test(id)) {
      errors.add(`${key}.id`, 'Use a lowercase stable case ID.');
      continue;
    }
    if (caseIds.has(id)) {
      errors.add(`${key}.id`, 'Case IDs must be unique.');
      continue;
    }
    caseIds.add(id);

    const split = datasetCase.split;
    if (split !== 'development' && split !== 'held_out') {
      errors.add(`${key}.split`, 'Choose development or held_out.');
      continue;
    }
    const familyId = text(datasetCase.familyId);
    if (!ID_PATTERN.test(familyId)) {
      errors.add(`${key}.family`, 'Use a stable family ID.');
    } else {
      const existing = familySplits.get(familyId);
      if (existing !== undefined && existing !== split) {
        errors.add(`${key}.family`, 'An assignment family must stay in one split.');
      } else {
        familySplits.set(familyId, split);
      }
    }

    const assignmentId = text(datasetCase.assignmentId);
    const assignment = assignments.get(assignmentId);
    if (assignment === undefined) {
      errors.add(`${key}.assignmentId`, 'Reference a declared assignment.');
      continue;
    }

    const submissions = parseSubmissions(datasetCase.submissions, key, sources, pathSplits, split, errors);
    if (submissions.length === 0) continue;
    const revisions = new Set(submissions.map((submission) => submission.assignmentRevision));
    if (revisions.size !== 1) {
      errors.add(`${key}.assignmentRevision`, 'Both versions of a pair must use the same assignment revision.');
    }

    cases.push({
      id,
      familyId,
      split,
      assignmentId,
      assignmentRevision: submissions[0]!.assignmentRevision,
      format: assignment.config.format,
      pair: submissions.length === 2 ? { targetedErrorIds: [] } : null,
      submissions,
      authoringChecks: [],
    });
  }
  return cases;
}

function parseSubmissions(
  value: unknown,
  caseKey: string,
  sources: Map<string, SourceFile>,
  pathSplits: Map<string, DatasetSplit>,
  split: DatasetSplit,
  errors: PackageErrors,
): ParsedSubmission[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    errors.add(`${caseKey}.submissions`, 'Use one submission or an original/corrected pair.');
    return [];
  }
  const submissions: ParsedSubmission[] = [];
  const versions = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const entry = record(raw, `${caseKey}.submissions.${index}`, errors);
    if (entry === null) continue;
    const version = text(entry.version);
    const invalidForShape = value.length === 1 ? version !== 'single' : version === 'single';
    if (!VERSIONS.has(version) || invalidForShape) {
      errors.add(`${caseKey}.submissions.${index}.version`, 'Use single, original, or corrected.');
      continue;
    }
    if (versions.has(version)) {
      errors.add(`${caseKey}.submissions.${index}.version`, 'Submission versions must be unique.');
      continue;
    }
    versions.add(version);
    const path = text(entry.path);
    const source = sources.get(path);
    if (source === undefined) {
      errors.add(`${caseKey}.submissions.${index}.path`, 'Reference a declared submission file.');
      continue;
    }
    const previousSplit = pathSplits.get(path);
    if (previousSplit !== undefined && previousSplit !== split) {
      errors.add(`${caseKey}.split`, 'A submission file cannot appear in both splits.');
    } else {
      pathSplits.set(path, split);
    }
    submissions.push({
      version: version as ParsedSubmission['version'],
      path,
      assignmentRevision: text(entry.assignmentRevision) || '1',
      source: source.text,
      sourceBytes: source.bytes,
      key: { clean: false, errors: [] },
    });
  }
  if (value.length === 2) {
    const present = new Set(submissions.map((submission) => submission.version));
    if (!present.has('original') || !present.has('corrected')) {
      errors.add(`${caseKey}.submissions`, 'A pair needs one original and one corrected submission.');
    }
    if (submissions.length === 2 && submissions[0]!.path === submissions[1]!.path) {
      errors.add(`${caseKey}.submissions`, 'A pair needs two different source files.');
    }
  }
  return submissions;
}

function attachKeys(
  cases: ParsedDatasetCase[],
  assignments: Map<string, ParsedAssignment>,
  scoring: Record<string, unknown>,
  errors: PackageErrors,
): void {
  const entries = isRecord(scoring.cases) ? scoring.cases : null;
  if (entries === null) {
    errors.add('scoring.cases', 'Provide a scoring entry for each case.');
    return;
  }
  const caseIds = new Set(cases.map((datasetCase) => datasetCase.id));
  for (const key of Object.keys(entries)) {
    if (!caseIds.has(key)) errors.add(`scoring.${key}`, 'The scoring key names an unknown case.');
  }

  for (const datasetCase of cases) {
    const assignment = assignments.get(datasetCase.assignmentId)!;
    const criteria = new Set(assignment.config.criteria.map((criterion) => criterion.id));
    const testIds = new Set(assignment.config.tests.map((test) => test.id));
    const entry = entries[datasetCase.id];
    if (entry === undefined) {
      errors.add(`scoring.${datasetCase.id}`, 'Add a scoring entry for this case.');
      continue;
    }
    const raw = record(entry, `scoring.${datasetCase.id}`, errors);
    if (raw === null) continue;
    const submissions = isRecord(raw.submissions) ? raw.submissions : null;
    if (submissions === null) {
      errors.add(`scoring.${datasetCase.id}.submissions`, 'Score each submission version.');
      continue;
    }
    const expectedVersions = new Set(datasetCase.submissions.map((submission) => submission.version));
    for (const key of Object.keys(submissions)) {
      if (!expectedVersions.has(key as ParsedSubmission['version'])) {
        errors.add(`scoring.${datasetCase.id}.${key}`, 'The key names an unknown submission version.');
      }
    }
    for (const submission of datasetCase.submissions) {
      const key = `scoring.${datasetCase.id}.${submission.version}`;
      const entryValue = record(submissions[submission.version], key, errors);
      if (entryValue === null) continue;
      const parsed = parseScoringEntry(entryValue, key, submission, criteria, testIds, errors);
      if (parsed !== null) submission.key = parsed;
    }

    if (datasetCase.pair === null) {
      if (raw.targetedErrorIds !== undefined) {
        errors.add(`scoring.${datasetCase.id}.targetedErrorIds`, 'Only a pair has targeted errors.');
      }
      continue;
    }
    const targeted = stringArray(raw.targetedErrorIds);
    if (targeted.length === 0) {
      errors.add(`scoring.${datasetCase.id}.targetedErrorIds`, 'Name the error the correction targets.');
      continue;
    }
    const original = datasetCase.submissions.find((submission) => submission.version === 'original');
    const corrected = datasetCase.submissions.find((submission) => submission.version === 'corrected');
    const originalIds = new Set(original?.key.errors.map((error) => error.id) ?? []);
    const correctedIds = new Set(corrected?.key.errors.map((error) => error.id) ?? []);
    for (const id of targeted) {
      if (!originalIds.has(id)) {
        errors.add(
          `scoring.${datasetCase.id}.targetedErrorIds`,
          `"${id}" is not an expected original error.`,
        );
      }
      if (correctedIds.has(id)) {
        errors.add(
          `scoring.${datasetCase.id}.corrected.targeted`,
          `"${id}" must be absent from the corrected submission.`,
        );
      }
    }
    datasetCase.pair.targetedErrorIds = targeted;
  }
}

function parseScoringEntry(
  value: Record<string, unknown>,
  key: string,
  submission: ParsedSubmission,
  criteria: Set<string>,
  testIds: Set<string>,
  errors: PackageErrors,
): ScoringEntry | null {
  if (typeof value.clean !== 'boolean') {
    errors.add(`${key}.clean`, 'Say whether the submission is clean.');
  }
  if (!Array.isArray(value.errors)) {
    errors.add(`${key}.errors`, 'List each expected error.');
    return null;
  }
  const seen = new Set<string>();
  const expected: ExpectedError[] = [];
  for (const [index, raw] of value.errors.entries()) {
    const errorKey = `${key}.errors.${index}`;
    const entry = record(raw, errorKey, errors);
    if (entry === null) continue;
    const id = text(entry.id);
    if (!ID_PATTERN.test(id)) {
      errors.add(`${errorKey}.id`, 'Use a stable lowercase error ID.');
    } else if (seen.has(id)) {
      errors.add(`${errorKey}.id`, 'Error IDs must be unique within a submission.');
    } else {
      seen.add(id);
    }
    const requirement = text(entry.requirement);
    if (!criteria.has(requirement)) {
      errors.add(`${errorKey}.requirement`, 'Reference a rubric criterion.');
    }
    expected.push({
      id,
      requirement,
      evidence: evidenceList(entry.evidence, `${errorKey}.evidence`, submission, testIds, errors),
      note: text(entry.note),
    });
  }
  const clean = value.clean === true;
  if (clean && expected.length > 0) {
    errors.add(`${key}.clean`, 'A clean submission has no expected errors.');
  }
  if (!clean && expected.length === 0) {
    errors.add(`${key}.errors`, 'List at least one expected error.');
  }
  return { clean, errors: expected };
}

function evidenceList(
  value: unknown,
  key: string,
  submission: ParsedSubmission,
  testIds: Set<string>,
  errors: PackageErrors,
): KeyEvidence[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.add(key, 'Cite at least one source range or study test.');
    return [];
  }
  const lineCount = submission.source.split('\n').length;
  const result: KeyEvidence[] = [];
  for (const [index, raw] of value.entries()) {
    const itemKey = `${key}.${index}`;
    const entry = record(raw, itemKey, errors);
    if (entry === null) continue;
    if (entry.kind === 'source') {
      const path = text(entry.path);
      const startLine = entry.startLine;
      const endLine = entry.endLine;
      if (path !== submission.path) {
        errors.add(itemKey, 'Cite the source of the scored submission.');
      } else if (
        typeof startLine !== 'number' || typeof endLine !== 'number'
        || !Number.isInteger(startLine) || !Number.isInteger(endLine)
        || startLine < 1 || endLine < startLine || endLine > lineCount
      ) {
        errors.add(itemKey, `Use a line range between 1 and ${lineCount}.`);
      } else {
        result.push({ kind: 'source', path, startLine, endLine });
      }
    } else if (entry.kind === 'test') {
      const testId = text(entry.testId);
      if (!testIds.has(testId)) {
        errors.add(itemKey, 'Reference a supplied study test.');
      } else {
        result.push({ kind: 'test', testId });
      }
    } else {
      errors.add(itemKey, 'Use a source range or a study test.');
    }
  }
  return result;
}

function attachVerification(
  cases: ParsedDatasetCase[],
  verification: Record<string, unknown>,
  errors: PackageErrors,
): void {
  if (verification.cases === undefined) return;
  if (!isRecord(verification.cases)) {
    errors.add('verification.cases', 'List authoring checks by case.');
    return;
  }
  const caseKeys = new Set(cases.map((datasetCase) => datasetCase.id));
  for (const key of Object.keys(verification.cases)) {
    if (!caseKeys.has(key)) {
      errors.add(`verification.${key}`, 'The verification record names an unknown case.');
    }
  }
  for (const datasetCase of cases) {
    const entry = verification.cases[datasetCase.id];
    if (entry === undefined) continue;
    const raw = record(entry, `verification.${datasetCase.id}`, errors);
    if (raw === null || raw.authoringChecks === undefined) continue;
    if (!Array.isArray(raw.authoringChecks)) {
      errors.add(`verification.${datasetCase.id}.authoringChecks`, 'List each authoring check.');
      continue;
    }
    for (const [index, checkRaw] of raw.authoringChecks.entries()) {
      const key = `verification.${datasetCase.id}.authoringChecks.${index}`;
      const checkValue = record(checkRaw, key, errors);
      if (checkValue === null) continue;
      if (checkValue.status !== 'pass' && checkValue.status !== 'fail') {
        errors.add(`${key}.status`, 'Use pass or fail.');
        continue;
      }
      datasetCase.authoringChecks.push({
        id: text(checkValue.id),
        status: checkValue.status,
        note: text(checkValue.note),
      });
    }
  }
}

export function emptyCoverage(): DatasetCoverage {
  const empty = (): CoverageCell => ({ clean: 0, fixed: 0, partial: 0 });
  return {
    development: { function: empty(), script: empty() },
    held_out: { function: empty(), script: empty() },
  };
}

export function addCaseCoverage(
  coverage: DatasetCoverage,
  stats: {
    split: DatasetSplit;
    format: AssignmentFormat;
    isPair: boolean;
    singleClean: boolean;
    correctedClean: boolean;
  },
): void {
  const cell = coverage[stats.split][stats.format];
  if (!stats.isPair) {
    if (stats.singleClean) cell.clean += 1;
  } else if (stats.correctedClean) {
    cell.fixed += 1;
  } else {
    cell.partial += 1;
  }
}

export function coverageForCases(cases: ParsedDatasetCase[]): DatasetCoverage {
  const coverage = emptyCoverage();
  for (const datasetCase of cases) {
    const corrected = datasetCase.submissions.find((submission) => submission.version === 'corrected');
    addCaseCoverage(coverage, {
      split: datasetCase.split,
      format: datasetCase.format,
      isPair: datasetCase.pair !== null,
      singleClean: datasetCase.submissions[0]?.key.clean === true,
      correctedClean: corrected?.key.clean === true,
    });
  }
  return coverage;
}

function record(
  value: unknown,
  key: string,
  errors: PackageErrors,
): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  errors.add(key, 'Expected a JSON object.');
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
