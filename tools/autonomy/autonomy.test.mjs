import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chooseWork, chooseRetry, reconcile, replaceStatus, runTitle, latestReview, ciGreen, requiredCiState, validateConfig, reviewDisagreement, reviewResolution } from './policy.mjs';
import { coordinate, validateState } from './coordinator.mjs';
import { authorize, assertTaskSpecUnchanged, assertReviewResolutionUnchanged } from './worker.mjs';
import { GitHub } from './github.mjs';
import { parseArgs } from './run.mjs';

const now = Date.parse('2026-09-12T12:00:00Z');
const id = '00000000-0000-0000-0000-000000000001';
const sha = 'a'.repeat(40);
function fixture() {
  const config = JSON.parse(readFileSync(new URL('../../automation/config.json', import.meta.url)));
  config.enabled = true;
  config.reviewers = ['review-bot'];
  config.projects = { repomanager: config.projects.repomanager };
  const project = { id: 'repomanager', repository: 'Owner/Repo', enabled: true, maxActiveTasks: 1, relativePath: 'projects/repomanager/project.yaml' };
  const task = { id: 'RM-001', projectId: project.id, priority: 100, status: 'ready', dependsOn: [], relativePath: 'projects/repomanager/tasks/RM-001.md' };
  const catalog = { projects: [project], tasks: [task] };
  const state = { version: 1, executions: [] };
  const snapshot = { prs: [], runs: [], reviews: {}, checks: {}, comments: {} };
  const taskTexts = { [task.relativePath]: '---\r\nid: RM-001\r\nstatus: ready\r\npriority: 100\r\ndepends_on: []\r\n---\r\n## Goal\r\nKeep this exact body.\r\nstatus: ready\r\n' };
  const calls = [];
  const api = {
    snapshot: async () => structuredClone(snapshot),
    commitFiles: async (...args) => { calls.push(['commit', ...args]); return 'b'.repeat(40); },
    dispatch: async (...args) => { calls.push(['dispatch', ...args]); return null; },
  };
  return { config, catalog, state, snapshot, taskTexts, api, calls, now, sourceSha: sha, newId: () => id };
}
function record() {
  return { projectId: 'repomanager', repository: 'Owner/Repo', taskId: 'RM-001', status: 'in_progress', attempts: [
    { id, kind: 'implementation', startedAt: new Date(now - 60000).toISOString(), sourceControlSha: sha, dispatchStatus: 'sent' },
  ] };
}
function pr(extra = {}) {
  return { number: 1, state: 'open', labels: [{ name: 'autonomous' }], user: { login: 'worker-bot' }, head: { ref: 'autonomous/RM-001', sha, repo: { full_name: 'Owner/Repo' } },
    base: { ref: 'master' }, html_url: 'https://github.com/Owner/Repo/pull/1', ...extra };
}
const completed = extra => ({ id: 8, display_title: runTitle('RM-001', id), status: 'completed', conclusion: 'success',
  updated_at: new Date(now).toISOString(), html_url: 'https://github.com/Owner/Repo/actions/runs/8', ...extra });
const select = f => chooseWork(f.catalog, f.state, { repomanager: f.snapshot }, f.config, now);
function failedCorrectionFixture() {
  const f = fixture();
  f.catalog.tasks[0].status = 'blocked';
  f.taskTexts[f.catalog.tasks[0].relativePath] = Object.values(f.taskTexts)[0].replace('status: ready', 'status: blocked');
  f.snapshot.prs = [pr({ draft: false })];
  f.snapshot.checks[1] = [{ id: 11, name: 'build-and-test', status: 'completed', conclusion: 'success' }];
  f.snapshot.reviews[1] = [{ id: 12, user: { login: 'review-bot' }, commit_id: sha,
    state: 'CHANGES_REQUESTED', submitted_at: new Date(now).toISOString() }];
  const e = { ...record(), status: 'blocked', blockReason: 'worker_failure', pr: 1 };
  e.attempts.push({ id: '00000000-0000-0000-0000-000000000099', kind: 'correction',
    startedAt: new Date(now - 30000).toISOString(), sourceControlSha: sha,
    dispatchStatus: 'sent', runId: 9, conclusion: 'failure', completedAt: new Date(now).toISOString(),
    reviewId: 12, headSha: sha });
  f.state.executions = [e];
  return f;
}

function disagreementFixture() {
  const f = failedCorrectionFixture(), e = f.state.executions[0], attempt = e.attempts.at(-1);
  e.blockReason = 'correction_did_not_advance_head';
  attempt.conclusion = 'success';
  attempt.completedAt = new Date(now - 10000).toISOString();
  attempt.runUrl = 'https://github.com/Owner/Repo/actions/runs/9';
  attempt.startedAt = new Date(now - 60000).toISOString();
  f.newId = () => '00000000-0000-0000-0000-000000000002';
  f.snapshot.prs[0].user = { login: 'autonomousworkdispatcher[bot]', id: 777, type: 'Bot' };
  f.snapshot.runs = [completed({ id: 9, display_title: runTitle('RM-001', attempt.id), run_attempt: 1,
    event: 'workflow_dispatch', path: '.github/workflows/autonomous-worker.yml', head_branch: 'master',
    repository: { full_name: 'Owner/Repo' }, head_repository: { full_name: 'Owner/Repo' },
    run_started_at: new Date(now - 55000).toISOString(), updated_at: attempt.completedAt,
    html_url: attempt.runUrl })];
  f.snapshot.comments[1] = [{ id: 99, user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
    performed_via_github_app: { id: 15368, slug: 'github-actions' },
    body: '<!-- autonomous-review-disagreement:v1 -->\nReview-ID: 12\nReviewed-SHA: ' + sha + '\nReason: Requires human resolution.',
    created_at: new Date(now - 20000).toISOString(), updated_at: new Date(now - 20000).toISOString(),
    issue_url: 'https://api.github.com/repos/Owner/Repo/issues/1',
    html_url: 'https://github.com/Owner/Repo/pull/1#issuecomment-99' }];
  f.reviewRecovery = { taskId: 'RM-001', reviewId: 12, headSha: sha,
    resolutionUrl: 'https://github.com/Owner/Repo/pull/1#issuecomment-100' };
  f.snapshot.comments[1].push({ id: 100, user: { login: 'review-bot', id: 123, type: 'User' },
    body: 'Keep the handler and tests. Defer the mutating route until lifecycle integration. Normal CI and review still apply.',
    created_at: new Date(now - 1000).toISOString(), updated_at: new Date(now - 1000).toISOString(),
    issue_url: 'https://api.github.com/repos/Owner/Repo/issues/1', html_url: f.reviewRecovery.resolutionUrl });
  return f;
}

