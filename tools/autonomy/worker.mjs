import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GitHub } from './github.mjs';
import { load } from './run.mjs';
import { autonomousPr, latestAttempt, latestReview, runTitle } from './policy.mjs';

export function authorize({ catalog, state, config, taskId, taskPath, repository, attemptId, mode, reviewId, expectedHead }) {
  const task = catalog.tasks.find(t => t.id === taskId);
  const project = catalog.projects.find(p => p.id === task?.projectId);
  if (!task || task.relativePath !== taskPath || project?.repository !== repository || !project.enabled || !config.projects[project.id])
    throw new Error('Task identity, target repository, project enablement, or enrollment is invalid.');
  if (!task.dependsOn.every(id => catalog.tasks.find(t => t.id === id)?.status === 'done')) throw new Error('Unfinished task dependency.');
  const execution = state.executions.find(e => e.taskId === taskId);
  if (attemptId) {
    const attempt = execution && latestAttempt(execution);
    if (!config.enabled || task.status !== 'in_progress' || execution?.status !== 'in_progress' ||
        attempt?.id !== attemptId || attempt.kind !== mode ||
        String(attempt.reviewId ?? '') !== String(reviewId ?? '') || (attempt.headSha ?? '') !== (expectedHead ?? '') ||
        execution.attempts.filter(a => a.kind === 'implementation').length > config.maxAttempts ||
        execution.attempts.filter(a => a.kind === 'correction').length > config.maxCorrectionRounds)
      throw new Error('Missing, stale, disabled, or mismatched dispatcher claim.');
    return { task, project, execution, attempt };
  }
  if (mode !== 'implementation' || task.status !== 'ready' || execution) throw new Error('Manual dispatch requires an unclaimed ready task.');
  if (catalog.tasks.some(t => t.projectId === project.id && ['in_progress', 'review'].includes(t.status)))
    throw new Error('The project already has active work.');
  const next = catalog.tasks.filter(t => t.projectId === project.id && t.status === 'ready' &&
    t.dependsOn.every(id => catalog.tasks.find(d => d.id === id)?.status === 'done'))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id, 'en'))[0];
  if (next?.id !== taskId) throw new Error('Manual dispatch must match deterministic selection.');
  return { task, project };
}

export async function assertTaskSpecUnchanged(controlApi, config, taskPath, controlSha) {
  // Compare Git blob SHAs via the Contents API, never working-tree text. A
  // Windows checkout can be CRLF while the API blob is LF, so a byte-for-byte
  // string comparison falsely reports an unchanged task as stale.
  if (!/^[a-f0-9]{40}$/.test(controlSha ?? '')) throw new Error('Missing pinned control SHA; refusing the stale claim.');
  const pinned = await controlApi.request('GET', `/repos/${config.controlRepository}/contents/${taskPath}?ref=${controlSha}`);
  const live = await controlApi.request('GET', `/repos/${config.controlRepository}/contents/${taskPath}?ref=${config.controlBranch}`);
  if (!pinned?.sha || !live?.sha) throw new Error('Task specification changed after dispatch; refusing the stale claim.');
  if (live.sha !== pinned.sha) throw new Error('Task specification changed after dispatch; refusing the stale claim.');
}

