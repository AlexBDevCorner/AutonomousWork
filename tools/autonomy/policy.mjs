// Pure orchestration rules. Inputs are validated planning data and GitHub observations.
export function validateConfig(config) {
  const keys = ['version', 'enabled', 'controlRepository', 'controlBranch', 'projects', 'maxAttempts',
    'maxCorrectionRounds', 'dispatchGraceMinutes', 'maxRunMinutes',
    'reviewers', 'requiredChecks'];
  if (Object.keys(config).some(k => !keys.includes(k)) || keys.some(k => !(k in config)))
    throw new Error('Unknown or missing automation configuration property.');
  if (config.version !== 1 || typeof config.enabled !== 'boolean') throw new Error('Invalid automation version/enabled.');
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.controlRepository) || !/^[\w./-]+$/.test(config.controlBranch))
    throw new Error('Invalid control repository/branch.');
  for (const k of ['maxAttempts', 'maxCorrectionRounds', 'dispatchGraceMinutes'])
    if (!Number.isInteger(config[k]) || config[k] < 1 || config[k] > 120) throw new Error(`Invalid limit: ${k}`);
  if (!Number.isInteger(config.maxRunMinutes) || config.maxRunMinutes < 1 || config.maxRunMinutes > 360)
    throw new Error('Invalid limit: maxRunMinutes');
  for (const k of ['reviewers', 'requiredChecks'])
    if (!Array.isArray(config[k]) || config[k].some(v => typeof v !== 'string' || !v.trim())) throw new Error(`Invalid ${k}`);
  if (!config.requiredChecks.length) throw new Error('At least one required CI check is needed.');
  if (!config.projects || Array.isArray(config.projects)) throw new Error('Invalid projects configuration.');
  for (const [id, project] of Object.entries(config.projects)) {
    if (!/^[a-z0-9-]+$/.test(id) || Object.keys(project).some(k => !['branch', 'workflow', 'reviewEnabled'].includes(k)) ||
        (project.reviewEnabled !== undefined && typeof project.reviewEnabled !== 'boolean') ||
        !/^[\w./-]+$/.test(project.branch) || !/^[\w.-]+\.ya?ml$/.test(project.workflow))
      throw new Error(`Invalid project configuration: ${id}`);
  }
}

export const activeRun = run => run.status !== 'completed';
export const autonomousPr = pr => pr.head.ref.startsWith('autonomous/') || pr.labels.some(l => l.name === 'autonomous');
export const runTitle = (taskId, attemptId) => `autonomy ${taskId} ${attemptId}`;
export const latestAttempt = execution => execution.attempts.at(-1);

export function latestReview(pr, reviews, reviewers) {
  // Only submitted, trusted reviews of the exact current head count. Comments never authorize a fix.
  return reviews.filter(r => reviewers.includes(r.user.login) && r.commit_id === pr.head.sha &&
    ['APPROVED', 'CHANGES_REQUESTED'].includes(r.state))
    .sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at) || a.id - b.id).at(-1);
}

export function reviewDisagreement(pr, comments, reviewId, reviewedHead) {
  const marker = '<!-- autonomous-review-disagreement:v1 -->';
  const reviewLine = `Review-ID: ${reviewId}`;
  const headLine = `Reviewed-SHA: ${reviewedHead}`;
  return comments.filter(c => c.user?.login === pr.user?.login && typeof c.body === 'string' &&
    c.body.includes(marker) && c.body.includes(reviewLine) && c.body.includes(headLine))
    .sort((a, b) => Date.parse(a.created_at ?? 0) - Date.parse(b.created_at ?? 0) || a.id - b.id).at(-1);
}

export function requiredCiState(checks, requiredChecks) {
  const latest = requiredChecks.map(name =>
    checks.filter(c => c.name === name).sort((a, b) => b.id - a.id)[0]);
  if (latest.some(check => !check || check.status !== 'completed'))
    return { state: 'pending', latest: latest.filter(Boolean), failed: [] };
  const failed = latest.filter(check => check.conclusion !== 'success');
  return { state: failed.length ? 'failed' : 'green', latest, failed };
}

export function ciGreen(checks, requiredChecks) {
  return requiredCiState(checks, requiredChecks).state === 'green';
}

