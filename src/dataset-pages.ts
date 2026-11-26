import type { SessionUser } from './auth';
import { escapeHtml, shell } from './html';
import type {
  DatasetCaseDetail,
  DatasetLibraryEntry,
  DatasetRevisionDetail,
  DatasetSubmissionDetail,
} from './dataset-repository';
import type { DatasetPackageError } from './dataset-package';

export interface DatasetPageNotice {
  kind: 'ok' | 'warn' | 'error';
  message: string;
}

function noticeBlock(notice: DatasetPageNotice | undefined): string {
  if (notice === undefined) return '';
  const className = notice.kind === 'ok'
    ? 'alert alert-ok'
    : notice.kind === 'warn'
      ? 'alert alert-warn'
      : 'alert alert-error';
  return `<div class="${className}" role="alert">${escapeHtml(notice.message)}</div>`;
}

function timestamp(value: string | null): string {
  if (value === null) return '—';
  return escapeHtml(new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
}

export function datasetLibraryPage(
  user: SessionUser,
  datasets: DatasetLibraryEntry[],
  options: {
    notice?: DatasetPageNotice;
    packageErrors?: DatasetPackageError[];
    uploadErrors?: string[];
  } = {},
): string {
  const errors = [
    ...(options.uploadErrors ?? []).map((message) => ({ key: 'upload', message })),
    ...(options.packageErrors ?? []),
  ];
  const errorList = errors.length === 0
    ? ''
    : `<div class="alert alert-error" role="alert"><strong>The package was not imported.</strong>
<ul>${errors.map((error) => `<li><span class="mono">${escapeHtml(error.key)}</span>: ${escapeHtml(error.message)}</li>`).join('')}</ul></div>`;

  const rows = datasets.map((dataset) => `<tr>
  <td><a href="/datasets/${escapeHtml(dataset.activeRevisionId ?? '')}">${escapeHtml(dataset.datasetId)}</a><br><span class="small">revision ${escapeHtml(dataset.packageRevision ?? '—')}</span></td>
  <td><span class="tag ${dataset.status === 'frozen' ? 'ok' : 'warn'}">${escapeHtml(dataset.status)}</span></td>
  <td>${dataset.caseCount}</td>
  <td class="small">${timestamp(dataset.updatedAt)}</td>
</tr>`).join('');

  const body = `<div class="head">
  <div><h1>Datasets</h1><p class="muted">Import, verify, and freeze a paired synthetic corpus. Scorer and verification files never enter model inputs.</p></div>
</div>
${noticeBlock(options.notice)}
${errorList}
<div class="split">
  <section class="panel">
    <div class="panel-top"><h2>Dataset library</h2><span class="tag">${datasets.length}</span></div>
    ${datasets.length === 0
      ? '<div class="pad"><p class="muted">No dataset has been imported yet.</p></div>'
      : `<div class="table-wrap"><table>
    <thead><tr><th>Dataset</th><th>Status</th><th>Cases</th><th>Updated</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`}
  </section>
  <section class="panel pad">
    <h2>Import a package</h2>
    <p class="muted small">Upload manifest.json, scoring-key.json, verification.json, and the Python files named by the manifest. Importing the same revision twice is a no-op; changing its contents is rejected.</p>
    <form method="post" action="/datasets/import" enctype="multipart/form-data" class="stack">
      <input type="hidden" name="_csrf" value="${escapeHtml(user.csrfToken)}">
      <label>Manifest <input type="file" name="manifest" accept="application/json,.json" required></label>
      <label>Scoring key <input type="file" name="scoring" accept="application/json,.json" required></label>
      <label>Verification record <input type="file" name="verification" accept="application/json,.json" required></label>
      <label>Python files <input type="file" name="sources" accept=".py" multiple></label>
      <div><button class="primary" type="submit">Import package</button></div>
    </form>
  </section>
</div>`;

  return shell({ title: 'Datasets', user, body });
}

export function datasetDetailPage(
  user: SessionUser,
  dataset: DatasetRevisionDetail,
  options: { notice?: DatasetPageNotice; freezeIssues?: string[] } = {},
): string {
  const coverageRows = (['development', 'held_out'] as const)
    .flatMap((split) => (['function', 'script'] as const).map((format) => {
      const cell = dataset.coverage[split][format];
      return `<tr>
  <td>${escapeHtml(split)}</td><td>${escapeHtml(format)}</td>
  <td>${cell.clean}</td><td>${cell.fixed}</td><td>${cell.partial}</td>
</tr>`;
    }))
    .join('');

  const cases = dataset.cases.map((datasetCase) => caseCard(user, dataset, datasetCase)).join('');
  const freezeIssues = options.freezeIssues === undefined || options.freezeIssues.length === 0
    ? ''
    : `<div class="alert alert-error" role="alert"><strong>Freeze is blocked.</strong>
<ul>${options.freezeIssues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul></div>`;

  const released = dataset.releasedAt !== null
    && dataset.lockedProtocolRef !== null && dataset.lockedProtocolRef === dataset.studyProtocolRef;
  const release = releasePanel(user, dataset, released);

  const freeze = dataset.status === 'draft'
    ? `<section class="panel pad">
    <h2>Freeze this revision</h2>
    <p class="muted small">Freeze pins every signed-off case, key, submission source, and recorded study run. A correction creates a new revision.</p>
    <form method="post" action="/datasets/${escapeHtml(dataset.id)}/freeze">
      <input type="hidden" name="_csrf" value="${escapeHtml(user.csrfToken)}">
      <button class="primary" type="submit">Freeze revision</button>
    </form>
  </section>`
    : '';

  const body = `<div class="head">
  <div>
    <h1>${escapeHtml(dataset.datasetId)}</h1>
    <p class="muted">Revision ${escapeHtml(dataset.packageRevision)} · <span class="tag ${dataset.status === 'frozen' ? 'ok' : 'warn'}">${escapeHtml(dataset.status)}</span>
    ${released ? '<span class="tag info">held-out released</span>' : ''}</p>
  </div>
  <a class="button" href="/datasets">All datasets</a>
</div>
${noticeBlock(options.notice)}
${freezeIssues}
<div class="split">
  <div class="stack">
    ${cases}
  </div>
  <div class="stack">
    <section class="panel">
      <div class="panel-top"><h2>Coverage</h2><span class="tag">${dataset.cases.length} cases</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Split</th><th>Format</th><th>Clean</th><th>Fixed</th><th>Partial</th></tr></thead>
        <tbody>${coverageRows}</tbody>
      </table></div>
      <div class="pad small muted">
        <p>Clean = clean single. Fixed = targeted fix leaves it clean. Partial = targeted fix leaves an unrelated error.</p>
        <p>Imported ${timestamp(dataset.importedAt)} by ${escapeHtml(dataset.importedBy.email)}.${dataset.frozenAt === null ? '' : ` Frozen ${timestamp(dataset.frozenAt)} by ${escapeHtml(dataset.frozenBy?.email ?? '')}.`}</p>
        <p class="prewrap">Package digest <span class="mono">${escapeHtml(dataset.packageDigest)}</span></p>
      </div>
    </section>
    ${freeze}
    ${release}
  </div>
</div>`;

  return shell({ title: `${dataset.datasetId} · ${dataset.packageRevision}`, user, body });
}

function releasePanel(user: SessionUser, dataset: DatasetRevisionDetail, released: boolean): string {
  if (dataset.status !== 'frozen') return '';
  if (released) {
    return `<section class="panel pad">
    <h2>Held-out cases released</h2>
    <p class="small muted">Protocol <span class="mono">${escapeHtml(dataset.studyProtocolRef)}</span> · ${timestamp(dataset.releasedAt)} · ${escapeHtml(dataset.releasedBy?.email ?? '')}</p>
  </section>`;
  }
  if (dataset.lockedProtocolRef === null || dataset.releasedAt !== null) {
    return `<section class="panel pad">
    <h2>Held-out cases locked</h2>
    <p class="muted small">Waiting for a matching study-protocol lock from #12.</p>
  </section>`;
  }
  return `<section class="panel pad">
    <h2>Release held-out cases</h2>
    <p class="muted small">#12 locked protocol <span class="mono">${escapeHtml(dataset.lockedProtocolRef)}</span> for this revision. Pilot access always excludes held-out cases.</p>
    <form method="post" action="/datasets/${escapeHtml(dataset.id)}/release" class="stack">
      <input type="hidden" name="_csrf" value="${escapeHtml(user.csrfToken)}">
      <input type="hidden" name="studyProtocolRef" value="${escapeHtml(dataset.lockedProtocolRef)}">
      <div><button class="primary" type="submit">Release held-out split</button></div>
    </form>
  </section>`;
}

function caseCard(
  user: SessionUser,
  dataset: DatasetRevisionDetail,
  datasetCase: DatasetCaseDetail,
): string {
  const submissions = datasetCase.submissions.map((submission) => submissionRow(
    user,
    dataset,
    datasetCase,
    submission,
  )).join('');
  const signoff = datasetCase.signoff === null
    ? `<form method="post" action="/datasets/${escapeHtml(dataset.id)}/sign-off" class="stack">
        <input type="hidden" name="_csrf" value="${escapeHtml(user.csrfToken)}">
        <input type="hidden" name="caseKey" value="${escapeHtml(datasetCase.caseKey)}">
        <label class="small">Evidence checked
          <input name="evidenceNote" required placeholder="Rubric, source lines, and study test results reviewed">
        </label>
        <div><button type="submit">Sign off case</button></div>
      </form>`
    : `<span class="tag ok">Signed off</span> <span class="small muted">${escapeHtml(datasetCase.signoff.email)} · ${timestamp(datasetCase.signoff.signedAt)} · ${escapeHtml(datasetCase.signoff.evidenceNote)}</span>`;
  const targeted = datasetCase.pairTargetedErrorIds === null
    ? ''
    : `<p class="small muted">Targeted: <span class="mono">${escapeHtml(datasetCase.pairTargetedErrorIds.join(', '))}</span></p>`;
  const checks = datasetCase.authoringChecks.length === 0
    ? ''
    : `<h3>Authoring checks</h3><ul class="small">${datasetCase.authoringChecks.map((check) =>
        `<li>${escapeHtml(check.id)} (${escapeHtml(check.status)}): ${escapeHtml(check.note)}</li>`).join('')}</ul>`;
  const rubric = datasetCase.assignment.rubric.map((criterion) => `<li><strong>${escapeHtml(criterion.id)}</strong> ${escapeHtml(criterion.description)} — ${escapeHtml(criterion.expectedBehavior)}</li>`).join('');
  const tests = datasetCase.assignment.tests.map((test) => `<li class="mono">${escapeHtml(test.id)}${test.stdin === undefined
    ? ` · args ${escapeHtml(test.argumentsJson)} · expected ${escapeHtml(test.expectedReturnJson)}`
    : ` · stdin ${escapeHtml(JSON.stringify(test.stdin))} · expected stdout ${escapeHtml(JSON.stringify(test.expectedStdout))}`}</li>`).join('');

  return `<section class="panel">
    <div class="panel-top">
      <div><h2 class="mono">${escapeHtml(datasetCase.caseKey)}</h2><span class="small muted">${escapeHtml(datasetCase.split)} · ${escapeHtml(datasetCase.format)} · ${escapeHtml(datasetCase.assignment.title)}</span></div>
      <div class="actions">${signoff}</div>
    </div>
    <div class="pad">
    <details><summary class="small"><strong>Task, rubric, and supplied study tests</strong></summary>
      <p class="end">${escapeHtml(datasetCase.assignment.description)}</p>
      ${datasetCase.packageAssignmentRevision === null ? '' : `<p class="small">Package assignment revision ${escapeHtml(datasetCase.packageAssignmentRevision)}</p>`}
      ${datasetCase.assignment.entryPoint === null ? '' : `<p class="small">Entry point <span class="mono">${escapeHtml(datasetCase.assignment.entryPoint)}</span></p>`}
      <ul class="small">${rubric}</ul>
      <ul class="small">${tests}</ul>
    </details>
    ${targeted}${checks}
    ${submissions}
    </div>
  </section>`;
}

function submissionRow(
  user: SessionUser,
  dataset: DatasetRevisionDetail,
  datasetCase: DatasetCaseDetail,
  submission: DatasetSubmissionDetail,
): string {
  const attempts = submission.attempts.length === 0
    ? '<span class="small muted">No study run yet</span>'
    : submission.attempts.map((attempt) => `<div class="small">Attempt ${attempt.attemptNumber}: <a href="/runs/${escapeHtml(attempt.runId)}" class="mono">${escapeHtml(attempt.runId.slice(0, 8))}</a> · ${escapeHtml(attempt.runStatus)} · ${attempt.resolvedCount}/${attempt.testCount} recorded</div>`).join('');
  const frozen = submission.frozenRunId === null
    ? ''
    : `<div class="small"><span class="tag ok">Pinned run</span> <a href="/runs/${escapeHtml(submission.frozenRunId)}" class="mono">${escapeHtml(submission.frozenRunId.slice(0, 8))}</a></div>`;
  const launch = dataset.status === 'draft' && (submission.attempts.at(-1)?.runStatus ?? 'incomplete') === 'incomplete'
    ? `<form method="post" action="/datasets/${escapeHtml(dataset.id)}/runs">
        <input type="hidden" name="_csrf" value="${escapeHtml(user.csrfToken)}">
        <input type="hidden" name="submissionId" value="${escapeHtml(submission.id)}">
        <button type="submit">Record study run</button>
      </form>`
    : '';
  const key = submission.key.clean
    ? '<span class="tag ok">Clean</span>'
    : `<span class="tag warn">${submission.key.errors.length} expected error${submission.key.errors.length === 1 ? '' : 's'}</span>`;
  const errors = submission.key.errors.length === 0
    ? ''
    : `<ul class="small">${submission.key.errors.map((error) => `<li><span class="mono">${escapeHtml(error.id)}</span> (${escapeHtml(error.requirement)}): ${escapeHtml(error.note)}
      <ul>${error.evidence.map((item) => item.kind === 'test'
        ? `<li>Study test: ${escapeHtml(item.testId)}</li>`
        : `<li>Source lines ${item.startLine}–${item.endLine} (${escapeHtml(item.path)})</li>`).join('')}</ul></li>`).join('')}</ul>`;

  return `<div class="row-card">
    <div class="row-head">
      <div>
        <span class="row-title">${escapeHtml(submission.version)}</span>
        <span class="mono small">${escapeHtml(submission.path)}</span>
      </div>
      <div class="actions">${key}${launch}</div>
    </div>
    ${errors}
    ${attempts}
    ${frozen}
    <p class="small muted prewrap">Source SHA-256 <span class="mono">${escapeHtml(submission.sha256)}</span> · ${escapeHtml(datasetCase.format)}</p>
    <details><summary class="small"><strong>Exact source</strong></summary><pre class="code">${escapeHtml(submission.source)}</pre></details>
  </div>`;
}
