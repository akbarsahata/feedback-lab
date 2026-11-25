import type { SessionUser } from './auth';
import { escapeHtml, shell } from './html';
import { formatJsonForDisplay, parseJsonValue } from './json';
import type { RunTestEvidence, TestRunDetail } from './runs';
import {
  formatActualJson,
  formatLimits,
  runStatusClass,
  runStatusLabel,
  testStatusClass,
  testStatusLabel,
} from './run-format';
import { formatTimestamp } from './pages';

export function runPage(
  user: SessionUser,
  run: TestRunDetail,
  evidence: RunTestEvidence | null,
): string {
  const passed = run.tests.filter((test) => test.status === 'pass').length;
  const finished = run.tests.filter(
    (test) => test.status !== 'pending' && test.status !== 'running',
  ).length;
  const source = new TextDecoder('utf-8', {
    fatal: false,
    ignoreBOM: false,
  }).decode(run.source);

  const statusMessage = statusDetail(run);
  const testRows = run.tests
    .map(
      (test) => `<tr>
  <td>${test.position + 1}</td>
  <td><a href="/runs/${escapeHtml(run.id)}/tests/${escapeHtml(test.id)}"><code>${escapeHtml(test.id)}</code></a></td>
  <td><span class="tag ${testStatusClass(test.status)}">${testStatusLabel(test.status)}</span></td>
  <td class="small">${test.executionMs === null ? '—' : `${test.executionMs} ms`}</td>
  <td class="small">${test.startupMs === null ? '—' : `${test.startupMs} ms${test.runnerWarm ? ' (warm)' : ' (cold)'}`}</td>
  <td class="small">${test.outputTruncated ? 'Partial' : '—'}</td>
</tr>`,
    )
    .join('');

  const body = `<div class="head">
  <div>
    <h1>Test run ${escapeHtml(run.id.slice(0, 8))}</h1>
    <p class="muted">${escapeHtml(run.title)} · version ${run.assignmentVersionNumber} · queued ${escapeHtml(formatTimestamp(run.queuedAt))}</p>
  </div>
  <div class="actions">
    <a class="button" href="/assignments/${escapeHtml(run.assignmentId)}/versions/${escapeHtml(run.assignmentVersionId)}">Assignment version</a>
    <a class="button" href="/assignments/${escapeHtml(run.assignmentId)}">Assignment</a>
  </div>
</div>
<div class="alert ${run.status === 'complete' ? 'alert-ok' : run.status === 'incomplete' ? 'alert-error' : 'alert-warn'}" role="status">
  <strong>${runStatusLabel(run.status)}.</strong> ${escapeHtml(statusMessage)}
</div>
<div class="meta-grid end">
  <div class="metric"><span class="small">Tests</span><strong>${passed} / ${run.tests.length}</strong><span class="small">${finished} finished</span></div>
  <div class="metric"><span class="small">Python</span><strong class="mono">${escapeHtml(run.pythonRelease)}</strong><span class="small mono">${escapeHtml(run.runnerArtifact)}</span></div>
  <div class="metric"><span class="small">Limits</span><strong class="small">${escapeHtml(formatLimits(run.limits))}</strong><span class="small">Per test</span></div>
</div>
<div class="split end">
  <section class="panel">
    <div class="panel-top"><h2>Submitted source</h2><span class="tag">${run.source.byteLength} bytes</span></div>
    ${lineNumberedSource(source)}
  </section>
  <div class="stack">
    <section class="panel">
      <div class="panel-top"><h2>Tests</h2><span class="tag">${escapeHtml(run.comparisonRule)}</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Test</th><th>Status</th><th>Execution</th><th>Startup</th><th>Output</th></tr></thead>
        <tbody>${testRows}</tbody>
      </table></div>
    </section>
    <section class="panel pad">
      <h2>Run references</h2>
      <div class="fields">
        <label>Assignment version<input class="mono" value="${escapeHtml(run.assignmentVersionId)}" readonly></label>
        <label>Test suite version<input class="mono" value="${escapeHtml(run.testSuiteVersionId)}" readonly></label>
        <label>Rubric version<input class="mono" value="${escapeHtml(run.rubricVersionId)}" readonly></label>
        <label>Submission version<input class="mono" value="${escapeHtml(run.submissionId)}" readonly></label>
      </div>
    </section>
  </div>
</div>
${evidence === null ? '' : evidencePanel(run, evidence)}`;

  return shell({ title: `Test run ${run.id.slice(0, 8)}`, user, body });
}

