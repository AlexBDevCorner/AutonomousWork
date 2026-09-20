import { randomUUID } from 'node:crypto';
import { chooseWork, chooseRetry, reconcile, latestAttempt, latestReview, ciGreen, replaceStatus, summary, validateConfig } from './policy.mjs';

export function validateState(catalog, state, config) {
  validateConfig(config);
  if (state.version !== 1 || !Array.isArray(state.executions)) throw new Error('Invalid execution state.');
  const taskIds = new Set(), attemptIds = new Set(), repos = new Set();
  for (const p of catalog.projects) {
    if (repos.has(p.repository.toLowerCase())) throw new Error('Projects must have distinct target repositories.');
    repos.add(p.repository.toLowerCase());
  }
  for (const id of Object.keys(config.projects)) {
    if (!catalog.projects.some(p => p.id === id)) throw new Error(`Unknown enrolled project: ${id}`);
  }
  for (const e of state.executions) {
    const task = catalog.tasks.find(t => t.id === e.taskId);
    const project = catalog.projects.find(p => p.id === e.projectId);
    if (!task || task.projectId !== e.projectId || project?.repository !== e.repository ||
        !config.projects[e.projectId] || taskIds.has(e.taskId) || !Array.isArray(e.attempts) || !e.attempts.length ||
        !['in_progress', 'review', 'blocked', 'done'].includes(e.status)) throw new Error('Invalid or duplicate execution record.');
    taskIds.add(e.taskId);
    for (const a of e.attempts) {
      if (!/^[a-f0-9-]{36}$/.test(a.id) || attemptIds.has(a.id) || !Number.isFinite(Date.parse(a.startedAt)) ||
          !['implementation', 'correction'].includes(a.kind)) throw new Error('Invalid or duplicate execution attempt.');
      attemptIds.add(a.id);
    }
  }
}

