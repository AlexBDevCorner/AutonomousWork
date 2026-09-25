// Manual Step 4 fixture-only review writer. Not imported by the Supabase bridge.
// No merge API, worker dispatch, queue claim, or production PR support.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GitHub } from '../autonomy/github.mjs';

export const REPO = 'AlexBDevCorner/AutonomousWork';
export const BRANCH = 'review-bridge-fixture/step4';
export const FILE = 'docs/review-bridge-fixtures/step4.md';
export const MARKER = '<!-- review-bridge-fixture:v1 -->';
export const REVIEWER = 'AlexBDevCorner';
const SHA = /^[a-f0-9]{40}$/;
const EVENTS = new Set(['VERIFY_ONLY', 'REQUEST_CHANGES', 'APPROVE']);
const safeMessage = e => String(e?.message ?? 'unknown').replace(/https?:\/\/\S+/g, '[url]');

export function parseFixture(source) {
  if (typeof source !== 'string' || source.length > 4000) return null;
  const id = [...source.matchAll(/^fixture_id:\s*(\S+)\s*$/gm)];
  const status = [...source.matchAll(/^fixture_status:\s*(\S+)\s*$/gm)];
  if (id.length !== 1 || id[0][1] !== 'step4' || status.length !== 1) return null;
  if (!['broken', 'ready'].includes(status[0][1])) return null;
  return status[0][1];
}

export function matchingCheck(checks, name, head) {
  if (!Array.isArray(checks)) return null;
  return checks.filter(c => c.name === name && c.head_sha === head &&
    c.app?.slug === 'github-actions' && Number.isSafeInteger(c.id))
    .sort((a, b) => b.id - a.id)[0] ?? null;
}

export function sameHeadTrustedReview(reviews, head) {
  if (!Array.isArray(reviews)) throw new Error('Missing raw reviews');
  return reviews.filter(r => r.user?.login === REVIEWER && r.commit_id === head &&
    ['APPROVED', 'CHANGES_REQUESTED'].includes(r.state) &&
    Number.isSafeInteger(r.id) && !Number.isNaN(Date.parse(r.submitted_at)))
    .sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at) || a.id - b.id)
    .at(-1) ?? null;
}

export function authorizeFixture({ pr, files, fixtureText, checks, reviews, config, expectedSha, event, reviewerLogin }) {
  if (!EVENTS.has(event) || !SHA.test(expectedSha ?? '')) throw new Error('Invalid event or reviewed SHA');
  if (!config || config.enabled !== true || config.controlRepository !== REPO ||
      config.controlBranch !== 'master' || !Array.isArray(config.reviewers) ||
      !config.reviewers.includes(REVIEWER) || reviewerLogin !== REVIEWER)
    throw new Error('Global controls or trusted reviewer identity do not authorize fixture testing');
  if (!pr || pr.state !== 'open' || pr.draft !== false || pr.mergeable !== true ||
      !Number.isSafeInteger(pr.number) || pr.number < 1 ||
      pr.base?.repo?.full_name !== REPO || pr.base?.ref !== 'master' ||
      pr.head?.repo?.full_name !== REPO || pr.head?.ref !== BRANCH ||
      pr.head?.sha !== expectedSha || pr.user?.login !== 'autonomousworkdispatcher[bot]' ||
      typeof pr.body !== 'string' || !pr.body.includes(MARKER)) {
    throw new Error('Fixture PR mapping/author/state/head mismatch');
  }
  if (!Array.isArray(files) || files.length !== 1 || files[0].filename !== FILE ||
      !['added', 'modified'].includes(files[0].status))
    throw new Error('Fixture PR changed files outside its allowlist');
  const fixtureState = parseFixture(fixtureText);
  if (!fixtureState) throw new Error('Fixture text malformed or unexpected');
  const earlier = sameHeadTrustedReview(reviews, expectedSha);
  if (earlier) return { outcome: 'already_reviewed', reviewId: earlier.id, state: earlier.state, sha: earlier.commit_id };
  const validate = matchingCheck(checks, 'validate', expectedSha);
  const fixtureCI = matchingCheck(checks, 'fixture-validation', expectedSha);
  if (event === 'VERIFY_ONLY') return {
    outcome: 'inspected', sha: expectedSha, fixtureState,
    validate: validate?.conclusion ?? validate?.status ?? 'missing',
    fixtureCI: fixtureCI?.conclusion ?? fixtureCI?.status ?? 'missing',
  };
  if (event === 'REQUEST_CHANGES') {
    // This is a genuine, reproducible defect in the disposable fixture:
    // the repository's separate CI job requires fixture_status: ready.
    if (fixtureState !== 'broken' ||
        fixtureCI?.status !== 'completed' || fixtureCI.conclusion !== 'failure')
      throw new Error('Cannot request changes without a verified failing fixture CI check');
  } else {
    if (fixtureState !== 'ready' ||
        validate?.status !== 'completed' || validate.conclusion !== 'success' ||
        fixtureCI?.status !== 'completed' || fixtureCI.conclusion !== 'success')
      throw new Error('Cannot approve without fixed fixture and exact-head green checks');
  }
  return { outcome: 'eligible', sha: expectedSha, fixtureState, event };
}

