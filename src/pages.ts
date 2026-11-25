import type { SessionUser } from './auth';
import { COMPARISON_RULE, MAX_CONFIG_MIB, MAX_ROWS_PER_LIST, type ConfigErrors, type RawConfig } from './config';
import { repeatableRowsScript } from './editor-script';
import { escapeHtml, shell } from './html';
import { MAX_JSON_DEPTH, formatJsonForDisplay, parseJsonValue } from './json';
import type {
  AssignmentSummary,
  AssignmentVersionDetail,
  AssignmentVersionSummary,
} from './repository';

export function libraryPage(user: SessionUser, assignments: AssignmentSummary[]): string {
  const body = `<div class="head">
  <div><h1>Assignments</h1><p class="muted">Choose a Python function assignment to review, edit, or inspect its saved versions.</p></div>
  <a class="button primary" href="/assignments/new">Configure assignment</a>
</div>
${assignments.length === 0 ? emptyLibrary() : libraryTable(assignments)}`;

  return shell({ title: 'Assignments', user, body });
}

function emptyLibrary(): string {
  return `<section class="panel pad">
  <h2>No assignments yet</h2>
  <p class="muted">The shared library is empty. Configure the first function assignment with a task description, rubric, and tests.</p>
  <p class="end"><a class="button primary" href="/assignments/new">Configure your first assignment</a></p>
</section>`;
}

function libraryTable(assignments: AssignmentSummary[]): string {
  const rows = assignments
    .map(
      (assignment) => `<tr>
  <td><a href="/assignments/${escapeHtml(assignment.id)}">${escapeHtml(assignment.title)}</a><br><span class="small">Function assignment · active version ${assignment.versionNumber}</span></td>
  <td>${plural(assignment.criteriaCount, 'criterion', 'criteria')}</td>
  <td>${plural(assignment.testsCount, 'test')}</td>
  <td class="compact small">${escapeHtml(formatTimestamp(assignment.updatedAt))}</td>
  <td class="compact"><a href="/assignments/${escapeHtml(assignment.id)}">Open →</a></td>
</tr>`,
    )
    .join('');

  return `<section class="panel">
  <div class="panel-top"><h2>Assignment library</h2><span class="tag">${plural(assignments.length, 'assignment')}</span></div>
  <div class="table-wrap"><table>
    <thead><tr><th>Assignment</th><th>Rubric</th><th>Tests</th><th>Updated</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</section>`;
}

export interface AssignmentFormPageOptions {
  user: SessionUser;
  mode: 'create' | 'edit';
  assignmentId?: string;
  raw: RawConfig;
  baseVersionId?: string;
  errors?: ConfigErrors;
  conflict?: boolean;
}