export function reconcile(execution, snapshot, config, now) {
  const result = structuredClone(execution);
  const prs = snapshot.prs.filter(pr => pr.head.ref === `autonomous/${execution.taskId}` &&
    pr.head.repo?.full_name === execution.repository);
  const block = reason => ({ ...result, status: 'blocked', blockReason: reason });
  if (prs.length > 1) return block('multiple_task_pull_requests');
  const pr = prs[0];
  if (pr && pr.base.ref !== config.projects[execution.projectId].branch) return block('wrong_pull_request_base');
  if (pr) {
    result.pr = pr.number;
    result.headSha = pr.head.sha;
    result.prUrl = pr.html_url;
    if (pr.merged_at) {
      if (!pr.merge_commit_sha) return block('missing_merge_evidence');
      return { ...result, status: 'done', blockReason: null, completedAt: pr.merged_at, mergeSha: pr.merge_commit_sha };
    }
    if (pr.state === 'closed') return block('pull_request_closed_without_merge');
    if (pr.mergeable === false) return block('merge_conflict');
  }
  const attempt = latestAttempt(result);
  const runs = snapshot.runs.filter(r => r.display_title === runTitle(execution.taskId, attempt.id));
  if (runs.length > 1) return block('duplicate_workflow_runs');
  const run = runs[0];
  if (run) {
    attempt.runId = run.id;
    attempt.runUrl = run.html_url;
    attempt.conclusion = run.conclusion;
    attempt.completedAt = run.updated_at;
    if (activeRun(run)) {
      attempt.completedAt = null;
      if (now - Date.parse(run.run_started_at ?? run.created_at) > config.maxRunMinutes * 60000)
        return block('worker_time_limit_exceeded');
      return { ...result, status: 'in_progress', blockReason: null };
    }
    if (run.conclusion !== 'success') return block(`worker_${run.conclusion ?? 'failed'}`);
    if (!pr) return block('worker_succeeded_without_pull_request');
    if (attempt.kind === 'correction' && pr.head.sha === attempt.headSha) {
      const disagreement = reviewDisagreement(pr, snapshot.comments?.[pr.number] ?? [], attempt.reviewId, attempt.headSha);
      if (disagreement) return { ...result, status: 'blocked', blockReason: 'autonomous_review_disagreement',
        disagreementUrl: disagreement.html_url ?? null };
      return block('correction_did_not_advance_head');
    }
    return { ...result, status: 'review', blockReason: null };
  }
  // Never resend an uncertain POST. GitHub may have accepted it before the client timed out.
  if (now - Date.parse(attempt.startedAt) > config.dispatchGraceMinutes * 60000)
    return block('dispatch_not_observed');
  return result;
}

export function chooseWork(catalog, state, snapshots, config, now) {
  if (!config.enabled) return null;
  const byId = new Map(catalog.tasks.map(t => [t.id, t]));
  const candidates = [];
  for (const project of catalog.projects) {
    const target = config.projects[project.id];
    if (!project.enabled || !target) continue;
    const snapshot = snapshots[project.id];
    if (!snapshot || snapshot.runs.some(activeRun)) continue;
    const records = state.executions.filter(e => e.projectId === project.id);
    const open = snapshot.prs.filter(pr => pr.state === 'open' && autonomousPr(pr));
    if (open.length) {
      if (open.length !== 1) continue;
      const pr = open[0];
      const record = records.find(e => e.pr === pr.number && e.status === 'review');
      if (!record || byId.get(record.taskId)?.status !== 'review') continue;
      const ci = requiredCiState(snapshot.checks[pr.number] ?? [], config.requiredChecks);
      if (ci.state === 'failed') {
        if (record.attempts.filter(a => a.reason === 'ci_repair').length >= config.maxCorrectionRounds) continue;
        candidates.push({ project, task: byId.get(record.taskId), kind: 'implementation', reason: 'ci_repair',
          pr: pr.number, headSha: pr.head.sha });
        continue;
      }
      if (ci.state !== 'green') continue;
      const review = latestReview(pr, snapshot.reviews[pr.number] ?? [], config.reviewers);
      if (review?.state !== 'CHANGES_REQUESTED' || record.attempts.some(a => a.reviewId === review.id)) continue;
      if (record.attempts.filter(a => a.kind === 'correction').length >= config.maxCorrectionRounds) continue;
      candidates.push({ project, task: byId.get(record.taskId), kind: 'correction', pr: pr.number,
        headSha: pr.head.sha, reviewId: review.id });
      continue;
    }
    // Recorded review and blocked work hold the project, even if labels are missing or GitHub is inconsistent.
    if (records.some(e => ['in_progress', 'review', 'blocked'].includes(e.status)) ||
        catalog.tasks.some(t => t.projectId === project.id && ['in_progress', 'review'].includes(t.status))) continue;
    for (const task of catalog.tasks.filter(t => t.projectId === project.id && t.status === 'ready')) {
      if (records.some(e => e.taskId === task.id) ||
          !task.dependsOn.every(id => byId.get(id)?.status === 'done')) continue;
      // Closed historical PRs must be reconciled by an operator, never reopened automatically.
      if (snapshot.prs.some(pr => pr.head.ref === `autonomous/${task.id}`)) continue;
      candidates.push({ project, task, kind: 'implementation' });
    }
  }
  return candidates.sort((a, b) => b.task.priority - a.task.priority || a.task.id.localeCompare(b.task.id, 'en'))[0] ?? null;
}