export function reviewBody(event, sha) {
  if (!SHA.test(sha)) throw new Error('Invalid reviewed SHA');
  const header = 'Disposable Step 4 bridge fixture only. Reviewed SHA: ' + sha + '\n\n';
  if (event === 'REQUEST_CHANGES') return header +
    'P1 in ' + FILE + ': fixture_status is broken. The fixture-validation CI check ' +
    'fails because the documented fixture contract requires fixture_status: ready. ' +
    'Repair this deliberately failing test fixture before requesting a new review.';
  if (event === 'APPROVE') return header +
    'The deliberately broken fixture has been repaired, and both validate and ' +
    'fixture-validation completed successfully on this exact commit. This approval ' +
    'covers only the disposable review-bridge test PR, not any autonomous task.';
  throw new Error('Only an explicitly selected review event can submit');
}

export async function submitExactHeadReview({ fetcher, token, number, sha, event }) {
  if (!token || !Number.isSafeInteger(number) || number < 1 || !SHA.test(sha) ||
      !['APPROVE', 'REQUEST_CHANGES'].includes(event))
    throw new Error('Missing review credential or invalid exact-head review request');
  const prefix = 'https://api.github.com/repos/' + REPO + '/pulls/' + number + '/reviews';
  let response;
  try {
    response = await fetcher(prefix, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'AutonomousWork-Step4-Fixture',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ commit_id: sha, event, body: reviewBody(event, sha) }),
    });
  } catch {
    // A network error may mean the POST reached GitHub. NEVER retry blindly.
    throw new Error('Review POST outcome uncertain; inspect raw reviews before any manual retry');
  }
  if (!response.ok) throw new Error('Review POST HTTP ' + response.status +
    '; inspect raw reviews before any manual retry');
  const submitted = await response.json();
  const state = event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';
  if (!Number.isSafeInteger(submitted.id) || submitted.user?.login !== REVIEWER ||
      submitted.state !== state || submitted.commit_id !== sha) {
    throw new Error('Review response mismatched expected reviewer, event or exact commit; inspect GitHub');
  }
  return { id: submitted.id, state: submitted.state, sha: submitted.commit_id };
}

export function assertFixtureRuntime(env) {
  if (env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== 'refs/heads/master' ||
      env.GITHUB_EVENT_NAME !== 'workflow_dispatch')
    throw new Error('Only manual dispatch on the trusted control master is permitted');
  if (!/^[1-9]\d{0,7}$/.test(env.FIXTURE_PR ?? '') || !SHA.test(env.FIXTURE_SHA ?? '') ||
      !EVENTS.has(env.FIXTURE_EVENT))
    throw new Error('Invalid explicit PR/head/event inputs');
  if (!env.READ_ONLY_GITHUB_TOKEN) throw new Error('Read-only token missing');
  if (env.FIXTURE_EVENT !== 'VERIFY_ONLY') {
    if (env.REVIEW_BRIDGE_FIXTURE_WRITE_ENABLED !== 'true' ||
        !env.REVIEW_BRIDGE_REVIEWER_TOKEN)
      throw new Error('Fixture review writes disabled or reviewer token missing');
    if (env.FIXTURE_CONFIRM !== 'STEP4_FIXTURE_ONLY')
      throw new Error('Explicit fixture-only confirmation missing');
  }
}