test('disabled global switch and unenrolled project cannot dispatch', () => {
  const f = fixture(); f.config.enabled = false; assert.equal(select(f), null);
  f.config.enabled = true; f.config.projects = {}; assert.equal(select(f), null);
});
test('project pause, unfinished dependency, and draft each prevent selection', () => {
  for (const change of [f => f.catalog.projects[0].enabled = false, f => f.catalog.tasks[0].dependsOn = ['RM-002'], f => f.catalog.tasks[0].status = 'draft']) {
    const f = fixture(); change(f); assert.equal(select(f), null);
  }
});
test('active workflow and unlabeled autonomous PR each prevent overlap', () => {
  const f = fixture(); f.snapshot.runs = [{ status: 'queued' }]; assert.equal(select(f), null);
  f.snapshot.runs = []; f.snapshot.prs = [pr({ labels: [] })]; assert.equal(select(f), null);
});
test('closed historical task PR is never silently reopened or reimplemented', () => {
  const f = fixture(); f.snapshot.prs = [pr({ state: 'closed' })]; assert.equal(select(f), null);
});
test('blocked recorded work holds a project even with no PR', () => {
  const f = fixture(); f.state.executions = [{ ...record(), status: 'blocked' }]; assert.equal(select(f), null);
});

test('explicit retry selects only an observed retryable blocked implementation', () => {
  const f = fixture();
  f.catalog.tasks[0].status = 'blocked';
  const e = { ...record(), status: 'blocked', blockReason: 'worker_failure' };
  e.attempts[0] = { ...e.attempts[0], runId: 8, conclusion: 'failure', completedAt: new Date(now).toISOString() };
  f.state.executions = [e];
  assert.equal(chooseRetry('RM-001', f.catalog, f.state, { repomanager: f.snapshot }, f.config, now).retry, true);

  e.blockReason = 'merge_conflict';
  assert.equal(chooseRetry('RM-001', f.catalog, f.state, { repomanager: f.snapshot }, f.config, now), null);
});

test('explicit retry allows the same task partial PR but rejects other active autonomous work', () => {
  const f = fixture();
  f.catalog.tasks[0].status = 'blocked';
  const e = { ...record(), status: 'blocked', blockReason: 'worker_failure' };
  e.attempts[0] = { ...e.attempts[0], runId: 8, conclusion: 'failure', completedAt: new Date(now).toISOString() };
  f.state.executions = [e];
  f.snapshot.prs = [pr({ draft: true })];
  assert.equal(chooseRetry('RM-001', f.catalog, f.state, { repomanager: f.snapshot }, f.config, now).pr, 1);
  f.snapshot.prs.push({ ...pr({ number: 2 }), head: { ref: 'autonomous/OTHER-001', sha, repo: { full_name: 'Owner/Repo' } } });
  assert.equal(chooseRetry('RM-001', f.catalog, f.state, { repomanager: f.snapshot }, f.config, now), null);
});
test('failed correction retry preserves the exact trusted review and head', () => {
  const f = failedCorrectionFixture();
  const selected = chooseRetry('RM-001', f.catalog, f.state, { repomanager: f.snapshot }, f.config, now);
  assert.equal(selected.kind, 'correction');
  assert.equal(selected.retry, true);
  assert.equal(selected.pr, 1);
  assert.equal(selected.reviewId, 12);
  assert.equal(selected.headSha, sha);
});

test('failed correction retry fails closed when review, head or CI changes', () => {
  for (const change of [
    f => { f.snapshot.prs[0].head.sha = 'b'.repeat(40); },
    f => { f.snapshot.prs[0].draft = true; },
    f => { f.snapshot.reviews[1] = [{ id: 13, user: { login: 'review-bot' }, commit_id: sha,
      state: 'APPROVED', submitted_at: new Date(now + 1000).toISOString() }]; },
    f => { f.snapshot.reviews[1][0].user.login = 'untrusted'; },
    f => { f.snapshot.checks[1][0].conclusion = 'failure'; },
    f => { f.snapshot.runs = [{ status: 'in_progress' }]; },
    f => { f.state.executions[0].blockReason = 'correction_did_not_advance_head'; },
    f => { f.state.executions[0].attempts[1].completedAt = null; },
    f => { f.config.maxCorrectionRounds = 1; },
  ]) {
    const f = failedCorrectionFixture(); change(f);
    assert.equal(chooseRetry('RM-001', f.catalog, f.state, { repomanager: f.snapshot }, f.config, now), null);
  }
});

test('automatic recovery creates a new correction claim without reusing the failed run', async () => {
  const f = failedCorrectionFixture();
  const result = await coordinate({ ...f, apply: true });
  const e = result.state.executions[0];
  assert.equal(e.status, 'in_progress');
  assert.equal(e.blockReason, null);
  assert.equal(e.attempts.length, 3);
  assert.equal(e.attempts[1].conclusion, 'failure');
  assert.equal(e.attempts[2].kind, 'correction');
  assert.equal(e.attempts[2].reviewId, 12);
  assert.equal(e.attempts[2].headSha, sha);
  assert.deepEqual(f.calls.map(c => c[0]), ['commit', 'dispatch', 'commit']);
  assert.equal(f.calls[1][3].mode, 'correction');
  assert.equal(f.calls[1][3].review_id, '12');
  assert.equal(f.calls[1][3].expected_head, sha);
  assert.notEqual(f.calls[1][3].attempt_id, e.attempts[1].id);
  assert.match(f.calls[0][4][f.catalog.tasks[0].relativePath], /status: in_progress/);
});

