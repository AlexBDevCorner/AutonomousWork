import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isUuid, validateRecord, validatePlanning, validateGitHub,
  requiredCheckState, latestTrustedReview, parseControlPin, PROTOCOL_BLOB_SHA,
} from './guards.mjs';
import { QueueApi, runDryProcess, assertRuntimeEnvironment } from './processor.mjs';

const NOW = Date.parse('2026-09-25T18:00:00Z');
const ID = '450e0ce5-276f-41ac-9b25-453d1b982dad';
const TOKEN = 'b50e0ce5-276f-41ac-9b25-453d1b982dad';
const HEAD = 'a'.repeat(40);
const REPO = 'AlexBDevCorner/MtgSoloSports';
const row = () => ({
  id: ID, schema_version: 1, source: 'chatgpt-scheduled', repository: REPO,
  project_id: 'mtgsolosports', task_id: 'MSS-002', pr_number: 4,
  reviewed_sha: HEAD, verdict: 'APPROVE', findings: [], ci: {},
  review_summary: 'Synthetic test fixture', observed_at: '2026-09-25T17:30:00Z',
  test_only: true, status: 'processing', claim_token: TOKEN,
  lease_until: '2026-09-25T18:10:00Z', attempts: 1,
});
const config = () => ({
  version: 1, enabled: true, controlRepository: 'AlexBDevCorner/AutonomousWork',
  controlBranch: 'master', projects: {
    mtgsolosports: { branch: 'main', workflow: 'autonomous-worker.yml' },
  },
  maxAttempts: 5, maxCorrectionRounds: 3, maxStartsPerProjectPerDay: 8,
  dispatchGraceMinutes: 15, maxRunMinutes: 135,
  reviewers: ['AlexBDevCorner'], requiredChecks: ['build-and-test'],
});
const state = () => ({
  version: 1, executions: [{
    taskId: 'MSS-002', projectId: 'mtgsolosports', repository: REPO,
    pr: 4, status: 'review', blockReason: null,
  }],
});
const project = (enabled = true) =>
  'id: mtgsolosports\nrepository: ' + REPO + '\nenabled: ' + enabled + '\n';
