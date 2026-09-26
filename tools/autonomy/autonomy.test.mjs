import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chooseWork, chooseRetry, reconcile, replaceStatus, runTitle, latestReview, ciGreen, requiredCiState, validateConfig } from './policy.mjs';
import { coordinate, validateState } from './coordinator.mjs';
import { authorize, assertTaskSpecUnchanged } from './worker.mjs';
import { GitHub } from './github.mjs';

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
test('explicit developer disagreement stops the correction loop for human resolution', () => {
  const correctionId = '00000000-0000-0000-0000-000000000002';
  const e = record();
  e.attempts.push({ id: correctionId, kind: 'correction', startedAt: new Date(now - 60000).toISOString(),
    sourceControlSha: sha, dispatchStatus: 'sent', reviewId: 12, headSha: sha });
  const f = fixture();
  f.snapshot.prs = [pr()];
  f.snapshot.runs = [completed({ display_title: runTitle('RM-001', correctionId) })];
  f.snapshot.comments[1] = [{
    id: 99,
    user: { login: 'worker-bot' },
    body: '<!-- autonomous-review-disagreement:v1 -->\nReview-ID: 12\nReviewed-SHA: ' + sha + '\nReason: The requested change contradicts the task.',
    created_at: new Date(now).toISOString(),
    html_url: 'https://github.com/Owner/Repo/pull/1#issuecomment-99',
  }];
  const blocked = reconcile(e, f.snapshot, f.config, now);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockReason, 'autonomous_review_disagreement');
  assert.equal(blocked.disagreementUrl, 'https://github.com/Owner/Repo/pull/1#issuecomment-99');
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