test('one blocked project does not starve an available project', () => {
  const f = fixture(); f.catalog.projects.push({ ...f.catalog.projects[0], id: 'other', repository: 'Owner/Other' });
  f.catalog.tasks.push({ ...f.catalog.tasks[0], id: 'OT-001', projectId: 'other', priority: 50 });
  f.config.projects.other = { ...f.config.projects.repomanager };
  const snapshots = { repomanager: { ...f.snapshot, prs: [pr()] }, other: f.snapshot };
  assert.equal(chooseWork(f.catalog, f.state, snapshots, f.config, now).task.id, 'OT-001');
});
test('priority then task ID determines selection', () => {
  const f = fixture(); f.catalog.tasks.push({ ...f.catalog.tasks[0], id: 'RM-002', priority: 200 });
  assert.equal(select(f).task.id, 'RM-002');
  f.catalog.tasks[1].priority = 100; assert.equal(select(f).task.id, 'RM-001');
});
test('unknown or invalid configuration limits fail closed', () => {
  for (const change of [c => c.maxAttempts = 0, c => c.enabled = 'false', c => c.typo = true, c => c.requiredChecks = [],
    c => c.projects.repomanager.allowedTasks = ['RM-001']]) {
    const f = fixture(); change(f.config); assert.throws(() => validateConfig(f.config));
  }
});
test('malformed or duplicate execution state fails validation', () => {
  const f = fixture(); f.state.executions = [record(), record()]; assert.throws(() => validateState(f.catalog, f.state, f.config));
});
test('status transition preserves task body and CRLF, and refuses stale status', () => {
  const f = fixture(), text = Object.values(f.taskTexts)[0];
  const changed = replaceStatus(text, 'ready', 'in_progress');
  assert.equal(changed, text.replace('status: ready', 'status: in_progress'));
  assert.throws(() => replaceStatus(text, 'review', 'done'));
  assert.throws(() => replaceStatus(text, 'ready', 'ready'));
});
test('successful worker plus PR reaches review; approval is not completion', () => {
  const f = fixture(); f.snapshot.prs = [pr()]; f.snapshot.runs = [completed()];
  assert.equal(reconcile(record(), f.snapshot, f.config, now).status, 'review');
});
test('merged PR alone provides durable completion evidence', () => {
  const f = fixture(); f.snapshot.prs = [pr({ state: 'closed', merged_at: new Date(now).toISOString(), merge_commit_sha: 'c'.repeat(40) })];
  const r = reconcile(record(), f.snapshot, f.config, now); assert.equal(r.status, 'done'); assert.equal(r.mergeSha, 'c'.repeat(40));
});
test('closed unmerged, multiple PRs, wrong base, and merge conflicts block', () => {
  for (const prs of [[pr({ state: 'closed' })], [pr(), pr({ number: 2 })], [pr({ base: { ref: 'wrong' } })], [pr({ mergeable: false })]]) {
    const f = fixture(); f.snapshot.prs = prs; assert.equal(reconcile(record(), f.snapshot, f.config, now).status, 'blocked');
  }
});
test('failed worker blocks even if it left a partial PR', () => {
  const f = fixture(); f.snapshot.prs = [pr()]; f.snapshot.runs = [completed({ conclusion: 'failure' })];
  assert.equal(reconcile(record(), f.snapshot, f.config, now).blockReason, 'worker_failure');
});
test('successful worker without PR is a failure', () => {
  const f = fixture(); f.snapshot.runs = [completed()];
  assert.equal(reconcile(record(), f.snapshot, f.config, now).blockReason, 'worker_succeeded_without_pull_request');
});
test('correction that leaves the PR head unchanged blocks instead of deadlocking in review', () => {
  const correctionId = '00000000-0000-0000-0000-000000000002';
  const correctionRecord = () => {
    const e = record();
    e.attempts.push({ id: correctionId, kind: 'correction', startedAt: new Date(now - 60000).toISOString(),
      sourceControlSha: sha, dispatchStatus: 'sent', reviewId: 12, headSha: sha });
    return e;
  };
  const correctionRun = () => completed({ display_title: runTitle('RM-001', correctionId) });
  // Same head SHA as the reviewed commit: the verifier must fail closed so the
  // consumed review ID cannot leave the task stranded in review forever.
  const f = fixture(); f.snapshot.prs = [pr()]; f.snapshot.runs = [correctionRun()];
  const blocked = reconcile(correctionRecord(), f.snapshot, f.config, now);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockReason, 'correction_did_not_advance_head');
  // An advanced head reaches review normally.
  const g = fixture(); g.snapshot.prs = [pr({ head: { ref: 'autonomous/RM-001', sha: 'b'.repeat(40), repo: { full_name: 'Owner/Repo' } } })];
  g.snapshot.runs = [correctionRun()];
  assert.equal(reconcile(correctionRecord(), g.snapshot, f.config, now).status, 'review');
});
test('GitHub Actions disagreement on a dispatcher App PR stops for human resolution', () => {
  const f = disagreementFixture();
  const blocked = reconcile(f.state.executions[0], f.snapshot, f.config, now);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockReason, 'autonomous_review_disagreement');
  assert.equal(blocked.disagreementUrl, 'https://github.com/Owner/Repo/pull/1#issuecomment-99');
});

test('PR-author disagreement remains supported with authenticated identity and run binding', () => {
  const f = disagreementFixture();
  f.snapshot.comments[1][0].user = { ...f.snapshot.prs[0].user };
  delete f.snapshot.comments[1][0].performed_via_github_app;
  assert.equal(reconcile(f.state.executions[0], f.snapshot, f.config, now).blockReason, 'autonomous_review_disagreement');
});

const invalidDisagreements = {
  'arbitrary user': (c) => { c.user = { login: 'attacker', id: 42, type: 'User' }; },
  'forged bot login': (c) => { c.user.id = 42; },
  'wrong bot type': (c) => { c.user.type = 'User'; },
  'missing App provenance': (c) => { delete c.performed_via_github_app; },
  'wrong App': (c) => { c.performed_via_github_app.id = 42; },
  'wrong App slug': (c) => { c.performed_via_github_app.slug = 'other'; },
  'forged PR author login': (c) => { c.user.login = 'autonomousworkdispatcher[bot]'; },
  'wrong review': (c) => { c.body = c.body.replace('Review-ID: 12', 'Review-ID: 13'); },
  'review ID prefix collision': (c) => { c.body = c.body.replace('Review-ID: 12', 'Review-ID: 120'); },
  'wrong SHA': (c) => { c.body = c.body.replace(sha, 'b'.repeat(40)); },
  'SHA suffix': (c) => { c.body = c.body.replace(sha, sha + '0'); },
  'quoted marker': (c) => { c.body = 'Quoted comment:\n' + c.body; },
  'duplicate review field': (c) => { c.body += '\nReview-ID: 13'; },
  'duplicate SHA field': (c) => { c.body += '\nReviewed-SHA: ' + sha; },
  'duplicate marker': (c) => { c.body += '\n<!-- autonomous-review-disagreement:v1 -->'; },
  'wrong PR': (c) => { c.issue_url = 'https://api.github.com/repos/Owner/Repo/issues/2'; },
  'wrong repository': (c) => { c.issue_url = 'https://api.github.com/repos/Other/Repo/issues/1'; },
  'wrong comment URL': (c) => { c.html_url = c.html_url.replace('/pull/1', '/pull/2'); },
  'previous attempt comment': (c) => { c.created_at = c.updated_at = new Date(now - 65000).toISOString(); },
  'after run completion': (c) => { c.created_at = c.updated_at = new Date(now - 5000).toISOString(); },
  'edited after run completion': (c) => { c.updated_at = new Date(now).toISOString(); },
  'missing timestamp': (c) => { delete c.created_at; },
  'missing edit timestamp': (c) => { delete c.updated_at; },
  'non-string body': (c) => { c.body = null; },
};
for (const [name, change] of Object.entries(invalidDisagreements)) {
  test(`unchanged-head correction rejects disagreement with ${name}`, () => {
    const f = disagreementFixture(); change(f.snapshot.comments[1][0]);
    assert.equal(reconcile(f.state.executions[0], f.snapshot, f.config, now).blockReason, 'correction_did_not_advance_head');
  });
}

test('disagreement requires the exact claimed workflow, repository, branch, run and attempt window', () => {
  for (const change of [
    r => { r.path = '.github/workflows/opencode.yml'; },
    r => { r.event = 'pull_request'; },
    r => { r.head_branch = 'other'; },
    r => { r.repository.full_name = 'Other/Repo'; },
    r => { r.head_repository.full_name = 'Other/Repo'; },
    r => { r.run_attempt = 2; },
    r => { r.id = 10; },
    r => { r.display_title = 'unrelated'; },
    r => { r.run_started_at = new Date(now - 65000).toISOString(); },
  ]) {
    const f = disagreementFixture(), run = f.snapshot.runs[0]; change(run);
    assert.equal(reviewDisagreement(f.snapshot.prs[0], f.snapshot.comments[1], 12, sha, {
      attempt: f.state.executions[0].attempts.at(-1), run, repository: 'Owner/Repo', taskId: 'RM-001',
      target: f.config.projects.repomanager, now }), undefined);
  }
});

