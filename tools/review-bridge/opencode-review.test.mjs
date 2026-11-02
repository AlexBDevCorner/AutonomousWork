import test from 'node:test';
import assert from 'node:assert/strict';
import { checkModel, eligibility, parseVerdict, publish, reviewRow, reviewInput, validateVerdict } from './opencode-review.mjs';
import { validateRecord } from './guards.mjs';

const sha = 'a'.repeat(40);
const env = { TASK_ID: 'MSS-101', PROJECT_ID: 'mtgsolosports', REPOSITORY: 'AlexBDevCorner/MtgSoloSports', PR: '105', HEAD_SHA: sha };
const input = reviewInput(env);
const p1 = { severity: 'P1', path: 'src/Round.cs', line: 42, description: 'Simulating a league round advances the cup RNG; replay differs.' };
const p2 = { severity: 'P2', location: 'RoundService', description: 'Add a restart/resume equivalence test.' };
const verdict = (extra = {}) => ({ verdict: 'APPROVE', summary: 'Reconstructs standings from immutable rounds.',
  deployment_context: 'Local single-user localhost app.', findings: [], ...extra });
const block = v => 'tool output BEGIN_REVIEW_VERDICT {"verdict":"APPROVE"} END_REVIEW_VERDICT\nfinal:\n' +
  'BEGIN_REVIEW_VERDICT\n```json\n' + JSON.stringify(v) + '\n```\nEND_REVIEW_VERDICT\n';

test('dispatch inputs are strictly validated', () => {
  assert.equal(input.pr, 105);
  for (const bad of [{ PR: '0' }, { PR: '1e3' }, { HEAD_SHA: 'A'.repeat(40) }, { REPOSITORY: 'Evil/Repo' }, { TASK_ID: 'mss-1' }])
    assert.throws(() => reviewInput({ ...env, ...bad }));
});

test('the last verdict block wins and fenced JSON is accepted', () => {
  const v = parseVerdict(block(verdict({ verdict: 'REQUEST_CHANGES', findings: [p1, p2] })));
  assert.equal(v.verdict, 'REQUEST_CHANGES');
  assert.throws(() => parseVerdict('no verdict here'), /no verdict/);
  assert.throws(() => parseVerdict('BEGIN_REVIEW_VERDICT {nope END_REVIEW_VERDICT'), /not valid JSON/);
});

test('verdict severity rules cannot be bypassed by the model', () => {
  assert.throws(() => validateVerdict(verdict({ findings: [p1] })), /APPROVE with a P0\/P1/);
  assert.throws(() => validateVerdict(verdict({ verdict: 'REQUEST_CHANGES', findings: [p2] })), /without a P0\/P1/);
  assert.throws(() => validateVerdict(verdict({ verdict: 'REQUEST_CHANGES', findings: [{ severity: 'P1', description: 'vague' }] })), /location/);
  assert.throws(() => validateVerdict(verdict({ verdict: 'MERGE_CHECK' })), /Unknown verdict/);
  assert.throws(() => validateVerdict(verdict({ approve_and_merge: true })), /unknown/);
  assert.throws(() => validateVerdict(verdict({ findings: [{ ...p2, severity: 'P3' }] })), /Malformed/);
  assert.throws(() => validateVerdict(verdict({ deployment_context: '' })), /context/);
  assert.equal(validateVerdict(verdict({ findings: [p2] })).verdict, 'APPROVE');
  assert.throws(() => validateVerdict(verdict({ verdict: 'REQUEST_CHANGES',
    findings: Array.from({ length: 6 }, () => ({ ...p1, description: 'x'.repeat(1400) })) })), /too long/);
  assert.equal(validateVerdict(verdict({ verdict: 'WITHHOLD', findings: [p1] })).verdict, 'WITHHOLD');
});

