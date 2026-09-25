import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REPO, BRANCH, FILE, MARKER, parseFixture, matchingCheck,
  sameHeadTrustedReview, authorizeFixture, reviewBody, submitExactHeadReview,
  assertFixtureRuntime, controlledReview,
} from './review-write.mjs';
import { verifyFixture } from './fixture-verify.mjs';
import { verifyMakerInputs, operate } from './fixture-maker.mjs';

const SHA = 'a'.repeat(40), OLD = 'b'.repeat(40);
const broken = 'fixture_id: step4\nfixture_status: broken\n';
const ready = 'fixture_id: step4\nfixture_status: ready\n';
const pr = () => ({
  number: 45, state: 'open', draft: false, mergeable: true,
  head: { sha: SHA, repo: { full_name: REPO }, ref: BRANCH },
  base: { repo: { full_name: REPO }, ref: 'master' },
  user: { login: 'autonomousworkdispatcher[bot]' }, body: MARKER,
});
const config = () => ({
  controlRepository: REPO, controlBranch: 'master', enabled: true,
  reviewers: ['AlexBDevCorner'],
});
const checks = (fixtureState = 'failure', head = SHA) => [
  { id: 1, name: 'validate', head_sha: head, app: { slug: 'github-actions' },
    status: 'completed', conclusion: 'success' },
  { id: 2, name: 'fixture-validation', head_sha: head, app: { slug: 'github-actions' },
    status: 'completed', conclusion: fixtureState },
];
const review = (changed = {}) => ({
  id: 78, state: 'CHANGES_REQUESTED', commit_id: SHA,
  submitted_at: '2026-09-25T13:00:00Z',
  user: { login: 'AlexBDevCorner' }, ...changed,
});
const fixture = (params = {}) => ({
  pr: pr(), files: [{ filename: FILE, status: 'added' }],
  fixtureText: broken, checks: checks(),
  reviews: [], config: config(), expectedSha: SHA,
  event: 'REQUEST_CHANGES', reviewerLogin: 'AlexBDevCorner',
  ...params,
});