// All side effects are injected. This makes dispatch ordering, races, and ambiguous failures testable.
export async function coordinate({ catalog, state: initial, config, sourceSha, taskTexts, api, apply = false,
  retryTaskId = null, now = Date.now(), newId = randomUUID }) {
  validateState(catalog, initial, config);
  const state = structuredClone(initial), model = structuredClone(catalog), texts = { ...taskTexts };
  let parent = sourceSha;
  const changes = {}, snapshots = {}, reviewQueue = [];
  const status = (record, next) => {
    const task = model.tasks.find(t => t.id === record.taskId);
    if (task.status === next) return;
    texts[task.relativePath] = replaceStatus(texts[task.relativePath], task.status, next);
    changes[task.relativePath] = texts[task.relativePath];
    task.status = next;
  };
  for (const project of model.projects.filter(p => config.projects[p.id])) {
    snapshots[project.id] = await api.snapshot(project.repository, config.projects[project.id], state.executions.filter(e => e.projectId === project.id));
  }
  for (let i = 0; i < state.executions.length; i++) {
    const e = state.executions[i], task = model.tasks.find(t => t.id === e.taskId);
    // Human status edits win. Do not silently reset a blocked or completed task.
    if (task.status !== e.status) throw new Error(`Task ${e.taskId} and execution state disagree; reconcile the operator edit explicitly.`);
    if (e.status === 'done') continue;
    let next = reconcile(e, snapshots[e.projectId], config, now);
    // A blocked execution requires operator resolution; new observations may only complete a manual merge.
    if (e.status === 'blocked' && next.status !== 'done') next = { ...next, status: 'blocked', blockReason: e.blockReason };
    const pr = snapshots[e.projectId].prs.find(p => p.number === next.pr);
    if (pr && next.status === 'review') {
      const review = latestReview(pr, snapshots[e.projectId].reviews[pr.number] ?? [], config.reviewers);
      if (review?.state === 'CHANGES_REQUESTED' && next.attempts.filter(a => a.kind === 'correction').length >= config.maxCorrectionRounds)
        next = { ...next, status: 'blocked', blockReason: 'autonomous_review_loop_exceeded' };
      if (!review && !pr.draft) reviewQueue.push({ repository: e.repository, taskId: e.taskId, pr: pr.number,
        headSha: pr.head.sha, ciGreen: ciGreen(snapshots[e.projectId].checks[pr.number] ?? [], config.requiredChecks),
        taskPath: task.relativePath, sourceControlSha: latestAttempt(e).sourceControlSha });
    }
    state.executions[i] = next;
    status(next, next.status);
  }
  const selected = retryTaskId
    ? chooseRetry(retryTaskId, model, state, snapshots, config, now)
    : chooseWork(model, state, snapshots, config, now);
  if (retryTaskId && !selected)
    throw new Error(`Blocked task ${retryTaskId} is not eligible for a bounded implementation retry.`);
  async function save(message) {
    const files = { ...changes, 'automation/state.json': JSON.stringify(state, null, 2) + '\n',
      'automation/STATUS.md': summary(model, state, config) };
    parent = await api.commitFiles(config.controlRepository, config.controlBranch, parent, files, message);
    for (const key of Object.keys(changes)) delete changes[key];
  }
  if (selected && apply) {
    // Re-observe the target immediately before claiming. Worker repeats the guard after queueing.
    snapshots[selected.project.id] = await api.snapshot(selected.project.repository, config.projects[selected.project.id], state.executions.filter(e => e.projectId === selected.project.id));
    const fresh = retryTaskId
      ? chooseRetry(retryTaskId, model, state, snapshots, config, now)
      : chooseWork(model, state, snapshots, config, now);
    if (!fresh || fresh.task.id !== selected.task.id || fresh.headSha !== selected.headSha || fresh.reviewId !== selected.reviewId)
      throw new Error('Target changed during dispatch planning; no claim or dispatch made.');
    let execution = state.executions.find(e => e.taskId === selected.task.id);
    if (!execution) {
      execution = { taskId: selected.task.id, projectId: selected.project.id, repository: selected.project.repository,
        status: 'in_progress', attempts: [] };
      state.executions.push(execution);
    }
    const attempt = { id: newId(), kind: selected.kind, startedAt: new Date(now).toISOString(), sourceControlSha: sourceSha,
      dispatchStatus: 'pending', ...(selected.reviewId ? { reviewId: selected.reviewId, headSha: selected.headSha } : {}) };
    if (selected.kind === 'implementation' && execution.attempts.filter(a => a.kind === 'implementation').length >= config.maxAttempts)
      throw new Error('Task execution attempt limit reached.');
    execution.attempts.push(attempt);
    execution.status = 'in_progress';
    execution.blockReason = null;
    status(execution, 'in_progress');
    // Durable reservation BEFORE the non-idempotent network request. Failed CAS means zero dispatches.
    await save(`${selected.retry ? 'Retry' : 'Claim'} ${execution.taskId} (${attempt.id})`);
    const claimSha = parent;
    try {
      const receipt = await api.dispatch(execution.repository, config.projects[execution.projectId], {
        task_id: execution.taskId, task_path: selected.task.relativePath, control_repo: config.controlRepository,
        control_commit: claimSha, attempt_id: attempt.id, mode: selected.kind,
        review_id: String(selected.reviewId ?? ''), expected_head: selected.headSha ?? '',
      });
      attempt.dispatchStatus = 'sent';
      if (receipt?.workflow_run_id) { attempt.runId = receipt.workflow_run_id; attempt.runUrl = receipt.html_url; }
    } catch {
      // Never infer that the request failed server-side. A later poll correlates the unique run title.
      attempt.dispatchStatus = 'unknown';
    }
    await save(`Record dispatch receipt for ${execution.taskId}`);
  } else if (apply && (JSON.stringify(state) !== JSON.stringify(initial) || Object.keys(changes).length)) {
    await save('Reconcile autonomous execution state');
  }
  return { selected, state, reviewQueue, summary: summary(model, state, config), applied: apply };
}