test('worker verifier accepts the same disagreement while its run is still active', () => {
  const f = disagreementFixture(), run = f.snapshot.runs[0];
  run.status = 'in_progress'; run.conclusion = null;
  assert.equal(reviewDisagreement(f.snapshot.prs[0], f.snapshot.comments[1], '12', sha, {
    attempt: f.state.executions[0].attempts.at(-1), run, repository: 'Owner/Repo', taskId: 'RM-001',
    target: f.config.projects.repomanager, now }).id, 99);
});

test('a different run cannot replace the recorded correction run ID', () => {
  const f = disagreementFixture(); f.snapshot.runs[0].id = 10;
  const blocked = reconcile(f.state.executions[0], f.snapshot, f.config, now);
  assert.equal(blocked.blockReason, 'worker_run_mismatch');
  assert.equal(blocked.attempts.at(-1).runId, 9);
});

test('already-blocked incident is reclassified without automatic recovery or dispatch', async () => {
  const f = disagreementFixture();
  const result = await coordinate({ ...f, reviewRecovery: null, apply: true });
  assert.equal(result.state.executions[0].status, 'blocked');
  assert.equal(result.state.executions[0].blockReason, 'autonomous_review_disagreement');
  assert.equal(result.state.executions[0].disagreementUrl, f.snapshot.comments[1][0].html_url);
  assert.equal(result.selected, null);
  assert.deepEqual(f.calls.map(c => c[0]), ['commit']);
});

test('operator recovery appends a fresh bounded correction, pins the decision, and preserves history', async () => {
  const f = disagreementFixture(), history = structuredClone(f.state.executions[0].attempts);
  const result = await coordinate({ ...f, apply: true });
  const e = result.state.executions[0], next = e.attempts.at(-1);
  assert.deepEqual(e.attempts.slice(0, -1), history);
  assert.equal(e.status, 'in_progress');
  assert.equal(e.blockReason, null);
  assert.equal(next.id, f.newId());
  assert.equal(next.reason, 'operator_review_resolution');
  assert.equal(next.kind, 'correction');
  assert.equal(next.reviewId, 12);
  assert.equal(next.headSha, sha);
  assert.equal(next.operatorResolution.body, f.snapshot.comments[1][1].body);
  assert.equal(next.operatorResolution.url, f.reviewRecovery.resolutionUrl);
  assert.equal(next.runId, undefined);
  assert.deepEqual(f.calls.map(c => c[0]), ['commit', 'dispatch', 'commit']);
  const claim = JSON.parse(f.calls[0][4]['automation/state.json']).executions[0];
  assert.deepEqual(claim.attempts.slice(0, -1), history);
  assert.equal(claim.attempts.at(-1).dispatchStatus, 'pending');
  assert.equal(f.calls[1][3].control_commit, 'b'.repeat(40));
  assert.equal(f.calls[1][3].attempt_id, next.id);
  assert.equal(f.calls[1][3].mode, 'correction');
  assert.equal(f.calls[1][3].review_id, '12');
  assert.equal(f.calls[1][3].expected_head, sha);
  assert.match(f.calls[0][4][f.catalog.tasks[0].relativePath], /status: in_progress/);
  assert.equal(result.reviewQueue.length, 0);
  assert.equal(f.snapshot.reviews[1][0].state, 'CHANGES_REQUESTED');
});

test('a blocked unchanged correction can recover even when no trusted disagreement was recorded', async () => {
  const f = disagreementFixture(); f.snapshot.comments[1].shift();
  const result = await coordinate(f);
  assert.equal(result.selected.reason, 'operator_review_resolution');
  assert.deepEqual(f.calls, []);
});

test('automatic retry of a failed operator recovery preserves and revalidates the human decision', async () => {
  const initial = disagreementFixture();
  const claim = await coordinate({ ...initial, apply: true });
  const failureState = structuredClone(claim.state), attempt = failureState.executions[0].attempts.at(-1);
  failureState.executions[0].status = 'blocked';
  failureState.executions[0].blockReason = 'worker_failure';
  attempt.runId = 10; attempt.conclusion = 'failure'; attempt.completedAt = new Date(now).toISOString();
  const f = disagreementFixture();
  f.state = failureState;
  f.reviewRecovery = null;
  f.newId = () => '00000000-0000-0000-0000-000000000003';
  const history = structuredClone(f.state.executions[0].attempts);
  const retried = await coordinate({ ...f, apply: true });
  const next = retried.state.executions[0].attempts.at(-1);
  assert.deepEqual(retried.state.executions[0].attempts.slice(0, -1), history);
  assert.equal(next.reason, 'operator_review_resolution');
  assert.deepEqual(next.operatorResolution, attempt.operatorResolution);
  assert.equal(next.reviewId, 12);
  assert.equal(next.headSha, sha);
  assert.equal(next.runId, undefined);
  for (const change of [
    g => { g.snapshot.comments[1][1].body = 'Changed scope'; },
    g => { g.snapshot.comments[1].pop(); },
    g => { g.snapshot.comments[1][1].user.login = 'untrusted'; },
    g => { delete g.state.executions[0].attempts.at(-1).operatorResolution; },
  ]) {
    const g = disagreementFixture(); g.state = structuredClone(failureState); change(g);
    assert.equal(chooseRetry('RM-001', g.catalog, g.state, { repomanager: g.snapshot }, g.config, now), null);
  }
});