const task = (status = 'review') => '---\nid: MSS-002\nstatus: ' + status + '\n---\nTask spec\n';
const preflight = (changes = {}) => validatePlanning({
  row: row(), config: config(), state: state(),
  projectText: project(), taskText: task(), protocolSha: PROTOCOL_BLOB_SHA,
  ...changes,
});
const pr = () => ({
  number: 4, state: 'open', draft: false, mergeable: true,
  user: { login: 'autonomousworkdispatcher[bot]' }, labels: [],
  head: { ref: 'autonomous/MSS-002', sha: HEAD, repo: { full_name: REPO } },
  base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: REPO } },
  body: 'A normal task PR with no pin.',
});
const check = (changes = {}) => ({
  id: 42, name: 'build-and-test', head_sha: HEAD,
  status: 'completed', conclusion: 'success',
  app: { slug: 'github-actions' }, ...changes,
});
const review = (changes = {}) => ({
  id: 101, state: 'APPROVED', commit_id: HEAD,
  user: { login: 'AlexBDevCorner' }, submitted_at: '2026-09-25T17:25:00Z', ...changes,
});
function observed(changes = {}) {
  const p = pr();
  return {
    row: row(), config: config(), planning: preflight(),
    pr: p, openPrs: [p], checks: [check()], reviews: [], now: NOW,
    pinMatches: null, ...changes,
  };
}
test('normal eligible exact-head test-only approval becomes dry_run, no GitHub write', () => {
  assert.equal(validateRecord(row(), ID, NOW), null);
  assert.deepEqual(validateGitHub(observed()).status, 'dry_run');
  assert.deepEqual(validateGitHub(observed()).reason, 'review_guards_passed_no_mutation');
});
test('reject malformed UUID, forged source, non-test data, and future observation', () => {
  assert.ok(isUuid(ID));
  assert.equal(validateRecord(row(), 'not-a-uuid', NOW), 'invalid_or_mismatched_queue_id');
  assert.equal(validateRecord({ ...row(), test_only: false }, ID, NOW), 'production_verdicts_not_enabled');
  assert.equal(validateRecord({ ...row(), source: 'unknown' }, ID, NOW), 'unknown_queue_schema_or_source');
  assert.equal(validateRecord({ ...row(), observed_at: '2026-09-26T01:00:00Z' }, ID, NOW),
    'observation_from_future');
});
test('global/project switches and enrollment are mandatory', () => {
  const disabled = config(); disabled.enabled = false;
  assert.equal(preflight({ config: disabled }).reason, 'global_control_disabled_or_changed');
  assert.equal(preflight({ projectText: project(false) }).reason, 'project_disabled_or_mapping_invalid');
  const missing = config(); missing.projects = {};
  assert.equal(preflight({ config: missing }).reason, 'project_not_enrolled');
});
test('reject recorded repository, PR, project, task status and protocol mismatches', () => {
  const mismatch = state(); mismatch.executions[0].pr = 5;
  assert.equal(preflight({ state: mismatch }).reason, 'recorded_execution_mapping_mismatch');
  assert.equal(preflight({ projectText: project().replace(REPO, 'AlexBDevCorner/RepoManager') }).reason,
    'project_disabled_or_mapping_invalid');
  assert.equal(preflight({ taskText: task('ready') }).reason, 'task_spec_missing_or_status_mismatch');
  assert.equal(preflight({ protocolSha: '0'.repeat(40) }).reason, 'review_protocol_changed_reaudit_required');
});
test('blocked worker_failure is the only review exception and requires green CI', () => {
  const blocked = state(); blocked.executions[0].status = 'blocked';
  blocked.executions[0].blockReason = 'worker_failure';
  const planning = preflight({ state: blocked, taskText: task('blocked') });
  assert.equal(planning.exceptional, true);
  assert.equal(validateGitHub(observed({ planning, checks: [check({ status: 'in_progress', conclusion: null })] })).reason,
    'worker_failure_exception_requires_green_ci');
  assert.equal(validateGitHub(observed({ planning })).status, 'dry_run');
  blocked.executions[0].blockReason = 'merge_conflict';
  assert.equal(preflight({ state: blocked, taskText: task('blocked') }).reason,
    'execution_not_review_eligible');
});
test('wrong branches, forks, bases, changed SHA, and duplicate PRs are never authorized', () => {
  const wrongBase = pr(); wrongBase.base.ref = 'wrong';
  assert.equal(validateGitHub(observed({ pr: wrongBase })).reason, 'pr_repository_branch_or_base_mismatch');
  const fork = pr(); fork.head.repo.full_name = 'someone/Other';
  assert.equal(validateGitHub(observed({ pr: fork })).reason, 'pr_repository_branch_or_base_mismatch');
  const branch = pr(); branch.head.ref = 'feature/anything';
  assert.equal(validateGitHub(observed({ pr: branch })).reason, 'pr_repository_branch_or_base_mismatch');
  const moved = pr(); moved.head.sha = 'f'.repeat(40);
  assert.equal(validateGitHub(observed({ pr: moved })).status, 'stale');
  assert.equal(validateGitHub(observed({ openPrs: [pr(), pr()] })).reason, 'duplicate_or_missing_autonomous_pr');
});
test('non-mergeable, draft, contradictory labels and expired observation are withheld/stale', () => {
  const unknown = pr(); unknown.mergeable = null;
  assert.equal(validateGitHub(observed({ pr: unknown })).reason, 'pr_closed_draft_unmergeable_or_unknown');
  const draft = pr(); draft.draft = true;
  assert.equal(validateGitHub(observed({ pr: draft })).status, 'withheld');
  const labels = pr(); labels.labels = [{ name: 'task:RM-010' }];
  assert.equal(validateGitHub(observed({ pr: labels })).reason, 'contradictory_pr_labels');
  const expired = row(); expired.observed_at = '2026-09-24T03:00:00Z';
  assert.equal(validateGitHub(observed({ row: expired })).reason, 'observation_expired');
});
test('required CI is exact-head, source-constrained, and must be completed/successful', () => {
  assert.equal(requiredCheckState([check()], ['build-and-test'], HEAD), 'green');
  for (const changes of [
    { status: 'in_progress', conclusion: null }, { conclusion: 'failure' },
    { conclusion: 'skipped' }, { head_sha: 'f'.repeat(40) }, { app: { slug: 'fake-app' } },
  ]) {
    assert.notEqual(requiredCheckState([check(changes)], ['build-and-test'], HEAD), 'green');
  }
  assert.equal(validateGitHub(observed({ checks: [check({ conclusion: 'failure' })] })).reason,
    'approval_requires_green_ci');
});
test('trusted completed reviews use exact raw commit_id and latest completed state', () => {
  const old = review({ commit_id: 'e'.repeat(40) });
  assert.equal(latestTrustedReview([old], ['AlexBDevCorner'], HEAD, 'worker'), null);
  assert.equal(latestTrustedReview([review({ state: 'COMMENTED' })], ['AlexBDevCorner'], HEAD, 'worker'), null);
  assert.equal(latestTrustedReview([review()], ['AlexBDevCorner'], HEAD, 'AlexBDevCorner'), null);
  assert.equal(validateGitHub(observed({ reviews: [review()] })).reason, 'trusted_same_head_verdict_exists');
  const changed = review({ id: 102, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-25T17:45:00Z' });
  assert.equal(latestTrustedReview([review(),changed], ['AlexBDevCorner'], HEAD, 'worker').state, 'CHANGES_REQUESTED');
  assert.equal(validateGitHub(observed({ reviews: [review(),changed], row: { ...row(), verdict: 'MERGE_CHECK' } })).reason,
    'merge_requires_latest_same_head_trusted_approval');
  assert.equal(validateGitHub(observed({ reviews: [review()], row: { ...row(), verdict: 'MERGE_CHECK' } })).status,
    'dry_run');
});
test('documented blocking findings authorize only a REQUEST_CHANGES dry-run', () => {
  const finding = { severity: 'P1', description: 'Concrete failing branch and production impact', path: 'src/App.cs', line: 23 };
  assert.equal(validateGitHub(observed({ row: { ...row(), verdict: 'REQUEST_CHANGES', findings: [finding] } })).status, 'dry_run');
  assert.equal(validateGitHub(observed({ row: { ...row(), verdict: 'REQUEST_CHANGES', findings: [] } })).reason,
    'no_documented_blocking_findings');
  assert.equal(validateGitHub(observed({ row: { ...row(), findings: [finding] } })).reason,
    'blocking_findings_forbid_approval');
  assert.equal(validateGitHub(observed({ row: { ...row(), verdict: 'WITHHOLD' } })).reason,
    'reviewer_withheld');
});
test('PR-body pin is optional, but an existing mismatched pin is stale', () => {
  const pin = 'AlexBDevCorner/AutonomousWork@' + '1'.repeat(40) +
    ': projects/mtgsolosports/tasks/MSS-002.md';
  const p = pr(); p.body = 'Control: ' + pin;
  assert.equal(parseControlPin(p.body, 'AlexBDevCorner/AutonomousWork').valid, true);
  assert.equal(validateGitHub(observed({ pr: p, pinMatches: true })).status, 'dry_run');
  assert.equal(validateGitHub(observed({ pr: p, pinMatches: false })).reason,
    'control_specification_pin_mismatch');
});
test('duplicate delivery and in-progress claim do not run validation', async () => {
  let claimCalls = 0;
  const queue = { get: async () => ({ status: 'dry_run' }), claim: async () => { claimCalls++; return null; } };
  const noop = await runDryProcess({ queue, github: {}, id: ID, clock: () => NOW });
  assert.equal(noop.outcome, 'duplicate_terminal'); assert.equal(claimCalls, 0);
  queue.get = async () => ({ status: 'processing', lease_until: '2026-09-25T18:10:00Z' });
  const busy = await runDryProcess({ queue, github: {}, id: ID, clock: () => NOW });
  assert.equal(busy.outcome, 'already_processing'); assert.equal(claimCalls, 0);
  queue.get = async () => ({ status: 'queued' });
  const noClaim = await runDryProcess({ queue, github: {}, id: ID, clock: () => NOW });
  assert.equal(noClaim.outcome, 'not_claimed'); assert.equal(claimCalls, 1);
});
test('successful lease claim is finished once, with no GitHub mutation', async () => {
  const done = [];
  const queue = { get: async () => ({ status: 'queued' }), claim: async () => row(),
    finish: async (...args) => done.push(args) };
  const answer = await runDryProcess({ queue, github: {}, id: ID, clock: () => NOW,
    verify: async () => ({ status: 'dry_run', reason: 'review_guards_passed_no_mutation', evidence: { head: HEAD } }) });
  assert.equal(answer.outcome, 'evaluated');
  assert.equal(done.length, 1);
  assert.deepEqual(done[0][2], { status: 'dry_run', reason: 'review_guards_passed_no_mutation', evidence: { head: HEAD } });
});
test('failed or expired leases cannot record a successful validation', async () => {
  const queue = { get: async () => ({ status: 'queued' }), claim: async () => ({ ...row(), claim_token: '' }),
    finish: async () => { throw new Error('should not be called'); } };
  await assert.rejects(runDryProcess({ queue, github: {}, id: ID, clock: () => NOW }), /Invalid or expired/);
  queue.claim = async () => row();
  queue.finish = async () => { throw new Error('Lease lost'); };
  await assert.rejects(runDryProcess({ queue, github: {}, id: ID, clock: () => NOW,
    verify: async () => ({ status: 'dry_run', reason: 'validated', evidence: {} }) }), /Lease lost/);
});
test('transient failures become retryable and missing credentials fail before claim', async () => {
  const finished = [];
  const queue = { get: async () => ({ status: 'queued' }), claim: async () => row(),
    finish: async (...args) => finished.push(args) };
  await assert.rejects(runDryProcess({ queue, github: {}, id: ID, clock: () => NOW,
    verify: async () => { throw new Error('GitHub timed out'); } }), /GitHub timed out/);
  assert.equal(finished[0][2].status, 'retryable');
  assert.throws(() => new QueueApi(''), /missing or too short/);
  await assert.rejects(runDryProcess({ queue: null, github: {}, id: ID }), /Missing queue/);
});
test('queue API sends only scoped token to Edge function, not DB service_role', async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ row: row() }) };
  };
  const queue = new QueueApi('q'.repeat(64), fetcher);
  assert.equal((await queue.get(ID)).id, ID);
  assert.ok(seen[0].url.startsWith('https://ayewunekctfmdxgjtqfl.supabase.co/functions/v1/review-bridge-queue'));
  assert.equal(seen[0].init.headers['x-review-bridge-queue-token'], 'q'.repeat(64));
  assert.equal(seen[0].init.headers.apikey, undefined);
});

test('required runtime credentials and trusted master context are checked before claiming', () => {
  const env = {
    QUEUE_ID: ID, GH_TOKEN: 'test-read-only-app-token',
    REVIEW_BRIDGE_QUEUE_TOKEN: 'x'.repeat(64),
    GITHUB_REPOSITORY: 'AlexBDevCorner/AutonomousWork',
    GITHUB_REF: 'refs/heads/master',
  };
  assert.doesNotThrow(() => assertRuntimeEnvironment(env));
  assert.throws(() => assertRuntimeEnvironment({ ...env, GH_TOKEN: '' }), /GH_TOKEN missing/);
  assert.throws(() => assertRuntimeEnvironment({ ...env, REVIEW_BRIDGE_QUEUE_TOKEN: '' }), /Queue token missing/);
  assert.throws(() => assertRuntimeEnvironment({ ...env, GITHUB_REF: 'refs/heads/untrusted' }), /default branch/);
});