export function assignmentFormPage({
  user,
  mode,
  assignmentId = '',
  raw,
  baseVersionId,
  errors = {},
  conflict,
}: AssignmentFormPageOptions): string {
  const isEdit = mode === 'edit';
  const missingBase = isEdit && baseVersionId === undefined;
  const formTarget = isEdit ? `/assignments/${assignmentId}` : '/assignments';
  const criteria = raw.criteria.length === 0 ? [blankCriterion()] : raw.criteria;
  const tests = raw.tests.length === 0 ? [blankTest()] : raw.tests;
  const hasErrors =
    errors.title !== undefined ||
    errors.description !== undefined ||
    errors.entryPoint !== undefined ||
    errors.criteria !== undefined ||
    errors.tests !== undefined ||
    errors.form !== undefined;

  const body = `<div class="head">
  <div>
    <h1>${isEdit ? 'Edit function assignment' : 'Configure function assignment'}</h1>
    <p class="muted">Define the task, the ordered rubric, and the ordered tests. Each save creates immutable versions.</p>
  </div>
  ${missingBase ? '' : `<button class="primary" type="submit" form="assignment-form">${isEdit ? 'Save changes' : 'Save assignment'}</button>`}
</div>
${conflict ? conflictBanner(assignmentId) : ''}
${missingBase ? `<div class="alert alert-warn" role="alert">
  This draft has no base version and cannot be saved. Your input has been kept.
  <a href="${escapeHtml(formTarget)}/edit" target="_blank" rel="noopener">Open the active version</a> in a new tab, then reapply your changes.
</div>` : ''}
${hasErrors ? '<div class="alert alert-error" role="alert">Fix the highlighted fields and try again. Nothing was saved.</div>' : ''}
${errors.form === undefined ? '' : `<div class="alert alert-error" role="alert">${escapeHtml(errors.form)}</div>`}
<form id="assignment-form" method="post" action="${escapeHtml(formTarget)}">
  <input type="hidden" name="_csrf" value="${escapeHtml(user.csrfToken)}">
  ${isEdit && baseVersionId !== undefined ? `<input type="hidden" name="baseVersionId" value="${escapeHtml(baseVersionId)}">` : ''}
  <div class="split">
    <div class="stack">
      <section class="panel pad fields" aria-label="Task details">
        <label class="wide${errors.title === undefined ? '' : ' has-error'}">Assignment title
          <textarea name="title" rows="1" required>
${escapeHtml(raw.title)}</textarea>
          ${fieldError(errors.title)}
        </label>
        <label class="wide${errors.description === undefined ? '' : ' has-error'}">Task description
          <textarea name="description" required>
${escapeHtml(raw.description)}</textarea>
          ${fieldError(errors.description)}
        </label>
        <label class="wide${errors.entryPoint === undefined ? '' : ' has-error'}">Python entry point
          <input name="entryPoint" value="${escapeHtml(raw.entryPoint)}" placeholder="first_positive" required>
          <span class="hint">The function name only, such as <code>first_positive</code>. Do not enter a signature or expression.</span>
          ${fieldError(errors.entryPoint)}
        </label>
      </section>
      <section class="panel" aria-label="Rubric criteria">
        <div class="panel-top"><h2>Rubric</h2><button type="button" data-add="criteria">Add criterion</button></div>
        ${errors.criteria?.message === undefined ? '' : `<div class="pad"><p class="field-error">${escapeHtml(errors.criteria.message)}</p></div>`}
        <div data-rows="criteria">
          ${criteria.map((criterion, index) => criterionRow(criterion, index, errors.criteria?.rows[index] ?? {})).join('')}
        </div>
        <div class="pad"><p class="hint">Criteria keep the order shown. Use the same ID when revising a criterion; renaming an ID adds a new criterion and leaves the historical one untouched. Use up to ${MAX_ROWS_PER_LIST} criteria.</p></div>
      </section>
    </div>
    <div class="stack">
      <section class="panel" aria-label="Function tests">
        <div class="panel-top"><h2>Tests</h2><button type="button" data-add="tests">Add test</button></div>
        ${errors.tests?.message === undefined ? '' : `<div class="pad"><p class="field-error">${escapeHtml(errors.tests.message)}</p></div>`}
        <div data-rows="tests">
          ${tests.map((test, index) => testRow(test, index, errors.tests?.rows[index] ?? {})).join('')}
        </div>
        <div class="pad"><p class="hint">Arguments are a JSON array: <code>[]</code> supplies none, <code>[4, -1]</code> supplies two, and <code>[[4, -1]]</code> supplies one list argument. Expected return is a separate JSON value; <code>null</code> means Python <code>None</code>. Use up to ${MAX_ROWS_PER_LIST} tests and ${MAX_JSON_DEPTH} levels of JSON nesting.</p></div>
      </section>
      <section class="panel pad">
        <h2>Save behavior</h2>
        <p class="muted small">Saving unchanged content creates no version. If another researcher saves first, this form will keep your edits and explain the conflict instead of overwriting their version.</p>
        <p class="hint">Saved text and compact JSON together can use up to ${MAX_CONFIG_MIB} MiB.</p>
        <div class="actions end">
          <a class="button" href="${escapeHtml(formTarget)}">Cancel</a>
        </div>
      </section>
    </div>
  </div>
</form>
<template id="criteria-template">${criterionRow(blankCriterion(), '__INDEX__', {})}</template>
<template id="tests-template">${testRow(blankTest(), '__INDEX__', {})}</template>
<script>${repeatableRowsScript}</script>`;

  return shell({
    title: isEdit ? 'Edit assignment' : 'Configure assignment',
    user,
    body,
  });
}