test('the deliberately broken file fails genuine fixture CI; repaired file passes', () => {
  assert.equal(parseFixture(broken), 'broken');
  assert.equal(parseFixture(ready), 'ready');
  assert.equal(verifyFixture(broken), false);
  assert.equal(verifyFixture(ready), true);
  assert.equal(parseFixture('fixture_id: step4\nfixture_status: ready\nfixture_status: broken'), null);
});
test('a broken fixture plus independently failed CI permits only REQUEST_CHANGES', () => {
  assert.deepEqual(authorizeFixture(fixture()).outcome, 'eligible');
  assert.throws(() => authorizeFixture(fixture({ fixtureText: ready })), /verified failing/);
  assert.throws(() => authorizeFixture(fixture({ checks: checks('success') })), /verified failing/);
  assert.throws(() => authorizeFixture(fixture({ checks: [] })), /verified failing/);
  assert.match(reviewBody('REQUEST_CHANGES', SHA), /fixture_status is broken/);
});
test('only corrected fixture with green exact-head validate and fixture checks permits approval', () => {
  const fixed = { fixtureText: ready, checks: checks('success'), event: 'APPROVE' };
  assert.equal(authorizeFixture(fixture(fixed)).outcome, 'eligible');
  assert.throws(() => authorizeFixture(fixture({ ...fixed, fixtureText: broken })), /Cannot approve/);
  assert.throws(() => authorizeFixture(fixture({ ...fixed, checks: checks('failure') })), /Cannot approve/);
  const pending = checks('success');
  pending[0].status = 'in_progress';
  assert.throws(() => authorizeFixture(fixture({ ...fixed, checks: pending })), /Cannot approve/);
});
test('wrong or untrusted reviewer, worker author, mapping, branch, base, draft and head all fail closed', () => {
  assert.throws(() => authorizeFixture(fixture({ reviewerLogin: 'autonomousworkdispatcher[bot]' })), /identity/);
  const changed = [
    { user: { login: 'AlexBDevCorner' } },
    { head: { sha: SHA, repo: { full_name: REPO }, ref: 'autonomous/MSS-002' } },
    { head: { sha: OLD, repo: { full_name: REPO }, ref: BRANCH } },
    { head: { sha: SHA, repo: { full_name: 'SomeoneElse/Repo' }, ref: BRANCH } },
    { base: { repo: { full_name: REPO }, ref: 'feature' } },
    { draft: true }, { mergeable: null }, { state: 'closed' }, { body: 'missing marker' },
  ];
  for (const patch of changed) assert.throws(() => authorizeFixture(fixture({ pr: { ...pr(), ...patch } })), /mapping/);
});
test('unrecognized changed files and disabled control switch block all writes', () => {
  assert.throws(() => authorizeFixture(fixture({
    files: [{ filename: FILE, status: 'added' }, { filename: 'src/Application.cs', status: 'modified' }],
  })), /allowlist/);
  assert.throws(() => authorizeFixture(fixture({ config: { ...config(), enabled: false } })), /controls/);
});
test('same-head completed trusted review suppresses duplicates; old-head and comments do not', () => {
  assert.equal(sameHeadTrustedReview([review()], SHA).id, 78);
  assert.equal(sameHeadTrustedReview([review({ commit_id: OLD })], SHA), null);
  assert.equal(sameHeadTrustedReview([review({ state: 'COMMENTED' })], SHA), null);
  assert.equal(authorizeFixture(fixture({ reviews: [review()] })).outcome, 'already_reviewed');
});
test('review-check selection ignores wrong head, spoofed apps and old successful runs', () => {
  assert.equal(matchingCheck(checks(), 'validate', SHA).conclusion, 'success');
  assert.equal(matchingCheck(checks('success', OLD), 'validate', SHA), null);
  const fake = [...checks('success'), { id: 100, name: 'validate', head_sha: SHA,
    app: { slug: 'other-app' }, status: 'completed', conclusion: 'success' }];
  assert.equal(matchingCheck(fake, 'validate', SHA).id, 1);
});
test('manual review requires the exact master context, input and explicit write gate', () => {
  const env = {
    GITHUB_REPOSITORY: REPO, GITHUB_REF: 'refs/heads/master', GITHUB_EVENT_NAME: 'workflow_dispatch',
    FIXTURE_PR: '45', FIXTURE_SHA: SHA, FIXTURE_EVENT: 'VERIFY_ONLY',
    READ_ONLY_GITHUB_TOKEN: 'read-only',
  };
  assert.doesNotThrow(() => assertFixtureRuntime(env));
  assert.throws(() => assertFixtureRuntime({ ...env, FIXTURE_EVENT: 'APPROVE' }), /disabled/);
  assert.throws(() => assertFixtureRuntime({ ...env, GITHUB_REF: 'refs/heads/feature' }), /master/);
  assert.throws(() => assertFixtureRuntime({ ...env, FIXTURE_SHA: 'wrong' }), /Invalid/);
  assert.doesNotThrow(() => assertFixtureRuntime({
    ...env, FIXTURE_EVENT: 'APPROVE', REVIEW_BRIDGE_FIXTURE_WRITE_ENABLED: 'true',
    REVIEW_BRIDGE_REVIEWER_TOKEN: 'separate-pat', FIXTURE_CONFIRM: 'STEP4_FIXTURE_ONLY',
  }));
});
test('review POST explicitly binds commit_id and checks returned review identity', async () => {
  let sent;
  const fetcher = async (url, options) => {
    sent = { url, options };
    return { ok: true, status: 200, json: async () => ({
      id: 123, user: { login: 'AlexBDevCorner' }, state: 'APPROVED', commit_id: SHA,
    }) };
  };
  const applied = await submitExactHeadReview({
    fetcher, token: 'dedicated', number: 45, sha: SHA, event: 'APPROVE',
  });
  assert.equal(applied.sha, SHA);
  assert.equal(sent.options.method, 'POST');
  assert.equal(sent.options.headers.Authorization, 'Bearer dedicated');
  assert.equal(JSON.parse(sent.options.body).commit_id, SHA);
  assert.equal(JSON.parse(sent.options.body).event, 'APPROVE');
  assert.match(sent.url, /\/pulls\/45\/reviews$/);
});
test('wrong commit, author, state, server failures and ambiguous transport failures never count as success', async () => {
  const base = { token: 'dedicated', number: 45, sha: SHA, event: 'REQUEST_CHANGES' };
  for (const wrong of [
    { commit_id: OLD },
    { user: { login: 'untrusted-bot' } },
    { state: 'COMMENTED' },
  ]) {
    await assert.rejects(submitExactHeadReview({ ...base, fetcher: async () => ({
      ok: true, status: 200, json: async () => ({
        id: 123, commit_id: SHA, user: { login: 'AlexBDevCorner' },
        state: 'CHANGES_REQUESTED', ...wrong,
      }),
    }) }), /mismatched/);
  }
  await assert.rejects(submitExactHeadReview({ ...base, fetcher: async () => {
    throw new Error('connection lost after write');
  } }), /uncertain/);
  await assert.rejects(submitExactHeadReview({ ...base, fetcher: async () => ({
    ok: false, status: 403,
  }) }), /HTTP 403/);
});
test('controlled workflow never posts if the same-head review is already recorded', async () => {
  let posts = 0;
  const repoPrefix = '/repos/' + REPO;
  const contents = value => ({
    encoding: 'base64', sha: SHA, size: value.length,
    content: Buffer.from(value).toString('base64'),
  });
  const api = {
    request: async (_method, path) => {
      if (path.endsWith('/git/ref/heads/master')) return { object: { sha: SHA } };
      if (path.includes('/contents/automation/config.json')) return contents(JSON.stringify(config()));
      if (path.endsWith('/pulls/45')) return pr();
      if (path.includes('/contents/' + FILE)) return contents(broken);
      throw new Error('Unexpected request ' + path);
    },
    pages: async path => {
      if (path === repoPrefix + '/pulls/45/files') return [{ filename: FILE, status: 'added' }];
      if (path.includes('/check-runs')) return checks();
      if (path.includes('/reviews')) return [review()];
      throw new Error('Unexpected pages ' + path);
    },
  };
  const decision = await controlledReview({
    readApi: api, reviewerToken: 'dedicated',
    reviewerLogin: 'AlexBDevCorner', number: 45, sha: SHA, event: 'REQUEST_CHANGES',
    enabled: true, confirm: 'STEP4_FIXTURE_ONLY', fetcher: async () => { posts++; return {}; },
  });
  assert.equal(decision.outcome, 'already_reviewed');
  assert.equal(posts, 0);
});
test('fixture branch lifecycle requires explicit isolated create/repair confirmations', () => {
  assert.doesNotThrow(() => verifyMakerInputs({ phase: 'create', confirmation: 'CREATE_STEP4_FIXTURE', existingPr: 0 }));
  assert.doesNotThrow(() => verifyMakerInputs({ phase: 'repair', confirmation: 'REPAIR_STEP4_FIXTURE', existingPr: 45 }));
  assert.throws(() => verifyMakerInputs({ phase: 'repair', confirmation: 'REPAIR_STEP4_FIXTURE' }), /existing fixture/);
  assert.throws(() => verifyMakerInputs({ phase: 'create', confirmation: 'wrong' }), /confirmation/);
});