test('operator recovery refuses unsafe or stale evidence and never falls back to unrelated work', async () => {
  const changes = {
    'global pause': f => { f.config.enabled = false; },
    'project pause': f => { f.catalog.projects[0].enabled = false; },
    'wrong task': f => { f.reviewRecovery.taskId = 'RM-999'; },
    'wrong head pin': f => { f.reviewRecovery.headSha = 'b'.repeat(40); },
    'wrong review pin': f => { f.reviewRecovery.reviewId = 13; },
    'unrelated block': f => { f.state.executions[0].blockReason = 'merge_conflict'; },
    'missing resolution': f => { f.snapshot.comments[1].pop(); },
    'untrusted human': f => { f.snapshot.comments[1][1].user.login = 'attacker'; },
    'bot resolution': f => { f.snapshot.comments[1][1].user.type = 'Bot'; },
    'wrong resolution PR': f => { f.snapshot.comments[1][1].issue_url += '0'; },
    'old decision': f => { f.snapshot.comments[1][1].created_at = new Date(now - 11000).toISOString(); },
    'future edit': f => { f.snapshot.comments[1][1].updated_at = new Date(now + 1000).toISOString(); },
    'empty decision': f => { f.snapshot.comments[1][1].body = ' '; },
    'unobserved worker': f => { f.snapshot.runs = []; },
    'duplicate worker': f => { f.snapshot.runs.push({ ...f.snapshot.runs[0], id: 10 }); },
    'rerun': f => { f.snapshot.runs[0].run_attempt = 2; },
    'wrong workflow': f => { f.snapshot.runs[0].path = '.github/workflows/opencode.yml'; },
    'failed worker': f => { f.snapshot.runs[0].conclusion = 'failure'; },
    'active worker': f => { f.snapshot.runs[0].status = 'in_progress'; },
    'changed head': f => { f.snapshot.prs[0].head.sha = 'b'.repeat(40); },
    'draft PR': f => { f.snapshot.prs[0].draft = true; },
    'closed PR': f => { f.snapshot.prs[0].state = 'closed'; },
    'fork PR': f => { f.snapshot.prs[0].head.repo.full_name = 'Other/Repo'; },
    'wrong base': f => { f.snapshot.prs[0].base.ref = 'other'; },
    'merge conflict': f => { f.snapshot.prs[0].mergeable = false; },
    'failed CI': f => { f.snapshot.checks[1][0].conclusion = 'failure'; },
    'pending CI': f => { f.snapshot.checks[1][0].status = 'in_progress'; },
    'missing CI': f => { f.snapshot.checks[1] = []; },
    'approved review': f => { f.snapshot.reviews[1][0].state = 'APPROVED'; },
    'untrusted review': f => { f.snapshot.reviews[1][0].user.login = 'attacker'; },
    'superseded review': f => { f.snapshot.reviews[1][0].id = 13; },
    'correction budget': f => { f.config.maxCorrectionRounds = 1; },
    'another active PR': f => { f.snapshot.prs.push(pr({ number: 2 })); },
  };
  for (const [name, change] of Object.entries(changes)) {
    const f = disagreementFixture(); change(f);
    await assert.rejects(() => coordinate({ ...f, apply: true }), /not eligible/, name);
    assert.deepEqual(f.calls, [], name);
  }
});

test('operator recovery rechecks the decision, review and CI immediately before claiming', async () => {
  for (const change of [
    f => { f.snapshot.comments[1][1].body = 'Different decision'; },
    f => { f.snapshot.reviews[1][0].state = 'APPROVED'; },
    f => { f.snapshot.prs[0].head.sha = 'b'.repeat(40); },
    f => { f.snapshot.checks[1][0].conclusion = 'failure'; },
  ]) {
    const f = disagreementFixture(); let reads = 0;
    f.api.snapshot = async () => { if (++reads === 2) change(f); return structuredClone(f.snapshot); };
    await assert.rejects(() => coordinate({ ...f, apply: true }), /Target changed/);
    assert.deepEqual(f.calls, []);
  }
});

test('recovery never reuses an old run after an ambiguous dispatch or a control-branch race', async () => {
  const f = disagreementFixture();
  f.api.dispatch = async () => { f.calls.push(['dispatch']); throw new Error('Ambiguous timeout'); };
  const result = await coordinate({ ...f, apply: true });
  assert.equal(result.state.executions[0].attempts.at(-1).dispatchStatus, 'unknown');
  f.catalog.tasks[0].status = 'in_progress';
  f.taskTexts[f.catalog.tasks[0].relativePath] = f.taskTexts[f.catalog.tasks[0].relativePath].replace('status: blocked', 'status: in_progress');
  f.calls.length = 0;
  const polled = await coordinate({ ...f, state: result.state, reviewRecovery: null, apply: true });
  assert.equal(polled.state.executions[0].status, 'in_progress');
  assert.equal(polled.state.executions[0].attempts.at(-1).runId, undefined);
  assert.equal(f.calls.some(c => c[0] === 'dispatch'), false);
  const g = disagreementFixture();
  g.api.commitFiles = async () => { throw new Error('Control branch advanced'); };
  await assert.rejects(() => coordinate({ ...g, apply: true }), /Control branch advanced/);
  assert.deepEqual(g.calls, []);
});

test('queued worker refetches the pinned resolution and refuses changed, deleted or untrusted evidence', async () => {
  const f = disagreementFixture(), pr = f.snapshot.prs[0];
  const options = { repository: 'Owner/Repo', reviewers: f.config.reviewers,
    after: f.state.executions[0].attempts.at(-1).completedAt, url: f.reviewRecovery.resolutionUrl, now };
  const pin = reviewResolution(pr, f.snapshot.comments[1], options);
  assert.ok(pin);
  const comment = f.snapshot.comments[1][1];
  const api = { request: async (method, path) => {
    assert.equal(method, 'GET');
    assert.equal(path, '/repos/Owner/Repo/issues/comments/100');
    return structuredClone(comment);
  } };
  assert.deepEqual(await assertReviewResolutionUnchanged(api, pr, pin, 'Owner/Repo', f.config.reviewers), pin);
  for (const change of [
    c => { c.body = 'Edited decision'; }, c => { c.user.login = 'untrusted'; },
    c => { c.user.id = 456; }, c => { c.user.type = 'Bot'; },
    c => { c.updated_at = new Date(now).toISOString(); }, c => { c.issue_url += '0'; },
  ]) {
    const edited = structuredClone(comment); change(edited);
    await assert.rejects(() => assertReviewResolutionUnchanged({ request: async () => edited }, pr, pin,
      'Owner/Repo', f.config.reviewers), /Operator resolution changed/);
  }
  await assert.rejects(() => assertReviewResolutionUnchanged({ request: async () => { throw new Error('HTTP 404'); } },
    pr, pin, 'Owner/Repo', f.config.reviewers), /HTTP 404/);
});

test('recovery CLI requires complete pins, permits preview, and rejects conflicting or malformed options', () => {
  const valid = ['--resume-correction', 'MSS-100', '--review-id', '5721484365', '--expected-head', sha,
    '--resolution-url', 'https://github.com/Owner/Repo/pull/104#issuecomment-6545999062'];
  const parsed = parseArgs(valid);
  assert.equal(parsed.apply, false);
  assert.equal(parsed.reviewRecovery.reviewId, 5721484365);
  assert.equal(parseArgs(['--apply', ...valid]).apply, true);
  for (const args of [valid.slice(0, -2), ['--validate', ...valid], ['--apply', '--retry', 'MSS-100', ...valid],
    [...valid, '--review-id', '12'], ['--apply', '--validate'], ['--expected-head', sha],
    ['--resume-correction', 'MSS-100'], [...valid.slice(0, 3), '12bad', ...valid.slice(4)],
    [...valid.slice(0, 3), '9007199254740992', ...valid.slice(4)],
    [...valid.slice(0, -1), 'https://evil.example/comment'], [...valid, '--unknown']])
    assert.throws(() => parseArgs(args), /Usage/);
});

