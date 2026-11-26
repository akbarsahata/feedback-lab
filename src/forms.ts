import type { AssignmentFormat, RawConfig, RawCriterion, RawTest } from './config';

export interface ParsedAssignmentForm {
  raw: RawConfig;
  csrfToken: string;
  baseVersionId: string;
  confirmedFormatSwitch: boolean;
}

interface MutableRow {
  [field: string]: string;
}

const ROW_FIELD_PATTERN = /^(criteria|tests)\[(\d+)\]\[([A-Za-z]+)\]$/;
export function parseAssignmentForm(form: FormData): ParsedAssignmentForm {
  const criteria = new Map<string, MutableRow>();
  const tests = new Map<string, MutableRow>();
  const format: AssignmentFormat = formString(form, 'format') === 'script'
    ? 'script'
    : 'function';

  for (const [name, value] of form.entries()) {
    if (typeof value !== 'string') {
      continue;
    }
    const match = ROW_FIELD_PATTERN.exec(name);
    if (match === null) {
      continue;
    }
    const list = match[1];
    const index = match[2]!.replace(/^0+(?=\d)/, '');
    const field = match[3] as string;
    const rows = list === 'criteria' ? criteria : tests;
    let row = rows.get(index);
    if (row === undefined) {
      row = {};
      rows.set(index, row);
    }
    row[field] = value;
  }

  return {
    raw: {
      title: formString(form, 'title'),
      description: formString(form, 'description'),
      format,
      entryPoint: format === 'script' ? '' : formString(form, 'entryPoint'),
      criteria: sortedRows(criteria).map(
        (row): RawCriterion => ({
          id: row.id ?? '',
          description: row.description ?? '',
          expectedBehavior: row.expectedBehavior ?? '',
        }),
      ),
      tests: sortedRows(tests).map(
        (row): RawTest => format === 'script'
          ? {
              id: row.id ?? '',
              stdin: readExactText(row.stdinText, row.stdin),
              expectedStdout: readExactText(row.expectedStdoutText, row.expectedStdout),
            }
          : {
              id: row.id ?? '',
              arguments: row.arguments ?? '',
              expectedReturn: row.expectedReturn ?? '',
            },
      ),
    },
    csrfToken: formString(form, '_csrf'),
    baseVersionId: formString(form, 'baseVersionId'),
    confirmedFormatSwitch: formString(form, 'confirmFormatSwitch') === 'yes',
  };
}

function readExactText(encoded: string | undefined, plain: string | undefined): string | undefined {
  if (encoded === undefined) return plain ?? '';
  try {
    const text: unknown = JSON.parse(encoded);
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

function sortedRows(rows: Map<string, MutableRow>): MutableRow[] {
  // For normalized decimal indices, digit count then lexical order is numeric order.
  return [...rows.entries()]
    .sort(([left], [right]) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0))
    .map(([, row]) => row);
}

export function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}