test('complete simulated broken-fixture review rereads all guards and verifies raw commit_id', async () => {
  const repoPrefix = '/repos/' + REPO;
  const contents = value => ({
    encoding: 'base64', sha: SHA, size: value.length,
    content: Buffer.from(value).toString('base64'),
  });
  let requests = 0, posts = 0;
  let confirmed = [];
  const api = {
    request: async (_method, path) => {
      requests++;
      if (path.endsWith('/git/ref/heads/master')) return { object: { sha: SHA } };
      if (path.includes('/contents/automation/config.json')) return contents(JSON.stringify(config()));
      if (path.endsWith('/pulls/45')) return pr();
      if (path.includes('/contents/' + FILE)) return contents(broken);
      throw new Error('Unexpected request ' + path);
    },
    pages: async path => {
      if (path === repoPrefix + '/pulls/45/files') return [{ filename: FILE, status: 'added' }];
      if (path.includes('/check-runs')) return checks();
      if (path.includes('/reviews')) return confirmed;
      throw new Error('Unexpected pages ' + path);
    },
  };
  const result = await controlledReview({
    readApi: api, reviewerToken: 'dedicated-reviewer',
    reviewerLogin: 'AlexBDevCorner', number: 45, sha: SHA, event: 'REQUEST_CHANGES',
    enabled: true, confirm: 'STEP4_FIXTURE_ONLY',
    fetcher: async (_url, req) => {
      posts++;
      const body = JSON.parse(req.body);
      assert.equal(body.commit_id, SHA);
      assert.equal(body.event, 'REQUEST_CHANGES');
      confirmed = [review({ id: 79 })];
      return { ok: true, status: 200, json: async () => confirmed[0] };
    },
  });
  assert.deepEqual(result, { outcome: 'submitted', id: 79, state: 'CHANGES_REQUESTED', sha: SHA });
  assert.equal(posts, 1);
  assert.ok(requests >= 8); // two full inspections, final head check
  const duplicate = await controlledReview({
    readApi: api, reviewerToken: 'dedicated-reviewer',
    reviewerLogin: 'AlexBDevCorner', number: 45, sha: SHA, event: 'REQUEST_CHANGES',
    enabled: true, confirm: 'STEP4_FIXTURE_ONLY',
    fetcher: async () => { throw new Error('Must not POST duplicate'); },
  });
  assert.equal(duplicate.outcome, 'already_reviewed');
});

