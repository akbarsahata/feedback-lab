export function normalizeScriptOutput(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n');
  return normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
}

export function compareScriptStdout(expected: string, actual: string): boolean {
  return normalizeScriptOutput(expected) === normalizeScriptOutput(actual);
}