test('configured model and variant must be advertised; no silent fallback', () => {
  const listing = 'opencode-go/gemini-4-argon\r\n{\n  "id": "gemini-4-argon",\n  "variants": { "low": {}, "high": {} }\n}\n' +
    'opencode-go/kimi-k3.1-pro\n{\n  "variants": { "max": {} }\n}\n';
  assert.deepEqual(checkModel(listing, 'opencode-go/gemini-4-argon', 'high'), { model: 'opencode-go/gemini-4-argon', variant: 'high' });
  assert.throws(() => checkModel(listing, 'opencode-go/gemini-4-argon', 'max'), /not supported/);
  assert.throws(() => checkModel(listing, 'opencode-go/gpt-6-astra', 'high'), /not available/);
  assert.equal(checkModel(listing, 'opencode-go/kimi-k3.1-pro', 'max').variant, 'max');
});

test('review row keeps only blocking findings and surfaces P2s and the model in the body', () => {
  const row = reviewRow(verdict({ verdict: 'REQUEST_CHANGES', findings: [p1, p2] }), input,
    { model: 'opencode-go/gemini-4-argon', variant: 'high', runUrl: 'https://example/run', ci: 'green', now: 0 });
  assert.deepEqual(row.findings, [p1]);
  assert.match(row.review_summary, /^Deployment context: Local/);
  assert.match(row.review_summary, /Non-blocking suggestions \(P2\):\n- RoundService: Add a restart/);
  assert.match(row.review_summary, /OpenCode opencode-go\/gemini-4-argon \(high\)/);
  assert.equal(row.reviewed_sha, sha);
  // The bridge's own record validation accepts the in-memory row.
  assert.equal(validateRecord(row, row.id, Date.now(), true), null);
  const many = Array.from({ length: 20 }, () => ({ ...p2, description: 'x'.repeat(1400) }));
  assert.ok(reviewRow(verdict({ summary: 'y'.repeat(2500), findings: many }), input,
    { model: 'm/x', variant: 'high', ci: 'green' }).review_summary.length <= 4000);
});

test('eligibility uses bridge guards, retries control races, and fails closed', async () => {
  const fake = (...reasons) => {
    const rows = [];
    return { rows, verify: async ({ row }) => { rows.push(row); const r = reasons.shift(); return { status: r[0], reason: r[1], evidence: { ci: 'green' } }; } };
  };
  let f = fake(['stale', 'control_master_advanced'], ['dry_run', 'review_guards_passed_no_mutation']);
  assert.equal((await eligibility({ api: {}, input, verify: f.verify })).eligible, true);
  assert.equal(f.rows.length, 2);
  assert.equal(f.rows[0].source, 'opencode-actions');
  assert.equal(f.rows[0].reviewed_sha, sha);
  assert.equal(validateRecord(f.rows[0], f.rows[0].id, Date.now(), true), null);
  f = fake(['withheld', 'trusted_same_head_verdict_exists']);
  assert.equal((await eligibility({ api: {}, input, verify: f.verify })).eligible, false);
  f = fake(['stale', 'reviewed_head_changed']);
  assert.equal((await eligibility({ api: {}, input, verify: f.verify })).eligible, false);
  for (const r of [['withheld', 'approval_requires_green_ci'], ['withheld', 'project_review_disabled'],
    ['stale', 'control_specification_pin_mismatch'], ['withheld', 'reviewer_withheld']]) {
    f = fake(r);
    await assert.rejects(eligibility({ api: {}, input, verify: f.verify }), /not eligible/);
  }
  f = fake(['withheld', 'reviewer_withheld']);
  assert.equal((await eligibility({ api: {}, input, verdict: 'WITHHOLD', verify: f.verify })).eligible, true);
  f = fake(['dry_run', 'merge_guards_passed_no_mutation']);
  assert.equal((await eligibility({ api: {}, input, verdict: 'MERGE_CHECK', verify: f.verify })).eligible, true);
  assert.equal(f.rows[0].verdict, 'MERGE_CHECK');
  // A pass reason for a different verdict is never accepted.
  f = fake(['dry_run', 'review_guards_passed_no_mutation']);
  await assert.rejects(eligibility({ api: {}, input, verdict: 'REQUEST_CHANGES', verify: f.verify }), /not eligible/);
  f = fake(['withheld', 'merge_requires_latest_same_head_trusted_approval']);
  await assert.rejects(eligibility({ api: {}, input, verdict: 'MERGE_CHECK', verify: f.verify }), /not eligible/);
  f = fake(['stale', 'control_master_advanced'], ['stale', 'control_master_advanced'], ['stale', 'control_master_advanced']);
  await assert.rejects(eligibility({ api: {}, input, verify: f.verify }), /control_master_advanced/);
});

