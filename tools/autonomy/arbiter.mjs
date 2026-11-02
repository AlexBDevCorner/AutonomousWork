// Read-only evidence assembly and verdict parsing for the arbitration workflow (#35).
// Commands: prepare | parse <opencode.log>. Neither performs any GitHub write.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitHub } from './github.mjs';
import { arbitrationRequest, applyVerdict, validateVerdict } from './arbitration.mjs';

const SHA = /^[a-f0-9]{40}$/;

export function disputeInput(env) {
  const input = { taskId: env.TASK_ID, projectId: env.PROJECT_ID, repository: env.REPOSITORY, pr: Number(env.PR),
    headSha: env.HEAD_SHA, reviewId: Number(env.REVIEW_ID), fingerprint: env.FINGERPRINT };
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(input.taskId ?? '') || !/^[a-z0-9-]+$/.test(input.projectId ?? '') ||
      !/^AlexBDevCorner\/[A-Za-z0-9_.-]+$/.test(input.repository ?? '') ||
      !/^[1-9][0-9]*$/.test(env.PR ?? '') || !/^[1-9][0-9]*$/.test(env.REVIEW_ID ?? '') ||
      !Number.isSafeInteger(input.reviewId) || !SHA.test(input.headSha ?? '') || !/^[a-f0-9]{64}$/.test(input.fingerprint ?? ''))
    throw new Error('Invalid arbitration dispatch inputs');
  return input;
}

// Only the reads arbitrationRequest needs, for the one recorded PR and its claimed correction run.
export async function disputeSnapshot(api, execution) {
  const prefix = '/repos/' + execution.repository, owner = execution.repository.split('/')[0];
  const listed = await api.pages(prefix + '/pulls?state=all&head=' + encodeURIComponent(owner + ':autonomous/' + execution.taskId));
  const prs = await Promise.all(listed.map(p => api.request('GET', prefix + '/pulls/' + p.number)));
  const pr = prs.find(p => p.number === execution.pr);
  const runId = execution.attempts.at(-1)?.runId;
  if (!pr || !runId) return { prs, runs: [], reviews: {}, checks: {}, comments: {} };
  const [reviews, checks, comments, run] = await Promise.all([
    api.pages(prefix + '/pulls/' + pr.number + '/reviews'),
    api.pages(prefix + '/commits/' + pr.head.sha + '/check-runs', 'check_runs'),
    api.pages(prefix + '/issues/' + pr.number + '/comments'),
    api.request('GET', prefix + '/actions/runs/' + runId),
  ]);
  return { prs, runs: [run], reviews: { [pr.number]: reviews }, checks: { [pr.number]: checks },
    comments: { [pr.number]: comments } };
}

// The dispatched identifiers must still describe the live, verified dispute.
export function verifyDispute({ input, config, state, snapshot, now = Date.now() }) {
  const execution = state.executions.find(e => e.taskId === input.taskId);
  if (!execution || execution.projectId !== input.projectId || execution.repository !== input.repository ||
      execution.pr !== input.pr || !config.projects[input.projectId] || !config.enabled)
    throw new Error('Dispute does not match the recorded execution');
  const request = arbitrationRequest(execution, snapshot, config, now);
  if (!request || request.fingerprint !== input.fingerprint || request.reviewId !== input.reviewId ||
      request.headSha !== input.headSha) throw new Error('Dispute is no longer arbitrable as dispatched');
  return request;
}

const pick = (items, fields) => items.map(i => Object.fromEntries(fields.map(f => [f, f.split('.').reduce((o, k) => o?.[k], i) ?? null])));

