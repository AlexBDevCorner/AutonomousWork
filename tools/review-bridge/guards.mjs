// Pure Step 3 guard checks. Queue data is input, not authorization.
// No functions in this module mutate GitHub or dispatch a worker.
import { validateConfig } from '../autonomy/policy.mjs';

const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const VERDICTS = new Set(['APPROVE', 'REQUEST_CHANGES', 'WITHHOLD', 'MERGE_CHECK']);
const TERMINAL = new Set(['applied', 'dry_run', 'stale', 'withheld', 'failed']);
export const OBSERVATION_MAX_AGE_MS = 3 * 60 * 60 * 1000;
export const PROTOCOL_BLOB_SHA = 'f503c2fe085fafa666026923ff352b7140ea517e';
const result = (status, reason, evidence = {}) => ({ status, reason, evidence });
const word = x => typeof x === 'string' && x.trim().length > 0;
// Keep validation and the posted GitHub review on the same finding-text contract.
export function findingDescription(finding) {
  if (!finding || typeof finding !== 'object') return null;
  const narrative = [finding.description, finding.message, finding.summary, finding.explanation].find(word);
  if (narrative) return narrative;
  // Some scheduled reviewers document a concrete reproduction and consequence instead of
  // using a generic explanation field. Require both, and preserve both in the posted review.
  if (word(finding.reproduction) && word(finding.consequence))
    return [finding.title, finding.reproduction, 'Consequence: ' + finding.consequence]
      .filter(word).join(' ');
  return null;
}
const lower = x => String(x ?? '').toLowerCase();
export const isUuid = x => typeof x === 'string' && UUID.test(x);
export const terminal = value => TERMINAL.has(value);

export function validateRecord(row, id, now = Date.now(), live = false) {
  if (!row || row.id !== id || !isUuid(id)) return 'invalid_or_mismatched_queue_id';
  if (row.schema_version !== 1 || row.source !== 'chatgpt-scheduled') return 'unknown_queue_schema_or_source';
  if (live) {
    if (row.test_only !== false || !/^AlexBDevCorner\/[A-Za-z0-9_.-]+$/.test(row.repository))
      return 'outside_live_review_scope';
  } else if (row.test_only !== true) return 'production_verdicts_not_enabled';
  if (!['queued', 'processing', 'retryable', ...TERMINAL].includes(row.status)) return 'invalid_queue_status';
  if (!word(row.repository) || !/^AlexBDevCorner\/[A-Za-z0-9_.-]+$/.test(row.repository) ||
      !word(row.project_id) || !/^[a-z0-9-]+$/.test(row.project_id) ||
      !word(row.task_id) || !/^[A-Z][A-Z0-9]*-[0-9]+$/.test(row.task_id) ||
      !Number.isSafeInteger(row.pr_number) || row.pr_number < 1 ||
      !SHA.test(row.reviewed_sha ?? '') || !VERDICTS.has(row.verdict) ||
      !Array.isArray(row.findings) || !row.ci || typeof row.ci !== 'object' || Array.isArray(row.ci) ||
      typeof row.review_summary !== 'string' || !word(row.observed_at) ||
      !Number.isFinite(Date.parse(row.observed_at))) return 'invalid_queue_metadata';
  if (Date.parse(row.observed_at) > now + 5 * 60000) return 'observation_from_future';
  return null;
}