export async function inspectFixture({ api, number, sha, event, reviewerLogin }) {
  const prefix = '/repos/' + REPO;
  const master = await api.request('GET', prefix + '/git/ref/heads/master');
  const controlSha = master?.object?.sha;
  if (!SHA.test(controlSha ?? '')) throw new Error('Cannot pin live control master');
  const file = await api.request('GET', prefix + '/contents/automation/config.json?ref=' + controlSha);
  if (file.encoding !== 'base64') throw new Error('Invalid control config response');
  const config = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  const pr = await api.request('GET', prefix + '/pulls/' + number);
  // Check PR's exact affected paths before touching PR-head files.
  const files = await api.pages(prefix + '/pulls/' + number + '/files');
  if (files.length !== 1 || files[0].filename !== FILE)
    throw new Error('Unrecognized fixture PR file changes');
  if (pr.head?.sha !== sha || pr.head?.ref !== BRANCH || pr.head?.repo?.full_name !== REPO)
    throw new Error('Fixture PR head moved or repository/branch changed');
  const fileContent = await api.request('GET', prefix + '/contents/' + FILE + '?ref=' + sha);
  if (fileContent.encoding !== 'base64' || fileContent.size > 4000)
    throw new Error('Missing fixture text');
  const fixtureText = Buffer.from(fileContent.content, 'base64').toString('utf8');
  const [checks, reviews] = await Promise.all([
    api.pages(prefix + '/commits/' + sha + '/check-runs', 'check_runs'),
    api.pages(prefix + '/pulls/' + number + '/reviews'),
  ]);
  const decision = authorizeFixture({
    pr, files, fixtureText, checks, reviews, config, expectedSha: sha,
    event, reviewerLogin,
  });
  return { decision, controlSha };
}

export async function controlledReview({ readApi, reviewerToken, reviewerLogin, number, sha, event,
  enabled = false, confirm = '', fetcher = fetch }) {
  // First observation has NO write side effects.
  const before = await inspectFixture({ api: readApi, number, sha, event, reviewerLogin });
  if (before.decision.outcome !== 'eligible') return before.decision;
  if (!enabled || confirm !== 'STEP4_FIXTURE_ONLY' || !reviewerToken)
    throw new Error('Manual fixture review is disabled or missing its dedicated token');
  // Re-read all control/PR/check/review state immediately before POST.
  const fresh = await inspectFixture({ api: readApi, number, sha, event, reviewerLogin });
  if (fresh.controlSha !== before.controlSha)
    throw new Error('Control master changed; no review submitted');
  if (fresh.decision.outcome !== 'eligible') return fresh.decision;
  const submitted = await submitExactHeadReview({
    fetcher, token: reviewerToken, number, sha, event,
  });
  // Verify the raw review's commit_id and latest PR head independently.
  const [observed, pr] = await Promise.all([
    readApi.pages('/repos/' + REPO + '/pulls/' + number + '/reviews'),
    readApi.request('GET', '/repos/' + REPO + '/pulls/' + number),
  ]);
  const exact = observed.find(x => x.id === submitted.id && x.commit_id === sha &&
    x.user?.login === REVIEWER && x.state === submitted.state);
  if (!exact) throw new Error('GitHub did not confirm submitted review on exact commit; inspect manually');
  if (pr.head.sha !== sha)
    throw new Error('Review posted on pinned old head, but PR advanced; do not merge or reuse');
  return { outcome: 'submitted', ...submitted };
}

async function identifyReviewer(token, fetcher = fetch) {
  if (!token) throw new Error('Dedicated reviewer token missing');
  const response = await fetcher('https://api.github.com/user', {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'AutonomousWork-Step4-Fixture',
    },
  });
  if (!response.ok) throw new Error('Cannot verify reviewer token identity: HTTP ' + response.status);
  const profile = await response.json();
  if (profile.login !== REVIEWER) throw new Error('Reviewer PAT identity is not configured trusted user');
  return profile.login;
}

async function main() {
  const env = process.env;
  assertFixtureRuntime(env);
  const reviewerLogin = env.FIXTURE_EVENT === 'VERIFY_ONLY'
    ? REVIEWER : await identifyReviewer(env.REVIEW_BRIDGE_REVIEWER_TOKEN);
  const readApi = new GitHub(env.READ_ONLY_GITHUB_TOKEN);
  const result = await controlledReview({
    readApi, reviewerToken: env.REVIEW_BRIDGE_REVIEWER_TOKEN,
    reviewerLogin, number: Number(env.FIXTURE_PR), sha: env.FIXTURE_SHA,
    event: env.FIXTURE_EVENT,
    enabled: env.REVIEW_BRIDGE_FIXTURE_WRITE_ENABLED === 'true',
    confirm: env.FIXTURE_CONFIRM,
  });
  console.log('Step 4 fixture:', result.outcome, result.state ?? '', result.sha ?? '', result.id ?? '');
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, '### Step 4 fixture-only review\n\n' +
      '- Outcome: ' + result.outcome + '\n' +
      '- PR: ' + env.FIXTURE_PR + '\n' +
      '- Reviewed SHA: ' + env.FIXTURE_SHA + '\n' +
      '- No merge or worker dispatch.\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(e => { console.error('Controlled review stopped:', safeMessage(e)); process.exitCode = 1; });