test('missing run waits for propagation then blocks without an automatic resend', () => {
  const f = fixture(); assert.equal(reconcile(record(), f.snapshot, f.config, now).status, 'in_progress');
  assert.equal(reconcile(record(), f.snapshot, f.config, now + 16 * 60000).blockReason, 'dispatch_not_observed');
});
test('unrelated success cannot reconcile a claim and duplicate correlated runs block', () => {
  const f = fixture(); f.snapshot.runs = [completed({ display_title: 'other' })];
  assert.equal(reconcile(record(), f.snapshot, f.config, now).status, 'in_progress');
  f.snapshot.runs = [completed(), completed({ id: 9 })]; assert.equal(reconcile(record(), f.snapshot, f.config, now).status, 'blocked');
});
test('worker exceeding wall clock cap is blocked', () => {
  const f = fixture();
  f.snapshot.runs = [completed({ status: 'in_progress',
    run_started_at: new Date(now - (f.config.maxRunMinutes + 1) * 60000).toISOString() })];
  assert.equal(reconcile(record(), f.snapshot, f.config, now).blockReason, 'worker_time_limit_exceeded');
});
test('dry run performs no commits or dispatches', async () => {
  const f = fixture(); const result = await coordinate(f); assert.equal(result.selected.task.id, 'RM-001'); assert.deepEqual(f.calls, []);
});
test('claim is durably saved before dispatch and pinned SHA is passed', async () => {
  const f = fixture(); await coordinate({ ...f, apply: true });
  assert.deepEqual(f.calls.map(c => c[0]), ['commit', 'dispatch', 'commit']);
  assert.equal(f.calls[1][3].control_commit, 'b'.repeat(40));
  assert.match(f.calls[0][4][f.catalog.tasks[0].relativePath], /status: in_progress/);
  assert.equal(JSON.parse(f.calls[0][4]['automation/state.json']).executions[0].attempts[0].id, id);
});

test('explicit blocked retry preserves history and appends a new implementation attempt', async () => {
  const f = fixture();
  f.catalog.tasks[0].status = 'blocked';
  f.taskTexts[f.catalog.tasks[0].relativePath] = Object.values(f.taskTexts)[0].replace('status: ready', 'status: blocked');
  const oldId = '00000000-0000-0000-0000-000000000099';
  const e = { ...record(), status: 'blocked', blockReason: 'worker_failure' };
  e.attempts[0] = { ...e.attempts[0], id: oldId, runId: 8, conclusion: 'failure', completedAt: new Date(now).toISOString() };
  f.state.executions = [e];
  f.snapshot.prs = [pr({ draft: true })];
  const result = await coordinate({ ...f, apply: true, retryTaskId: 'RM-001' });
  assert.equal(result.state.executions[0].attempts.length, 2);
  assert.equal(result.state.executions[0].attempts[0].id, oldId);
  assert.equal(result.state.executions[0].attempts[1].id, id);
  assert.equal(result.state.executions[0].status, 'in_progress');
  assert.equal(result.state.executions[0].blockReason, null);
  assert.deepEqual(f.calls.map(c => c[0]), ['commit', 'dispatch', 'commit']);
  assert.equal(f.calls[1][3].expected_head, '');
  assert.match(f.calls[0][4][f.catalog.tasks[0].relativePath], /status: in_progress/);
});

test('normal apply automatically retries an observed recoverable worker failure', async () => {
  const f = fixture();
  f.catalog.tasks[0].status = 'blocked';
  f.taskTexts[f.catalog.tasks[0].relativePath] = Object.values(f.taskTexts)[0].replace('status: ready', 'status: blocked');
  const oldId = '00000000-0000-0000-0000-000000000099';
  const e = { ...record(), status: 'blocked', blockReason: 'worker_failure' };
  e.attempts[0] = { ...e.attempts[0], id: oldId, runId: 8, conclusion: 'failure', completedAt: new Date(now).toISOString() };
  f.state.executions = [e];
  f.snapshot.prs = [pr({ draft: true })];

  const result = await coordinate({ ...f, apply: true });
  const retried = result.state.executions[0];
  assert.equal(retried.status, 'in_progress');
  assert.equal(retried.blockReason, null);
  assert.equal(retried.attempts.length, 2);
  assert.equal(retried.attempts[0].id, oldId);
  assert.equal(retried.attempts[1].id, id);
  assert.deepEqual(f.calls.map(c => c[0]), ['commit', 'dispatch', 'commit']);
});