// Authorization YAML deliberately uses only simple exact scalar keys.
// Duplicates, aliases and missing keys fail closed.
function scalar(text, key) {
  if (typeof text !== 'string') return null;
  const matches = [...text.matchAll(new RegExp('^' + key + ':[ \t]*([^\r\n#]+)', 'gm'))];
  if (matches.length !== 1) return null;
  const raw = matches[0][1].trim();
  if (/^['"]/.test(raw)) return raw.replace(/^(['"])(.*)\1$/, '$2');
  return raw;
}
export const taskPath = row => 'projects/' + row.project_id + '/tasks/' + row.task_id + '.md';

export function validatePlanning({ row, config, state, projectText, taskText, protocolSha }) {
  if (protocolSha !== PROTOCOL_BLOB_SHA) return result('withheld', 'review_protocol_changed_reaudit_required');
  try { validateConfig(config); } catch { return result('withheld', 'invalid_control_config'); }
  if (config.controlRepository !== 'AlexBDevCorner/AutonomousWork' ||
      config.controlBranch !== 'master' || !config.enabled)
    return result('withheld', 'global_control_disabled_or_changed');
  const target = config.projects[row.project_id];
  if (!target?.branch || !target.workflow) return result('withheld', 'project_not_enrolled');
  if (scalar(projectText, 'id') !== row.project_id ||
      scalar(projectText, 'repository') !== row.repository ||
      scalar(projectText, 'enabled') !== 'true')
    return result('withheld', 'project_disabled_or_mapping_invalid');
  if (!state || state.version !== 1 || !Array.isArray(state.executions))
    return result('withheld', 'invalid_control_state');
  const matches = state.executions.filter(e => e.taskId === row.task_id);
  if (matches.length !== 1) return result('withheld', 'missing_or_duplicate_task_execution');
  const execution = matches[0];
  if (execution.projectId !== row.project_id ||
      execution.repository !== row.repository ||
      execution.pr !== row.pr_number)
    return result('withheld', 'recorded_execution_mapping_mismatch');
  const exceptional = execution.status === 'blocked' && execution.blockReason === 'worker_failure';
  if (execution.status !== 'review' && !exceptional)
    return result('withheld', 'execution_not_review_eligible');
  const front = typeof taskText === 'string'
    ? taskText.match(/^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/) : null;
  if (!front || scalar(front[1], 'id') !== row.task_id ||
      scalar(front[1], 'status') !== execution.status)
    return result('withheld', 'task_spec_missing_or_status_mismatch');
  return { target, execution, exceptional, path: taskPath(row) };
}

export function requiredCheckState(checks, names, sha) {
  if (!Array.isArray(checks) || !Array.isArray(names) || !names.length) return 'pending';
  let pending = false, failed = false;
  for (const name of names) {
    // An unrelated App cannot spoof the named required GitHub Actions check.
    const candidates = checks.filter(c => c.name === name && c.head_sha === sha &&
      c.app?.slug === 'github-actions' && Number.isSafeInteger(c.id))
      .sort((a, b) => b.id - a.id);
    const latest = candidates[0];
    if (!latest || latest.status !== 'completed') pending = true;
    else if (latest.conclusion !== 'success') failed = true;
  }
  return failed ? 'failed' : pending ? 'pending' : 'green';
}

export function latestTrustedReview(reviews, reviewers, head, author) {
  if (!Array.isArray(reviews) || !Array.isArray(reviewers)) return null;
  const allowed = new Set(reviewers.map(lower).filter(name => name && name !== lower(author)));
  return reviews.filter(r => allowed.has(lower(r.user?.login)) &&
      r.commit_id === head && ['APPROVED', 'CHANGES_REQUESTED'].includes(r.state) &&
      Number.isFinite(Date.parse(r.submitted_at)) && Number.isSafeInteger(r.id))
    .sort((a,b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at) || a.id - b.id)
    .at(-1) ?? null;
}

export function parseControlPin(prBody, expectedRepository) {
  const body = typeof prBody === 'string' ? prBody : '';
  if (!body.includes(expectedRepository + '@')) return { present: false };
  const pattern = expectedRepository.replace('/', '\\/') +
    '@([a-f0-9]{40}):\\s*(projects/[a-z0-9-]+/tasks/[A-Z][A-Z0-9]*-[0-9]+\\.md)';
  const matches = [...body.matchAll(new RegExp(pattern, 'g'))];
  if (matches.length !== 1) return { present: true, valid: false };
  return { present: true, valid: true, sha: matches[0][1], path: matches[0][2] };
}

function documentedBlockingFindings(findings) {
  const blocks = findings.filter(f => f && typeof f === 'object' && ['P0','P1'].includes(f.severity));
  return blocks.length > 0 && blocks.every(f => findingDescription(f) &&
    ((word(f.path) && Number.isSafeInteger(f.line) && f.line > 0) || word(f.location)));
}

export function validateGitHub({ row, config, planning, pr, openPrs, checks, reviews, pinMatches, now = Date.now() }) {
  if (!planning?.target) return result('withheld', 'planning_not_verified');
  if (Date.parse(row.observed_at) < now - OBSERVATION_MAX_AGE_MS)
    return result('stale', 'observation_expired');
  if (!pr || !Array.isArray(openPrs) || !Array.isArray(checks) || !Array.isArray(reviews))
    return result('withheld', 'missing_live_github_evidence');
  if (pr.number !== row.pr_number || pr.state !== 'open' || pr.draft !== false ||
      pr.mergeable !== true || !word(pr.user?.login))
    return result('withheld', 'pr_closed_draft_unmergeable_or_unknown');
  if (pr.head?.repo?.full_name !== row.repository ||
      pr.head.ref !== 'autonomous/' + row.task_id ||
      pr.base?.repo?.full_name !== row.repository ||
      pr.base.ref !== planning.target.branch)
    return result('withheld', 'pr_repository_branch_or_base_mismatch');
  if (pr.head.sha !== row.reviewed_sha) return result('stale', 'reviewed_head_changed');
  const taskOpen = openPrs.filter(item => item.state === 'open' &&
    item.head?.ref === 'autonomous/' + row.task_id &&
    item.head?.repo?.full_name === row.repository);
  if (taskOpen.length !== 1 || taskOpen[0].number !== row.pr_number)
    return result('withheld', 'duplicate_or_missing_autonomous_pr');
  for (const label of pr.labels ?? []) {
    const name = typeof label === 'string' ? label : label?.name;
    if (typeof name !== 'string') continue;
    if (name.startsWith('task:') && name !== 'task:' + row.task_id ||
        name.startsWith('project:') && name !== 'project:' + row.project_id)
      return result('withheld', 'contradictory_pr_labels');
  }
  const pin = parseControlPin(pr.body, config.controlRepository);
  if (pin.present && (!pin.valid || pin.path !== planning.path || pinMatches !== true))
    return result('stale', 'control_specification_pin_mismatch');
  const ci = requiredCheckState(checks, config.requiredChecks, row.reviewed_sha);
  const review = latestTrustedReview(reviews, config.reviewers, row.reviewed_sha, pr.user.login);
  const evidence = {
    repository: row.repository, task_id: row.task_id, pr: row.pr_number,
    reviewed_sha: row.reviewed_sha, ci,
    latest_trusted_review_id: review?.id ?? null,
    latest_trusted_review_state: review?.state ?? null,
    control_pin_verified: pin.present ? true : null,
  };
  if (row.verdict === 'WITHHOLD') return result('withheld', 'reviewer_withheld', evidence);
  if (!config.reviewers.some(x => lower(x) !== lower(pr.user.login)))
    return result('withheld', 'no_separate_trusted_reviewer', evidence);
  if (planning.exceptional && ci !== 'green')
    return result('withheld', 'worker_failure_exception_requires_green_ci', evidence);
  if (row.verdict === 'MERGE_CHECK') {
    if (planning.exceptional) return result('withheld', 'blocked_execution_cannot_merge', evidence);
    if (ci !== 'green') return result('withheld', 'merge_requires_green_ci', evidence);
    if (!review || review.state !== 'APPROVED')
      return result('withheld', 'merge_requires_latest_same_head_trusted_approval', evidence);
    return result('dry_run', 'merge_guards_passed_no_mutation', evidence);
  }
  // Raw REST commit_id is mandatory; old-head and COMMENTED reviews don't count.
  if (review) return result('withheld', 'trusted_same_head_verdict_exists', evidence);
  if (row.verdict === 'APPROVE') {
    if (row.findings.some(f => f && ['P0','P1'].includes(f.severity)))
      return result('withheld', 'blocking_findings_forbid_approval', evidence);
    if (ci !== 'green') return result('withheld', 'approval_requires_green_ci', evidence);
    return result('dry_run', 'review_guards_passed_no_mutation', evidence);
  }
  if (row.verdict === 'REQUEST_CHANGES') {
    if (!documentedBlockingFindings(row.findings))
      return result('withheld', 'no_documented_blocking_findings', evidence);
    return result('dry_run', 'blocking_findings_recorded_no_mutation', evidence);
  }
  return result('withheld', 'unknown_verdict', evidence);
}
