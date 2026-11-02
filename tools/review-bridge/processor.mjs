// Deterministic review/merge guard evaluation against live control and GitHub state.
// Never imports any GitHub write API.
import { Buffer } from 'node:buffer';
import {
  validateRecord, validatePlanning, validateGitHub,
  parseControlPin, taskPath, PROTOCOL_BLOB_SHA,
} from './guards.mjs';

const CONTROL = 'AlexBDevCorner/AutonomousWork';
const SHA = /^[a-f0-9]{40}$/;

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

export async function evaluate({ api, row, now = Date.now(), live = false }) {
  const invalid = validateRecord(row, row.id, now, live);
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
  // Project enrollment is the permanent, per-project review enablement gate.
  // Disabling a project stops both fresh review posts and future merges.
  if (live && planning.target.reviewEnabled !== true)
    return reason('withheld', 'project_review_disabled');
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
  // claim to have performed a model-level code review.
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