async function main() {
  const mode = process.argv[2], root = resolve('control');
  const { catalog, state, config } = load(root);
  const input = { catalog, state, config, taskId: process.env.TASK_ID, taskPath: process.env.TASK_PATH,
    repository: process.env.GITHUB_REPOSITORY, attemptId: process.env.ATTEMPT_ID ?? '',
    mode: process.env.WORK_MODE ?? 'implementation', reviewId: process.env.REVIEW_ID ?? '', expectedHead: process.env.EXPECTED_HEAD ?? '' };
  const selected = authorize(input);
  const api = new GitHub(process.env.GH_TOKEN), target = config.projects[selected.project.id];
  const prs = await api.pages(`/repos/${input.repository}/pulls?state=all`);
  const own = prs.filter(pr => pr.head.ref === `autonomous/${input.taskId}` && pr.head.repo?.full_name === input.repository);
  if (own.length > 1) throw new Error('Multiple PRs for this task.');
  if (prs.some(pr => pr.state === 'open' && autonomousPr(pr) && !own.includes(pr))) throw new Error('Another autonomous PR is open.');
  if (own[0]?.state === 'closed') throw new Error('Task PR is closed; operator reconciliation is required.');
  if (mode === 'guard') {
    if (process.env.GITHUB_RUN_ATTEMPT !== '1') throw new Error('Workflow reruns are disabled; use a new bounded dispatch.');
    // Check current planning too: a pinned claim must not bypass a later pause or task edit.
    const controlApi = new GitHub(process.env.CONTROL_READ_TOKEN);
    const readCurrent = async path => {
      const file = await controlApi.request('GET', `/repos/${config.controlRepository}/contents/${path}?ref=${config.controlBranch}`);
      return Buffer.from(file.content, 'base64').toString('utf8');
    };
    const liveConfig = JSON.parse(await readCurrent('automation/config.json'));
    const liveProject = await readCurrent(selected.project.relativePath);
    if (!/^enabled:\s*true\s*(?:#.*)?$/m.test(liveProject) || !liveConfig.projects[selected.project.id] ||
        (input.attemptId && !liveConfig.enabled)) throw new Error('Current project/global switch disallows execution.');
    await assertTaskSpecUnchanged(controlApi, config, input.taskPath, process.env.CONTROL_SHA);
    if (input.attemptId) {
      const liveState = JSON.parse(await readCurrent('automation/state.json'));
      const live = liveState.executions.find(e => e.taskId === input.taskId);
      if (live?.status !== 'in_progress' || latestAttempt(live).id !== input.attemptId) throw new Error('Claim has been superseded.');
    }
    const runs = await api.pages(`/repos/${input.repository}/actions/workflows/${target.workflow}/runs?event=workflow_dispatch`, 'workflow_runs');
    const sameTitle = runTitle(input.taskId, input.attemptId || 'manual');
    const previous = runs.filter(r => r.id !== Number(process.env.GITHUB_RUN_ID) && r.display_title === sameTitle);
    if (input.attemptId && previous.length) throw new Error('This claim already has a workflow run.');
    if (!input.attemptId && previous.length >= config.maxAttempts) throw new Error('Manual dispatch attempt limit reached.');
    const today = new Date().toISOString().slice(0, 10);
    if (runs.filter(r => r.created_at.startsWith(today)).length > config.maxStartsPerProjectPerDay)
      throw new Error('Daily worker start limit reached.');
    if (input.mode === 'correction') {
      const pr = own[0];
      if (!pr || pr.head.sha !== input.expectedHead) throw new Error('PR head changed since review.');
      const reviews = await api.pages(`/repos/${input.repository}/pulls/${pr.number}/reviews`);
      const review = latestReview(pr, reviews, config.reviewers);
      if (!review || review.state !== 'CHANGES_REQUESTED' || review.id !== Number(input.reviewId)) throw new Error('Stale or untrusted review.');
      // Treat review content as task data in a file, never interpolate it into shell code.
      const comments = await api.pages(`/repos/${input.repository}/pulls/${pr.number}/reviews/${review.id}/comments`);
      writeFileSync(resolve(process.env.RUNNER_TEMP, 'blocking-review.json'), JSON.stringify({ review, comments }, null, 2));
    }
    appendFileSync(process.env.GITHUB_ENV, `TASK_PR=${own[0]?.number ?? ''}\n`);
    console.log('Task, claim, pause controls, PR ownership, and attempt limits verified.');
    return;
  }
  if (mode !== 'verify') throw new Error('Expected guard or verify.');
  if (own.length !== 1) throw new Error('Worker must produce exactly one task PR.');
  const pr = await api.request('GET', `/repos/${input.repository}/pulls/${own[0].number}`);
  if (input.mode === 'correction') {
    if (!input.expectedHead) throw new Error('Correction verification requires the reviewed head SHA.');
    if (pr.head.sha === input.expectedHead) throw new Error('Correction did not advance the PR head (correction_did_not_advance_head).');
  }
  const files = await api.pages(`/repos/${input.repository}/pulls/${pr.number}/files`);
  if (files.some(f => [f.filename, f.previous_filename].filter(Boolean).some(p => p.startsWith('control/'))))
    throw new Error('Worker changed protected control files.');
  if (pr.base.ref !== target.branch || !pr.title.startsWith(`[${input.taskId}]`) || pr.state !== 'open') throw new Error('Invalid PR title/base/state.');
  if (pr.draft) throw new Error('Worker must leave the task PR ready for review, not draft.');
  for (const label of ['autonomous', 'autonomous:opencode', `task:${input.taskId}`])
    if (!pr.labels.some(l => l.name === label)) throw new Error(`Missing PR label: ${label}`);
  for (const heading of ['Task', 'Control specification', 'Implementation', 'Verification', 'Autonomous execution'])
    if (!new RegExp(`^## ${heading}\\s*$`, 'm').test(pr.body ?? '')) throw new Error(`Missing PR section: ${heading}`);
  const pin = `${config.controlRepository}@${process.env.CONTROL_SHA}: ${input.taskPath}`;
  if (!(pr.body ?? '').includes(pin)) throw new Error('PR is missing the exact pinned control specification.');
  console.log(`PR #${pr.number} metadata verified.`);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, 'worker.mjs'))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