test('explicit retry fails closed instead of dispatching unrelated work', async () => {
  const f = fixture();
  await assert.rejects(() => coordinate({ ...f, apply: true, retryTaskId: 'RM-999' }), /not eligible/);
  assert.deepEqual(f.calls, []);
});
test('concurrent control write prevents dispatch', async () => {
  const f = fixture(); f.api.commitFiles = async () => { throw new Error('conflict'); };
  await assert.rejects(() => coordinate({ ...f, apply: true }), /conflict/); assert.equal(f.calls.length, 0);
});
test('target change between snapshot and claim prevents dispatch', async () => {
  const f = fixture(); let reads = 0;
  f.api.snapshot = async () => ++reads === 1 ? f.snapshot : { ...f.snapshot, prs: [pr()] };
  await assert.rejects(() => coordinate({ ...f, apply: true }), /Target changed/); assert.equal(f.calls.length, 0);
});
test('ambiguous dispatch is recorded once and never resent on next pass', async () => {
  const f = fixture(); f.api.dispatch = async () => { f.calls.push(['dispatch']); throw new Error('timeout after acceptance'); };
  const result = await coordinate({ ...f, apply: true });
  assert.equal(result.state.executions[0].attempts[0].dispatchStatus, 'unknown');
  f.catalog.tasks[0].status = 'in_progress'; f.taskTexts[f.catalog.tasks[0].relativePath] = Object.values(f.taskTexts)[0].replace('status: ready', 'status: in_progress');
  f.calls.length = 0; await coordinate({ ...f, state: result.state, apply: true }); assert.ok(!f.calls.some(c => c[0] === 'dispatch'));
});
test('human task status edit is not silently overwritten', async () => {
  const f = fixture(); f.state.executions = [record()]; f.catalog.tasks[0].status = 'blocked';
  await assert.rejects(() => coordinate({ ...f, apply: true }), /disagree/);
});
test('stale, untrusted and comment-only reviews do not count', () => {
  const reviews = [{ id: 1, user: { login: 'other' }, commit_id: sha, state: 'CHANGES_REQUESTED' },
    { id: 2, user: { login: 'review-bot' }, commit_id: 'old', state: 'APPROVED' },
    { id: 3, user: { login: 'review-bot' }, commit_id: sha, state: 'COMMENTED' }];
  assert.equal(latestReview(pr(), reviews, ['review-bot']), undefined);
});
test('required CI checks must be present and latest rerun must succeed', () => {
  assert.equal(ciGreen([], ['build-and-test']), false);
  assert.equal(ciGreen([{ id: 1, name: 'build-and-test', status: 'completed', conclusion: 'success' },
    { id: 2, name: 'build-and-test', status: 'in_progress' }], ['build-and-test']), false);
  assert.equal(requiredCiState([{ id: 3, name: 'build-and-test', status: 'completed', conclusion: 'failure' }],
    ['build-and-test']).state, 'failed');
});
test('failed required CI schedules a pinned repair while pending CI waits', () => {
  const f = fixture(); f.catalog.tasks[0].status = 'review';
  const e = { ...record(), status: 'review', pr: 1 }; f.state.executions = [e]; f.snapshot.prs = [pr()];
  f.snapshot.checks[1] = [{ id: 21, name: 'build-and-test', status: 'completed', conclusion: 'failure' }];
  const selected = select(f);
  assert.equal(selected.kind, 'implementation');
  assert.equal(selected.reason, 'ci_repair');
  assert.equal(selected.headSha, sha);
  f.snapshot.checks[1] = [{ id: 22, name: 'build-and-test', status: 'in_progress', conclusion: null }];
  assert.equal(select(f), null);
});
test('CI repair is durably claimed against the failed PR head', async () => {
  const f = fixture(); f.catalog.tasks[0].status = 'review';
  f.taskTexts[f.catalog.tasks[0].relativePath] = Object.values(f.taskTexts)[0].replace('status: ready', 'status: review');
  f.state.executions = [{ ...record(), status: 'review', pr: 1 }];
  f.snapshot.prs = [pr()];
  f.snapshot.checks[1] = [{ id: 21, name: 'build-and-test', status: 'completed', conclusion: 'failure' }];
  const result = await coordinate({ ...f, apply: true });
  const attempt = result.state.executions[0].attempts.at(-1);
  assert.equal(attempt.reason, 'ci_repair');
  assert.equal(attempt.headSha, sha);
  assert.equal(f.calls.find(c => c[0] === 'dispatch')[3].expected_head, sha);
});
test('CI repair loop cap blocks instead of leaving a red PR in review forever', async () => {
  const f = fixture(); f.config.maxCorrectionRounds = 1; f.catalog.tasks[0].status = 'review';
  f.taskTexts[f.catalog.tasks[0].relativePath] = Object.values(f.taskTexts)[0].replace('status: ready', 'status: review');
  const repairId = '00000000-0000-0000-0000-000000000002';
  const e = { ...record(), status: 'review', pr: 1 };
  e.attempts.push({ id: repairId, kind: 'implementation', reason: 'ci_repair',
    startedAt: new Date(now - 60000).toISOString(), sourceControlSha: sha, dispatchStatus: 'sent', headSha: 'b'.repeat(40) });
  f.state.executions = [e];
  f.snapshot.prs = [pr()];
  f.snapshot.runs = [completed({ display_title: runTitle('RM-001', repairId) })];
  f.snapshot.checks[1] = [{ id: 21, name: 'build-and-test', status: 'completed', conclusion: 'failure' }];
  const result = await coordinate(f);
  assert.equal(result.state.executions[0].status, 'blocked');
  assert.equal(result.state.executions[0].blockReason, 'ci_repair_loop_exceeded');
});
test('trusted current-head review can schedule one bounded correction', () => {
  const f = fixture(); f.catalog.tasks[0].status = 'review'; const e = { ...record(), status: 'review', pr: 1 }; f.state.executions = [e];
  f.snapshot.prs = [pr()]; f.snapshot.checks[1] = [{ id: 11, name: 'build-and-test', status: 'completed', conclusion: 'success' }];
  f.snapshot.reviews[1] = [{ id: 12, user: { login: 'review-bot' }, commit_id: sha, state: 'CHANGES_REQUESTED', submitted_at: new Date(now).toISOString() }];
  assert.equal(select(f).kind, 'correction');
  e.attempts.push({ ...e.attempts[0], kind: 'correction', reviewId: 12 }); assert.equal(select(f), null);
});
test('same-day historical starts never block ready work', () => {
  const f = fixture();
  f.state.executions = Array.from({ length: 12 }, (_, i) => ({
    ...record(), taskId: `RM-HIST-${i}`, status: 'done',
  }));
  assert.equal(select(f).task.id, 'RM-001');
});

test('same-day historical starts never block an otherwise eligible explicit retry', () => {
  const f = fixture();
  f.catalog.tasks[0].status = 'blocked';
  const e = { ...record(), status: 'blocked', blockReason: 'worker_failure' };
  e.attempts[0] = { ...e.attempts[0], runId: 8, conclusion: 'failure', completedAt: new Date(now).toISOString() };
  f.state.executions = Array.from({ length: 12 }, (_, i) => ({
    ...record(), taskId: `RM-HIST-${i}`, status: 'done',
  })).concat(e);
  assert.equal(chooseRetry('RM-001', f.catalog, f.state, { repomanager: f.snapshot }, f.config, now).retry, true);
});
test('correction round cap blocks another fix even on a fresh review', () => {
  const f = fixture(); f.config.maxCorrectionRounds = 1; f.catalog.tasks[0].status = 'review';
  const e = { ...record(), status: 'review', pr: 1 }; e.attempts.push({ ...e.attempts[0], kind: 'correction', reviewId: 5 });
  f.state.executions = [e]; f.snapshot.prs = [pr()];
  f.snapshot.checks[1] = [{ id: 11, name: 'build-and-test', status: 'completed', conclusion: 'success' }];
  f.snapshot.reviews[1] = [{ id: 12, user: { login: 'review-bot' }, commit_id: sha, state: 'CHANGES_REQUESTED', submitted_at: new Date(now).toISOString() }];
  assert.equal(select(f), null);
});
test('worker refuses a claim exceeding its own correction limit', () => {
  const f = fixture(); f.catalog.tasks[0].status = 'in_progress'; f.config.maxCorrectionRounds = 1;
  const e = record(); e.attempts = [{ ...e.attempts[0], kind: 'correction' }, { ...e.attempts[0], kind: 'correction' }]; f.state.executions = [e];
  assert.throws(() => authorize({ ...f, taskId: 'RM-001', taskPath: f.catalog.tasks[0].relativePath,
    repository: 'Owner/Repo', mode: 'correction', attemptId: id }));
});
test('worker refuses a claim exceeding the CI repair limit', () => {
  const f = fixture(); f.catalog.tasks[0].status = 'in_progress'; f.config.maxCorrectionRounds = 1;
  const repair = { ...record().attempts[0], reason: 'ci_repair', headSha: sha };
  const e = record(); e.attempts = [{ ...repair, id: '00000000-0000-0000-0000-000000000002' }, repair]; f.state.executions = [e];
  assert.throws(() => authorize({ ...f, taskId: 'RM-001', taskPath: f.catalog.tasks[0].relativePath,
    repository: 'Owner/Repo', mode: 'implementation', attemptId: id, expectedHead: sha }));
});
test('manual worker gate rejects unauthorized task and claimed worker validates attempt', () => {
  const f = fixture(); const input = { ...f, taskId: 'RM-001', taskPath: f.catalog.tasks[0].relativePath, repository: 'Owner/Repo', mode: 'implementation' };
  assert.equal(authorize(input).task.id, 'RM-001');
  const enrolled = f.config.projects.repomanager;
  delete f.config.projects.repomanager;
  assert.throws(() => authorize(input));
  f.config.projects.repomanager = enrolled;
  assert.throws(() => authorize({ ...input, taskPath: '../elsewhere' }));
  assert.throws(() => authorize({ ...input, mode: 'correction' }));
  f.catalog.tasks[0].status = 'in_progress'; f.state.executions = [record()];
  assert.equal(authorize({ ...input, attemptId: id }).attempt.id, id);
  assert.throws(() => authorize({ ...input, attemptId: 'wrong' }));
  f.config.enabled = false; assert.throws(() => authorize({ ...input, attemptId: id }));
});
test('GitHub adapter follows pagination and never retries a dispatch POST', async () => {
  let calls = 0;
  const api = new GitHub('test-token', async () => new Response(JSON.stringify(++calls === 1 ? Array(100).fill({ id: 1 }) : [{ id: 2 }])));
  assert.equal((await api.pages('/list')).length, 101); assert.equal(calls, 2);
  calls = 0; api.fetcher = async () => { calls++; return new Response('', { status: 503 }); };
  await assert.rejects(() => api.dispatch('Owner/Repo', { workflow: 'worker.yml', branch: 'master' }, {})); assert.equal(calls, 1);
});
test('GitHub commit uses existing tree, exact parent and non-force reference update', async () => {
  const calls = [], replies = [{ object: { sha } }, { tree: { sha: 'old-tree' } }, { sha: 'new-tree' }, { sha: 'new-commit' }, {}];
  const api = new GitHub('test', async (url, options) => { calls.push([url, options]); return new Response(JSON.stringify(replies.shift())); });
  assert.equal(await api.commitFiles('Owner/Repo', 'master', sha, { 'task.md': 'data' }, 'Claim'), 'new-commit');
  assert.equal(JSON.parse(calls[2][1].body).base_tree, 'old-tree');
  assert.deepEqual(JSON.parse(calls[3][1].body).parents, [sha]);
  assert.equal(JSON.parse(calls[4][1].body).force, false);
});
test('task spec guard compares blob SHAs so Windows CRLF checkout cannot cause a false stale claim', async () => {
  const config = { controlRepository: 'Owner/Repo', controlBranch: 'master' };
  const taskPath = 'projects/repomanager/tasks/RM-001.md';
  const sameShaApi = {
    request: async (method, path) => {
      if (path.endsWith('?ref=master')) return { sha: 'abc123', content: Buffer.from('id: RM-001\n', 'utf8').toString('base64') };
      assert.match(path, new RegExp(`ref=${sha}$`));
      return { sha: 'abc123', content: Buffer.from('id: RM-001\n', 'utf8').toString('base64') };
    },
  };
  await assertTaskSpecUnchanged(sameShaApi, config, taskPath, sha);
  // The old byte-for-byte comparison failed here: identical logical content looks
  // different when the Windows working-tree file is CRLF and the API blob is LF.
  const liveText = 'id: RM-001\nstatus: ready\n';
  const windowsWorkingTreeText = 'id: RM-001\r\nstatus: ready\r\n';
  assert.notEqual(liveText, windowsWorkingTreeText);
  const changedApi = {
    request: async (method, path) => {
      if (path.endsWith('?ref=master')) return { sha: 'changed-blob-sha', content: Buffer.from('id: RM-001\nchanged\n', 'utf8').toString('base64') };
      return { sha: 'abc123', content: Buffer.from('id: RM-001\n', 'utf8').toString('base64') };
    },
  };
  await assert.rejects(() => assertTaskSpecUnchanged(changedApi, config, taskPath, sha),
    /Task specification changed after dispatch/);
  await assert.rejects(() => assertTaskSpecUnchanged(sameShaApi, config, taskPath, ''),
    /Missing pinned control SHA/);
});