function conflictBanner(assignmentId: string): string {
  return `<div class="alert alert-warn" role="alert">
  <strong>A newer version of this assignment was saved while you were editing.</strong>
  Your unsaved changes are still in this form and have not been overwritten. Nothing was saved.
  <a href="/assignments/${escapeHtml(assignmentId)}" target="_blank" rel="noopener">Open the latest version</a> in a new tab to review it, then reapply your changes.
</div>`;
}

function criterionRow(
  criterion: { id: string; description: string; expectedBehavior: string },
  index: number | '__INDEX__',
  rowErrors: Record<string, string>,
): string {
  return `<div class="row-card" data-row>
  <div class="row-head"><span class="row-title">Criterion</span><button type="button" class="link-button remove-row" data-remove>Remove</button></div>
  <div class="row-grid">
    <label>ID
      <input name="criteria[${index}][id]" value="${escapeHtml(criterion.id)}" placeholder="r1">
      ${fieldError(rowErrors.id)}
    </label>
    <label>Description
      <textarea name="criteria[${index}][description]">
${escapeHtml(criterion.description)}</textarea>
      ${fieldError(rowErrors.description)}
    </label>
    <label>Expected behavior
      <textarea name="criteria[${index}][expectedBehavior]">
${escapeHtml(criterion.expectedBehavior)}</textarea>
      ${fieldError(rowErrors.expectedBehavior)}
    </label>
  </div>
</div>`;
}

function testRow(
  test: { id: string; arguments: string; expectedReturn: string },
  index: number | '__INDEX__',
  rowErrors: Record<string, string>,
): string {
  return `<div class="row-card" data-row>
  <div class="row-head"><span class="row-title">Test</span><button type="button" class="link-button remove-row" data-remove>Remove</button></div>
  <div class="row-grid tests">
    <label>ID
      <input name="tests[${index}][id]" value="${escapeHtml(test.id)}" placeholder="t1">
      ${fieldError(rowErrors.id)}
    </label>
    <label>Positional arguments (JSON array)
      <textarea name="tests[${index}][arguments]" class="mono" placeholder="[[4, -1]]">
${escapeHtml(test.arguments)}</textarea>
      ${fieldError(rowErrors.arguments)}
    </label>
    <label>Expected return (JSON value)
      <textarea name="tests[${index}][expectedReturn]" class="mono" placeholder="4">
${escapeHtml(test.expectedReturn)}</textarea>
      ${fieldError(rowErrors.expectedReturn)}
    </label>
  </div>
</div>`;
}

function fieldError(message: string | undefined): string {
  return message === undefined ? '' : `<p class="field-error">${escapeHtml(message)}</p>`;
}

function blankCriterion(): { id: string; description: string; expectedBehavior: string } {
  return { id: '', description: '', expectedBehavior: '' };
}

function blankTest(): { id: string; arguments: string; expectedReturn: string } {
  return { id: '', arguments: '', expectedReturn: '' };
}

export interface AssignmentDetailPageOptions {
  user: SessionUser;
  version: AssignmentVersionDetail;
  notice?: string;
  isActive?: boolean;
}