const retryableWorkerFailures = new Map([
  ['worker_failure', 'failure'],
  ['worker_cancelled', 'cancelled'],
  ['worker_timed_out', 'timed_out'],
]);

export function chooseRetry(taskId, catalog, state, snapshots, config, now) {
  if (!config.enabled) return null;
  const task = catalog.tasks.find(t => t.id === taskId);
  const project = catalog.projects.find(p => p.id === task?.projectId);
  const execution = state.executions.find(e => e.taskId === taskId);
  if (!task || !project || !project.enabled || !config.projects[project.id] ||
      task.status !== 'blocked' || execution?.status !== 'blocked' ||
      execution.projectId !== project.id || execution.repository !== project.repository ||
      !task.dependsOn.every(id => catalog.tasks.find(t => t.id === id)?.status === 'done'))
    return null;

  const expectedConclusion = retryableWorkerFailures.get(execution.blockReason);
  const attempt = execution.attempts.at(-1);
  if (!expectedConclusion || attempt?.kind !== 'implementation' ||
      attempt.conclusion !== expectedConclusion || !attempt.runId || !attempt.completedAt ||
      execution.attempts.filter(a => a.kind === 'implementation').length >= config.maxAttempts)
    return null;

  const snapshot = snapshots[project.id];
  if (!snapshot || snapshot.runs.some(activeRun)) return null;
  const taskPrs = snapshot.prs.filter(pr => pr.head.ref === `autonomous/${taskId}` &&
    pr.head.repo?.full_name === project.repository);
  if (taskPrs.length > 1) return null;
  const taskPr = taskPrs[0];
  if (taskPr && (taskPr.state !== 'open' || taskPr.base.ref !== config.projects[project.id].branch ||
      taskPr.mergeable === false)) return null;

  const otherOpen = snapshot.prs.filter(pr => pr.state === 'open' && autonomousPr(pr) && pr !== taskPr);
  if (otherOpen.length) return null;

  return { project, task, kind: 'implementation', retry: true,
    ...(taskPr ? { pr: taskPr.number, headSha: taskPr.head.sha } : {}) };
}

export function replaceStatus(text, expected, status) {
  if (!['in_progress', 'review', 'blocked', 'done'].includes(status)) throw new Error('Automation cannot authorize planning work.');
  const front = text.match(/^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!front) throw new Error('Missing front matter.');
  const lines = [...front[1].matchAll(/^status:[^\r\n]*$/gm)];
  if (lines.length !== 1) throw new Error('Expected exactly one status property.');
  const current = lines[0][0].slice(7).split('#')[0].trim().replace(/^['"]|['"]$/g, '');
  if (current !== expected) throw new Error(`Task changed concurrently: expected ${expected}, found ${current}`);
  const offset = front[0].indexOf(front[1]) + lines[0].index;
  return text.slice(0, offset) + `status: ${status}` + text.slice(offset + lines[0][0].length);
}

export function summary(catalog, state, config) {
  const lines = ['# Autonomous development status', '', `Automatic execution: ${config.enabled ? 'enabled' : 'paused'}.`, '',
    '| Project | Task | State | PR | Attempts / review fixes / CI repairs | Last result |', '| --- | --- | --- | --- | --- | --- |'];
  for (const p of catalog.projects) {
    const records = state.executions.filter(e => e.projectId === p.id);
    if (!records.length) lines.push(`| ${p.id} | none | ${p.enabled && config.projects[p.id] ? 'idle' : 'not enrolled'} | | 0 / 0 / 0 | |`);
    for (const e of records) lines.push(`| ${p.id} | ${e.taskId} | ${e.status} | ${e.prUrl ? `[#${e.pr}](${e.prUrl})` : ''} | ${e.attempts.length} / ${e.attempts.filter(a => a.kind === 'correction').length} / ${e.attempts.filter(a => a.reason === 'ci_repair').length} | ${e.blockReason ?? latestAttempt(e).conclusion ?? 'pending'} |`);
  }
  return lines.join('\n') + '\n';
}