export async function collectEvidence({ api, request, snapshot, dir }) {
  const prefix = '/repos/' + request.repository, pr = snapshot.prs.find(p => p.number === request.pr);
  const reviews = snapshot.reviews[pr.number], comments = snapshot.comments[pr.number];
  const review = reviews.find(r => r.id === request.reviewId);
  const disagreement = comments.find(c => c.html_url === request.disagreementUrl);
  const inline = await api.pages(prefix + '/pulls/' + pr.number + '/reviews/' + request.reviewId + '/comments');
  mkdirSync(dir, { recursive: true });
  const write = (name, value) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  write('dispute.json', { task_id: request.taskId, review_id: request.reviewId, reviewed_sha: request.headSha,
    fingerprint: request.fingerprint, repository: request.repository, pr: request.pr });
  write('review.json', { user: review.user?.login, state: review.state, submitted_at: review.submitted_at, body: review.body,
    inline_comments: pick(inline, ['path', 'line', 'body']) });
  write('disagreement.md', disagreement.body);
  write('pr.json', { number: pr.number, title: pr.title, body: pr.body, author: pr.user?.login,
    base: { ref: pr.base.ref, sha: pr.base.sha }, head: { ref: pr.head.ref, sha: pr.head.sha } });
  write('reviews.json', pick(reviews, ['user.login', 'state', 'commit_id', 'submitted_at', 'body']));
  write('comments.json', pick(comments, ['user.login', 'created_at', 'body']));
  return pr.base.sha;
}

// The arbiter's final message carries the verdict; earlier occurrences may be quoted PR text.
export function parseArbitration(log, dispute) {
  const blocks = [...String(log).matchAll(/BEGIN_ARBITRATION_VERDICT\s*([\s\S]*?)\s*END_ARBITRATION_VERDICT/g)];
  if (!blocks.length) throw new Error('Arbiter produced no verdict block');
  let value;
  try { value = JSON.parse(blocks.at(-1)[1].replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); }
  catch { throw new Error('Arbiter verdict is not valid JSON'); }
  const verdict = validateVerdict(value);
  const outcome = applyVerdict({ taskId: dispute.task_id, reviewId: dispute.review_id, headSha: dispute.reviewed_sha,
    fingerprint: dispute.fingerprint }, verdict);
  if (outcome.status === 'stale') throw new Error('Arbiter verdict is not bound to this dispute');
  return { verdict, outcome };
}

async function main([command, file]) {
  const env = process.env;
  if (command === 'parse') {
    const dispute = JSON.parse(readFileSync(env.DISPUTE_FILE, 'utf8'));
    const { verdict, outcome } = parseArbitration(readFileSync(file, 'utf8'), dispute);
    writeFileSync(env.VERDICT_FILE, JSON.stringify(verdict, null, 2) + '\n');
    console.info('Arbitration verdict:', verdict.decision, verdict.confidence, '->', outcome.status, outcome.action);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
      '### Arbitration ' + dispute.task_id + ' review ' + dispute.review_id + '\n- Decision: ' + verdict.decision +
      ' (confidence ' + verdict.confidence + ', risk ' + verdict.high_impact_risk + ')\n- Policy outcome: ' +
      outcome.status + ' / ' + outcome.action + (outcome.reason ? ' (' + outcome.reason + ')' : '') +
      '\n- Model: ' + env.ARBITER_MODEL + ' (' + env.ARBITER_VARIANT + ')\n\n' + verdict.rationale + '\n');
    return;
  }
  if (command !== 'prepare') throw new Error('Usage: arbiter.mjs prepare | parse <file>');
  const input = disputeInput(env);
  if (!env.GITHUB_TOKEN_READ) throw new Error('Read-only GitHub token missing');
  const api = new GitHub(env.GITHUB_TOKEN_READ);
  const config = JSON.parse(readFileSync('automation/config.json', 'utf8'));
  const state = JSON.parse(readFileSync('automation/state.json', 'utf8'));
  const execution = state.executions.find(e => e.taskId === input.taskId);
  if (!execution) throw new Error('Dispute does not match the recorded execution');
  const snapshot = await disputeSnapshot(api, execution);
  const request = verifyDispute({ input, config, state, snapshot });
  const base = await collectEvidence({ api, request, snapshot, dir: env.EVIDENCE_DIR });
  appendFileSync(env.GITHUB_OUTPUT, 'base_sha=' + base + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(error => {
    console.error('Arbitration stopped:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
