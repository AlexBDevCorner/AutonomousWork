// Pure orchestration rules. Inputs are validated planning data and GitHub observations.
export function validateConfig(config) {
  const keys = ['version', 'enabled', 'controlRepository', 'controlBranch', 'projects', 'maxAttempts',
    'maxCorrectionRounds', 'maxStartsPerProjectPerDay', 'dispatchGraceMinutes', 'maxRunMinutes',
    'reviewers', 'requiredChecks'];
  if (Object.keys(config).some(k => !keys.includes(k)) || keys.some(k => !(k in config)))
    throw new Error('Unknown or missing automation configuration property.');
  if (config.version !== 1 || typeof config.enabled !== 'boolean') throw new Error('Invalid automation version/enabled.');
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.controlRepository) || !/^[\w./-]+$/.test(config.controlBranch))
    throw new Error('Invalid control repository/branch.');
  for (const k of ['maxAttempts', 'maxCorrectionRounds', 'maxStartsPerProjectPerDay', 'dispatchGraceMinutes', 'maxRunMinutes'])
    if (!Number.isInteger(config[k]) || config[k] < 1 || config[k] > 120) throw new Error(`Invalid limit: ${k}`);
  for (const k of ['reviewers', 'requiredChecks'])
    if (!Array.isArray(config[k]) || config[k].some(v => typeof v !== 'string' || !v.trim())) throw new Error(`Invalid ${k}`);
  if (!config.requiredChecks.length) throw new Error('At least one required CI check is needed.');
  if (!config.projects || Array.isArray(config.projects)) throw new Error('Invalid projects allowlist.');
  for (const [id, project] of Object.entries(config.projects)) {
    if (!/^[a-z0-9-]+$/.test(id) || Object.keys(project).some(k => !['branch', 'workflow', 'allowedTasks'].includes(k)) ||
        !/^[\w./-]+$/.test(project.branch) || !/^[\w.-]+\.ya?ml$/.test(project.workflow) ||
        !Array.isArray(project.allowedTasks) || !project.allowedTasks.length ||
        project.allowedTasks.some(t => !/^[A-Z]+-\d+$/.test(t))) throw new Error(`Invalid project allowlist: ${id}`);
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

export function ciGreen(checks, requiredChecks) {
  return requiredChecks.every(name => {
    const latest = checks.filter(c => c.name === name).sort((a, b) => b.id - a.id)[0];
    return latest?.status === 'completed' && latest.conclusion === 'success';
  });
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
    const starts = records.flatMap(e => e.attempts).filter(a => a.startedAt.slice(0, 10) === new Date(now).toISOString().slice(0, 10));
    if (starts.length >= config.maxStartsPerProjectPerDay) continue;
    const open = snapshot.prs.filter(pr => pr.state === 'open' && autonomousPr(pr));
    if (open.length) {
      if (open.length !== 1) continue;
      const pr = open[0];
      const record = records.find(e => e.pr === pr.number && e.status === 'review');
      if (!record || !target.allowedTasks.includes(record.taskId) || byId.get(record.taskId)?.status !== 'review') continue;
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
      if (!target.allowedTasks.includes(task.id) || records.some(e => e.taskId === task.id) ||
          !task.dependsOn.every(id => byId.get(id)?.status === 'done')) continue;
      // Closed historical PRs must be reconciled by an operator, never reopened automatically.
      if (snapshot.prs.some(pr => pr.head.ref === `autonomous/${task.id}`)) continue;
      candidates.push({ project, task, kind: 'implementation' });
    }
  }
  return candidates.sort((a, b) => b.task.priority - a.task.priority || a.task.id.localeCompare(b.task.id, 'en'))[0] ?? null;
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
    '| Project | Task | State | PR | Attempts / corrections | Last result |', '| --- | --- | --- | --- | --- | --- |'];
  for (const p of catalog.projects) {
    const records = state.executions.filter(e => e.projectId === p.id);
    if (!records.length) lines.push(`| ${p.id} | none | ${p.enabled && config.projects[p.id] ? 'idle' : 'not enrolled'} | | 0 / 0 | |`);
    for (const e of records) lines.push(`| ${p.id} | ${e.taskId} | ${e.status} | ${e.prUrl ? `[#${e.pr}](${e.prUrl})` : ''} | ${e.attempts.length} / ${e.attempts.filter(a => a.kind === 'correction').length} | ${e.blockReason ?? latestAttempt(e).conclusion ?? 'pending'} |`);
  }
  return lines.join('\n') + '\n';
}