test('publish routes each verdict only through guarded writers after a live re-check', async () => {
  const run = async (v, decision = { status: 'dry_run', reason: 'x', evidence: { ci: 'green' } }, merged = true) => {
    const calls = [];
    const writes = {
      review: async row => { calls.push(['review', row.verdict, row.findings.length]); return 55; },
      merge: async row => { calls.push(['merge', row.reviewed_sha]); return merged ? { merged: true, sha: 'd'.repeat(40) }
        : { merged: false, decision: { reason: 'pr_closed_draft_unmergeable_or_unknown' } }; },
      comment: async row => { calls.push(['comment', row.review_summary]); },
    };
    const check = async args => { calls.push(['check', args.verdict, args.findings.length]);
      return { eligible: decision.status === 'dry_run', decision }; };
    const result = await publish({ verdict: validateVerdict(v), input, api: {}, writes, check,
      meta: { model: 'opencode-go/gemini-4-argon', variant: 'high' } });
    return { result, calls };
  };
  let { result, calls } = await run(verdict());
  assert.deepEqual(calls, [['check', 'APPROVE', 0], ['review', 'APPROVE', 0], ['merge', sha]]);
  assert.deepEqual([result.outcome, result.reviewId, result.mergeSha], ['merged', 55, 'd'.repeat(40)]);
  ({ result, calls } = await run(verdict(), undefined, false));
  assert.deepEqual([result.outcome, result.reason], ['review_posted_merge_withheld', 'pr_closed_draft_unmergeable_or_unknown']);
  // REQUEST_CHANGES never merges; only blocking findings reach the review row.
  ({ result, calls } = await run(verdict({ verdict: 'REQUEST_CHANGES', findings: [p1, p2] })));
  assert.deepEqual(calls, [['check', 'REQUEST_CHANGES', 1], ['review', 'REQUEST_CHANGES', 1]]);
  // WITHHOLD only makes the escalation visible; no review, no merge.
  ({ result, calls } = await run(verdict({ verdict: 'WITHHOLD' })));
  assert.deepEqual(calls.map(c => c[0]), ['check', 'comment']);
  assert.equal(result.outcome, 'withheld');
  // A live state change since the model ran discards the verdict without any write.
  ({ result, calls } = await run(verdict(), { status: 'stale', reason: 'reviewed_head_changed' }));
  assert.deepEqual(calls.map(c => c[0]), ['check']);
  assert.deepEqual([result.outcome, result.reason], ['discarded', 'reviewed_head_changed']);
});

test('bridge accepts OpenCode rows and still rejects unknown sources', () => {
  const row = { id: '11111111-1111-4111-8111-111111111111', schema_version: 1, source: 'opencode-actions', test_only: false,
    status: 'queued', repository: input.repository, project_id: input.projectId, task_id: input.taskId, pr_number: 105,
    reviewed_sha: sha, verdict: 'APPROVE', findings: [], ci: {}, review_summary: 's', observed_at: new Date().toISOString() };
  assert.equal(validateRecord(row, row.id, Date.now(), true), null);
  assert.equal(validateRecord({ ...row, source: 'pr-author' }, row.id, Date.now(), true), 'unknown_queue_schema_or_source');
});