export function assignmentDetailPage({
  user,
  version,
  notice,
  isActive = true,
}: AssignmentDetailPageOptions): string {
  const base = escapeHtml(`/assignments/${version.assignmentId}`);
  const body = `<div class="head">
  <div>
    <h1>${escapeHtml(version.title)}</h1>
    <p class="muted">Version ${version.versionNumber} · Function assignment · saved by ${escapeHtml(version.createdBy.email)} on ${escapeHtml(formatTimestamp(version.createdAt))}</p>
  </div>
  <div class="actions">
    ${isActive ? `<a class="button primary" href="${base}/edit?version=${encodeURIComponent(version.id)}">Edit assignment</a>` : ''}
    <a class="button" href="${base}/history">Version history</a>
    <a class="button" href="/assignments">Library</a>
  </div>
</div>
${notice === undefined ? '' : `<div class="alert alert-ok" role="status">${escapeHtml(notice)}</div>`}
${isActive ? '<div class="banner ok"><span>This is the active version.</span><a href="' + base + '/history">View saved versions</a></div>' : '<div class="banner"><span>This is a read-only historical version. It is not the active version.</span><a href="' + base + '">Open the active version</a></div>'}
<div class="meta-grid end">
  <div class="metric"><span class="small">Rubric</span><strong>${plural(version.criteria.length, 'criterion', 'criteria')}</strong><span class="small mono">${escapeHtml(version.rubricVersionId)}</span></div>
  <div class="metric"><span class="small">Tests</span><strong>${plural(version.tests.length, 'test')}</strong><span class="small mono">${escapeHtml(version.testSuiteVersionId)}</span></div>
  <div class="metric"><span class="small">Entry point</span><strong class="mono">${escapeHtml(version.entryPoint)}</strong><span class="small">Returns a value</span></div>
</div>
<div class="stack end">
  <section class="panel pad">
    <h2>Task description</h2>
    <p class="prewrap">${escapeHtml(version.description)}</p>
  </section>
  <section class="panel">
    <div class="panel-top"><h2>Rubric · version ${escapeHtml(shortId(version.rubricVersionId))}</h2><span class="tag">${plural(version.criteria.length, 'criterion', 'criteria')}</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>ID</th><th>Description</th><th>Expected behavior</th></tr></thead>
      <tbody>${version.criteria
        .map(
          (criterion, index) => `<tr>
        <td>${index + 1}</td>
        <td><code>${escapeHtml(criterion.id)}</code></td>
        <td>${escapeHtml(criterion.description)}</td>
        <td>${escapeHtml(criterion.expectedBehavior)}</td>
      </tr>`,
        )
        .join('')}</tbody>
    </table></div>
  </section>
  <section class="panel">
    <div class="panel-top"><h2>Tests · version ${escapeHtml(shortId(version.testSuiteVersionId))}</h2><span class="tag">${COMPARISON_RULE}</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>ID</th><th>Positional arguments</th><th>Expected return</th></tr></thead>
      <tbody>${version.tests
        .map(
          (test, index) => `<tr>
        <td>${index + 1}</td>
        <td><code>${escapeHtml(test.id)}</code></td>
        <td><code>${escapeHtml(formatJsonForDisplay(parseJsonValue(test.argumentsJson)))}</code></td>
        <td><code>${escapeHtml(formatJsonForDisplay(parseJsonValue(test.expectedReturnJson)))}</code></td>
      </tr>`,
        )
        .join('')}</tbody>
    </table></div>
  </section>
  <section class="panel pad">
    <h2>Version references</h2>
    <div class="fields">
      <label>Rubric version ID<input class="mono" value="${escapeHtml(version.rubricVersionId)}" readonly></label>
      <label>Test suite version ID<input class="mono" value="${escapeHtml(version.testSuiteVersionId)}" readonly></label>
      <label>Assignment version ID<input class="mono" value="${escapeHtml(version.id)}" readonly></label>
      <label>Comparison rule<input value="${COMPARISON_RULE}" readonly></label>
    </div>
  </section>
</div>`;

  return shell({
    title: version.title,
    user,
    body,
  });
}

export function historyPage(
  user: SessionUser,
  assignmentId: string,
  versions: AssignmentVersionSummary[],
): string {
  const rows = versions
    .map(
      (version) => `<tr>
  <td><a href="/assignments/${escapeHtml(assignmentId)}/versions/${escapeHtml(version.id)}">Version ${version.versionNumber}</a></td>
  <td>${escapeHtml(version.title)}</td>
  <td>${escapeHtml(version.createdBy.email)}</td>
  <td class="compact small">${escapeHtml(formatTimestamp(version.createdAt))}</td>
  <td>${version.isActive ? '<span class="tag ok">Active</span>' : '<span class="tag">Historical</span>'}</td>
</tr>`,
    )
    .join('');

  const body = `<div class="head">
  <div><h1>Version history</h1><p class="muted">Newest first. Historical versions are read-only and keep their exact rubric and tests.</p></div>
  <div class="actions"><a class="button" href="/assignments/${escapeHtml(assignmentId)}">Open active version</a><a class="button" href="/assignments">Library</a></div>
</div>
<section class="panel">
  <div class="panel-top"><h2>Saved versions</h2><span class="tag">${plural(versions.length, 'version')}</span></div>
  <div class="table-wrap"><table>
    <thead><tr><th>Version</th><th>Title</th><th>Saved by</th><th>Saved</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</section>`;

  return shell({ title: 'Version history', user, body });
}

export function formatTimestamp(iso: string): string {
  return `${iso.replace('T', ' ').slice(0, 16)} UTC`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}
