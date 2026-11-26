import type { ActualValue } from './function-value';
import type { RunStatus, TestStatus } from './runs';

const RUN_LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  complete: 'Complete',
  incomplete: 'Incomplete',
};

const TEST_LABELS: Record<TestStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  pass: 'Pass',
  mismatch: 'Mismatch',
  execution_error: 'Execution error',
  timed_out: 'Timed out',
  memory_limit: 'Memory limit reached',
  output_limit: 'Output limit reached',
  infrastructure_failure: 'Infrastructure failure',
  not_run: 'Not run',
};

export function runStatusLabel(status: RunStatus): string {
  return RUN_LABELS[status];
}

export function runStatusClass(status: RunStatus): string {
  if (status === 'complete') return 'ok';
  if (status === 'incomplete') return 'bad';
  if (status === 'running') return 'info';
  return 'warn';
}

export function testStatusLabel(status: TestStatus): string {
  return TEST_LABELS[status];
}

export function testStatusClass(status: TestStatus): string {
  if (status === 'pass') return 'ok';
  if (
    status === 'mismatch' ||
    status === 'infrastructure_failure' ||
    status === 'not_run'
  ) {
    return 'bad';
  }
  if (status === 'pending' || status === 'running') return 'warn';
  return 'warn';
}

export function formatActualJson(source: string): string {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return source;
  }
  return formatActual(value as ActualValue);
}

function formatActual(value: ActualValue): string {
  switch (value.kind) {
    case 'none':
      return 'None';
    case 'bool':
      return value.value ? 'True' : 'False';
    case 'int':
    case 'float':
      return value.value;
    case 'str':
      return JSON.stringify(value.value);
    case 'list':
      return `[${value.items.map(formatActual).join(', ')}]`;
    case 'dict':
      return `{${value.entries
        .map((entry) => `${JSON.stringify(entry.key)}: ${formatActual(entry.value)}`)
        .join(', ')}}`;
  }
}

export function formatLimits(limits: { executionMs: number; memoryMiB: number; outputBytes: number }): string {
  return `${limits.executionMs / 1000} s · ${limits.memoryMiB} MiB · ${limits.outputBytes / 1024} KiB output`;
}

export function formatScript(text: string): string {
  return text === '' ? '(empty string)' : text;
}

/**
 * Renders text with every space, tab, and line ending visible so trailing
 * spaces, blank lines, and CRLF differences can be inspected without changing
 * the saved evidence.
 */
export function visibleWhitespace(text: string): string {
  if (text === '') return '(empty string)';
  let rendered = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '\r' && text[index + 1] === '\n') {
      rendered += '\u240d\u240a\n';
      index += 1;
    } else if (character === '\r') {
      rendered += '\u240d\n';
    } else if (character === '\n') {
      rendered += '\u240a\n';
    } else if (character === '\t') {
      rendered += '\u2192';
    } else if (character === ' ') {
      rendered += '\u00b7';
    } else {
      rendered += character;
    }
  }
  return rendered;
}

export function describeOutput(
  stdout: string | null,
  stdoutLossy: boolean,
  outputTruncated: boolean,
): string {
  if (stdout === null) return 'Standard output is unavailable for this test.';
  const parts = [stdout === '' ? 'Standard output was empty.' : 'Standard output was captured.'];
  if (stdoutLossy) parts.push('The preview is lossy because stdout was not valid UTF-8.');
  if (outputTruncated) parts.push('The captured output is partial or truncated.');
  return parts.join(' ');
}