function evidencePanel(run: TestRunDetail, evidence: RunTestEvidence): string {
  const expected = safeDisplay(evidence.expectedReturnJson);
  const actual =
    evidence.actualJson === null ? null : formatActualJson(evidence.actualJson);
  return `<section class="panel end" id="test-${escapeHtml(evidence.id)}">
  <div class="panel-top">
    <h2>Test <code>${escapeHtml(evidence.id)}</code></h2>
    <span class="tag ${testStatusClass(evidence.status)}">${testStatusLabel(evidence.status)}</span>
  </div>
  <div class="pad stack">
    ${evidence.diagnostic === null ? '' : `<div class="alert alert-error" role="alert">${escapeHtml(evidence.diagnostic)}</div>`}
    <div class="fields">
      <label>Positional arguments<textarea class="mono" rows="3" readonly>${escapeHtml(safeDisplay(evidence.argumentsJson))}</textarea></label>
      <label>Expected return<textarea class="mono" rows="3" readonly>${escapeHtml(expected)}</textarea></label>
      <label>Actual return<textarea class="mono" rows="3" readonly>${escapeHtml(actual ?? 'No actual value recorded')}</textarea></label>
      <label>Timing<input readonly value="${escapeHtml(timing(evidence))}"></label>
    </div>
    <div class="fields">
      <label>Standard output${evidence.outputTruncated ? ' (partial or truncated)' : ''}<textarea class="mono" rows="5" readonly>${escapeHtml(evidence.stdout)}</textarea></label>
      <label>Standard error${evidence.outputTruncated ? ' (partial or truncated)' : ''}<textarea class="mono" rows="5" readonly>${escapeHtml(evidence.stderr)}</textarea></label>
    </div>
    <p class="hint">Return value, printed output, and diagnostics are recorded separately. Reopen this run to compare it with <a href="/assignments/${escapeHtml(run.assignmentId)}/versions/${escapeHtml(run.assignmentVersionId)}">the exact assignment version</a>.</p>
  </div>
</section>`;
}

function statusDetail(run: TestRunDetail): string {
  if (run.incompleteReason !== null) return run.incompleteReason;
  if (run.status === 'queued') return 'Waiting for the runner to accept this run.';
  if (run.status === 'running') return 'Tests are running. Reload this page for updated evidence.';
  if (run.status === 'complete') {
    return 'Every configured test has a recorded execution outcome.';
  }
  return 'Completed evidence is retained; unfinished tests are identified individually.';
}

function lineNumberedSource(source: string): string {
  const lines = source.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return `<div class="source" role="region" aria-label="Submitted source with line numbers" tabindex="0">${lines
    .map(
      (line, index) => `<div class="source-line"><span class="source-number">${index + 1}</span><span class="source-code">${escapeHtml(line.replace(/\r$/, ''))}</span></div>`,
    )
    .join('')}</div>`;
}

function safeDisplay(json: string): string {
  try {
    return formatJsonForDisplay(parseJsonValue(json));
  } catch {
    return json;
  }
}

function timing(evidence: RunTestEvidence): string {
  if (evidence.executionMs === null && evidence.startupMs === null) {
    return 'Not measured';
  }
  const parts: string[] = [];
  if (evidence.startupMs !== null) {
    parts.push(`startup ${evidence.startupMs} ms${evidence.runnerWarm ? ' (warm reuse)' : ' (cold)'}`);
  }
  if (evidence.executionMs !== null) parts.push(`execution ${evidence.executionMs} ms`);
  return parts.join(' · ');
}
