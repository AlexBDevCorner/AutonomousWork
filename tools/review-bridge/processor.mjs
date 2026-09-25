// Deterministic Step 3 bridge processor. Never imports any GitHub write API.
// GitHub Actions checks out only the trusted default-branch control repository.
import { Buffer } from 'node:buffer';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GitHub } from '../autonomy/github.mjs';
import {
  isUuid, terminal, validateRecord, validatePlanning, validateGitHub,
  parseControlPin, taskPath, PROTOCOL_BLOB_SHA,
} from './guards.mjs';

const CONTROL = 'AlexBDevCorner/AutonomousWork';
const EDGE = 'https://ayewunekctfmdxgjtqfl.supabase.co/functions/v1/review-bridge-queue';
const SHA = /^[a-f0-9]{40}$/;
const SAFE_REASON = /^[a-z0-9_]+$/;

export class QueueApi {
  constructor(token, fetcher = fetch) {
    if (!token || token.length < 32)
      throw new Error('REVIEW_BRIDGE_QUEUE_TOKEN missing or too short');
    this.token = token;
    this.fetcher = fetcher;
  }
  async request(method, id, data) {
    if (!isUuid(id)) throw new Error('Invalid queue UUID');
    const url = new URL(EDGE);
    if (method === 'GET') url.searchParams.set('id', id);
    const response = await this.fetcher(url, {
      method,
      redirect: 'error',
      headers: {
        'x-review-bridge-queue-token': this.token,
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify({ id, ...data }) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    if (method === 'GET' && response.status === 404) return null;
    if (method === 'POST' && data?.action === 'finish' && response.status === 409)
      throw new Error('Lease lost before acknowledgement: refusing to finalize');
    if (!response.ok) throw new Error('Queue API ' + method + ' returned HTTP ' + response.status);
    return response.json();
  }
  async get(id) {
    const payload = await this.request('GET', id);
    if (!payload) return null;
    if (!payload.row || payload.row.id !== id) throw new Error('Queue read returned wrong UUID');
    return payload.row;
  }
  async claim(id) {
    const response = await this.request('POST', id, { action: 'claim' });
    if (typeof response?.claimed !== 'boolean') throw new Error('Malformed queue claim response');
    return response.claimed ? response.row : null;
  }
  async finish(id, token, verdict) {
    if (!isUuid(token) || !['dry_run','withheld','stale','failed','retryable'].includes(verdict.status) ||
        !SAFE_REASON.test(verdict.reason ?? '') || !verdict.evidence || typeof verdict.evidence !== 'object') {
      throw new Error('Invalid lease completion');
    }
    const body = {
      action: 'finish', claim_token: token, status: verdict.status,
      reason: verdict.reason, evidence: verdict.evidence,
    };
    const reply = await this.request('POST', id, body);
    if (reply?.finished !== true) throw new Error('Queue did not acknowledge lease completion');
  }
}

function decodeFile(file) {
  if (!file || file.encoding !== 'base64' || typeof file.content !== 'string' || !SHA.test(file.sha ?? ''))
    throw new Error('Missing, incomplete, or malformed control file');
  return Buffer.from(file.content, 'base64').toString('utf8');
}

function reason(status, label, evidence = {}) {
  return { status, reason: label, evidence };
}

// All reads are pinned to ONE live master commit, then master is re-checked.
// A moving control branch can never silently authorize a result.
export async function controlSnapshot(api, row) {
  const ref = await api.request('GET', '/repos/' + CONTROL + '/git/ref/heads/master');
  const sha = ref?.object?.sha;
  if (!SHA.test(sha ?? '')) throw new Error('Unable to read control master head');
  const base = '/repos/' + CONTROL + '/contents/';
  const get = p => api.request('GET', base + p + '?ref=' + sha);
  // Missing project/task files are deterministic "not enrolled" evidence,
  // not transient network failures. Avoid exhausting retry attempts on 404.
  const getOptional = async path => {
    try { return await get(path); }
    catch (error) {
      if (String(error.message).includes('HTTP 404')) return null;
      throw error;
    }
  };
  const [conf, state, project, task, protocol] = await Promise.all([
    get('automation/config.json'),
    get('automation/state.json'),
    getOptional('projects/' + row.project_id + '/project.yaml'),
    getOptional(taskPath(row)),
    get('reviewer/CHATGPT_REVIEW.md'),
  ]);
  return {
    sha,
    config: JSON.parse(decodeFile(conf)),
    state: JSON.parse(decodeFile(state)),
    projectText: project ? decodeFile(project) : null,
    taskText: task ? decodeFile(task) : null,
    taskBlobSha: task?.sha ?? null,
    protocolSha: protocol.sha,
    protocolText: decodeFile(protocol),
  };
}

export async function evaluate({ api, row, now = Date.now() }) {
  const invalid = validateRecord(row, row.id, now);
  if (invalid) return reason('withheld', invalid);
  if (row.status !== 'processing') return reason('failed', 'unclaimed_record');

  // Even a forged row cannot select an arbitrary repo until current master
  // config, task and execution mapping are independently loaded and verified.
  const control = await controlSnapshot(api, row);
  const planning = validatePlanning({
    row, config: control.config, state: control.state,
    projectText: control.projectText, taskText: control.taskText,
    protocolSha: control.protocolSha,
  });
  if (planning.status) return planning;
  const prefix = '/repos/' + row.repository;
  const prPath = prefix + '/pulls/' + row.pr_number;
  const pr = await api.request('GET', prPath);
  const [openPrs, checkRuns, reviews] = await Promise.all([
    api.pages(prefix + '/pulls?state=open'),
    api.pages(prefix + '/commits/' + row.reviewed_sha + '/check-runs', 'check_runs'),
    // Raw REST review commit_id is required; normalized review records are insufficient.
    api.pages(prPath + '/reviews'),
  ]);
  const pin = parseControlPin(pr.body, control.config.controlRepository);
  let pinMatches = null;
  if (pin.present && pin.valid && pin.path === planning.path) {
    try {
      const pinned = await api.request('GET', '/repos/' + CONTROL +
        '/contents/' + pin.path + '?ref=' + pin.sha);
      pinMatches = pinned?.sha === control.taskBlobSha;
    } catch (error) {
      if (!String(error.message).includes('HTTP 404')) throw error;
      pinMatches = false;
    }
  }
  // The review protocol requires AGENTS.md at the target PR base. The
  // deterministic processor verifies it can read this context; it does not
  // claim to have performed a ChatGPT-level code review.
  if (pr?.base?.sha && SHA.test(pr.base.sha)) {
    try {
      const agents = await api.request('GET', prefix + '/contents/AGENTS.md?ref=' + pr.base.sha);
      if (!wordContent(agents)) return reason('withheld', 'target_agent_instructions_missing');
    } catch (error) {
      if (String(error.message).includes('HTTP 404'))
        return reason('withheld', 'target_agent_instructions_missing');
      throw error;
    }
  } else {
    return reason('withheld', 'target_base_commit_missing');
  }

  let decision = validateGitHub({
    row, config: control.config, planning, pr, openPrs, checks: checkRuns,
    reviews, pinMatches, now,
  });
  // Re-read at the end. A changed master or updated PR head invalidates the
  // entire observation, even if it was valid when the first GET completed.
  const [liveControl, livePr] = await Promise.all([
    api.request('GET', '/repos/' + CONTROL + '/git/ref/heads/master'),
    api.request('GET', prPath),
  ]);
  if (liveControl?.object?.sha !== control.sha)
    return reason('stale', 'control_master_advanced', { control_sha: control.sha });
  if (livePr?.head?.sha !== row.reviewed_sha)
    return reason('stale', 'reviewed_head_changed', { control_sha: control.sha });
  if (decision.status === 'dry_run') {
    // A review/CI/label update during the first observation could change the
    // interpretation. Re-read these live facts before recording eligibility.
    const [freshChecks, freshReviews, freshOpenPrs] = await Promise.all([
      api.pages(prefix + '/commits/' + row.reviewed_sha + '/check-runs', 'check_runs'),
      api.pages(prPath + '/reviews'),
      api.pages(prefix + '/pulls?state=open'),
    ]);
    decision = validateGitHub({
      row, config: control.config, planning, pr: livePr, openPrs: freshOpenPrs,
      checks: freshChecks, reviews: freshReviews, pinMatches, now: Date.now(),
    });
  }
  return {
    ...decision,
    evidence: { ...decision.evidence, control_sha: control.sha, protocol_sha: PROTOCOL_BLOB_SHA },
  };
}

function wordContent(file) {
  return file && file.encoding === 'base64' &&
    typeof file.content === 'string' &&
    Buffer.from(file.content, 'base64').toString('utf8').trim().length > 0;
}

// Side-effects only touch the queue API; no PR mutation endpoints exist here.
export async function runDryProcess({ queue, github, id, clock = () => Date.now(), verify = evaluate }) {
  if (!isUuid(id) || !queue || !github) throw new Error('Missing queue ID or read-only clients');
  const current = await queue.get(id);
  if (!current) return { outcome: 'missing' };
  if (terminal(current.status)) return { outcome: 'duplicate_terminal', status: current.status };
  if (current.status === 'processing' && Date.parse(current.lease_until) > clock())
    return { outcome: 'already_processing' };
  const claimed = await queue.claim(id);
  if (!claimed) return { outcome: 'not_claimed', reason: 'other worker or attempts exhausted' };
  if (claimed.id !== id || claimed.test_only !== true || claimed.status !== 'processing' ||
      !isUuid(claimed.claim_token) || Date.parse(claimed.lease_until) <= clock()) {
    throw new Error('Invalid or expired database claim; will not finalize');
  }

  let decision;
  try {
    decision = await verify({ api: github, row: claimed, now: clock() });
    if (!decision || !['dry_run', 'stale', 'withheld', 'failed'].includes(decision.status) ||
        !SAFE_REASON.test(decision.reason ?? ''))
      throw new Error('Guard evaluator returned an unexpected result');
  } catch (error) {
    // A transient GitHub failure is NOT a negative review. Retry only after
    // the current claim has been safely released, within the database cap.
    await queue.finish(id, claimed.claim_token, reason('retryable', 'transient_validation_error'));
    throw error;
  }
  await queue.finish(id, claimed.claim_token, decision);
  return { outcome: 'evaluated', ...decision };
}

async function main() {
  const id = process.env.QUEUE_ID;
  if (!isUuid(id)) throw new Error('QUEUE_ID must be one UUID');
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN missing; no claim attempted');
  if (!process.env.REVIEW_BRIDGE_QUEUE_TOKEN) throw new Error('Queue token missing; no claim attempted');
  if (process.env.GITHUB_REPOSITORY !== CONTROL || process.env.GITHUB_REF !== 'refs/heads/master')
    throw new Error('Bridge must run on the control default branch');
  const queue = new QueueApi(process.env.REVIEW_BRIDGE_QUEUE_TOKEN);
  const github = new GitHub(process.env.GH_TOKEN);
  const outcome = await runDryProcess({ queue, github, id });
  console.info('Bridge Step 3:', outcome.outcome, outcome.status ?? '', outcome.reason ?? '', id);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '# Review bridge: mandatory dry run\n\n' +
      '- Queue: ' + id + '\n' +
      '- Outcome: ' + outcome.outcome + '\n' +
      '- Validation: ' + (outcome.status ?? 'not evaluated') + '\n' +
      '- Reason: ' + (outcome.reason ?? 'none') + '\n' +
      '- No GitHub review, merge or worker dispatch attempted.\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Review bridge stopped:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}
