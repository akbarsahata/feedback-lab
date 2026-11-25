import type { RawConfig, RawCriterion, RawTest } from './config';

export interface ParsedAssignmentForm {
  raw: RawConfig;
  csrfToken: string;
  baseVersionId: string;
}

interface MutableRow {
  [field: string]: string;
}

const ROW_FIELD_PATTERN = /^(criteria|tests)\[(\d+)\]\[([A-Za-z]+)\]$/;
export function parseAssignmentForm(form: FormData): ParsedAssignmentForm {
  const criteria = new Map<string, MutableRow>();
  const tests = new Map<string, MutableRow>();

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
      entryPoint: formString(form, 'entryPoint'),
      criteria: sortedRows(criteria).map(
        (row): RawCriterion => ({
          id: row.id ?? '',
          description: row.description ?? '',
          expectedBehavior: row.expectedBehavior ?? '',
        }),
      ),
      tests: sortedRows(tests).map(
        (row): RawTest => ({
          id: row.id ?? '',
          arguments: row.arguments ?? '',
          expectedReturn: row.expectedReturn ?? '',
        }),
      ),
    },
    csrfToken: formString(form, '_csrf'),
    baseVersionId: formString(form, 'baseVersionId'),
  };
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