test('CI repair counts separately from the initial implementation budget', async () => {
  const f = fixture(); f.config.maxAttempts = 1; f.config.maxCorrectionRounds = 3;
  f.catalog.tasks[0].status = 'review';
  f.taskTexts[f.catalog.tasks[0].relativePath] = Object.values(f.taskTexts)[0].replace('status: ready', 'status: review');
  const e = { ...record(), status: 'review', pr: 1 };
  e.attempts.push({ ...e.attempts[0], id: '00000000-0000-0000-0000-000000000002',
    reason: 'ci_repair', headSha: sha });
  f.state.executions = [e]; f.snapshot.prs = [pr()];
  f.snapshot.checks[1] = [{ id: 20, name: 'build-and-test', status: 'completed', conclusion: 'failure' }];
  const result = await coordinate({ ...f, apply: true });
  assert.equal(result.selected.reason, 'ci_repair');
  assert.equal(result.state.executions[0].attempts.length, 3);
  assert.equal(result.state.executions[0].attempts.at(-1).reason, 'ci_repair');
});

test('failed CI repair retry retains pinned head and its separate budget', () => {
  const f = fixture(); f.config.maxAttempts = 1;
  f.catalog.tasks[0].status = 'blocked';
  const repair = { ...record().attempts[0], id: '00000000-0000-0000-0000-000000000002',
    reason: 'ci_repair', headSha: sha, runId: 8, conclusion: 'failure', completedAt: new Date(now).toISOString() };
  f.state.executions = [{ ...record(), status: 'blocked', blockReason: 'worker_failure', pr: 1,
    attempts: [record().attempts[0], repair] }];
  f.snapshot.prs = [pr()];
  f.snapshot.checks[1] = [{ id: 20, name: 'build-and-test', status: 'completed', conclusion: 'failure' }];
  const chosen = chooseRetry('RM-001', f.catalog, f.state, { repomanager: f.snapshot }, f.config, now);
  assert.equal(chosen.reason, 'ci_repair');
  assert.equal(chosen.headSha, sha);
  f.snapshot.prs[0].head.sha = 'b'.repeat(40);
  assert.equal(chooseRetry('RM-001', f.catalog, f.state, { repomanager: f.snapshot }, f.config, now), null);
});

test('infrastructure failures do not consume coding budget and use bounded backoff', () => {
  const f = fixture(); f.config.maxAttempts = 1;
  f.catalog.tasks[0].status = 'blocked';
  const attempt = { ...record().attempts[0], runId: 8, conclusion: 'failure',
    completedAt: new Date(now).toISOString(), failureCategory: 'infrastructure' };
  const e = { ...record(), status: 'blocked', blockReason: 'worker_failure', attempts: [attempt] };
  f.state.executions = [e];
  assert.equal(chooseRetry('RM-001', f.catalog, f.state, { repomanager: f.snapshot }, f.config, now), null);
  assert.ok(chooseRetry('RM-001', f.catalog, f.state, { repomanager: f.snapshot }, f.config, now + 16 * 60000));
  e.attempts[0].failureCategory = 'execution';
  assert.equal(chooseRetry('RM-001', f.catalog, f.state, { repomanager: f.snapshot }, f.config, now + 16 * 60000), null);
});

test('failed worker authorization is classified only with concrete log evidence', async () => {
  const fake = new GitHub('token', async url => ({
    ok: true, status: 200, text: async () => url.includes('/jobs?')
      ? JSON.stringify({ jobs: [{ id: 17, conclusion: 'failure', steps: [
        { name: 'Run OpenCode worker', conclusion: 'failure' }] }] })
      : 'Error: This API key has expired. Create a new API key in OpenCode Console.',
  }));
  assert.equal(await fake.classifyWorkerFailure('Owner/Repo', { id: 8, conclusion: 'failure' }), 'infrastructure');
  fake.jobLogs = async () => 'Error: dotnet build failed';
  assert.equal(await fake.classifyWorkerFailure('Owner/Repo', { id: 8, conclusion: 'failure' }), 'execution');
});