test('control master changing between inspections stops the POST', async () => {
  let masterGets = 0, posts = 0;
  const contents = value => ({
    encoding: 'base64', sha: SHA, size: value.length,
    content: Buffer.from(value).toString('base64'),
  });
  const api = {
    request: async (_method, path) => {
      if (path.endsWith('/git/ref/heads/master'))
        return { object: { sha: ++masterGets === 1 ? SHA : OLD } };
      if (path.includes('/contents/automation/config.json')) return contents(JSON.stringify(config()));
      if (path.endsWith('/pulls/45')) return pr();
      if (path.includes('/contents/' + FILE)) return contents(broken);
      throw new Error('Unexpected ' + path);
    },
    pages: async path => {
      if (path.endsWith('/files')) return [{ filename: FILE, status: 'added' }];
      if (path.includes('/check-runs')) return checks();
      if (path.endsWith('/reviews')) return [];
      throw new Error('Unexpected ' + path);
    },
  };
  await assert.rejects(controlledReview({
    readApi: api, reviewerToken: 'dedicated-reviewer',
    reviewerLogin: 'AlexBDevCorner', number: 45, sha: SHA, event: 'REQUEST_CHANGES',
    enabled: true, confirm: 'STEP4_FIXTURE_ONLY',
    fetcher: async () => { posts++; return {}; },
  }), /master changed/);
  assert.equal(posts, 0);
});

test('operator fixture creator never silently creates a second PR', async () => {
  const api = {
    pages: async () => [{ number: 45, state: 'open' }],
    request: async () => { throw new Error('No GitHub writes allowed'); },
  };
  await assert.rejects(operate({ api, phase: 'create', confirmation: 'CREATE_STEP4_FIXTURE' }),
    /already exists/);
});
