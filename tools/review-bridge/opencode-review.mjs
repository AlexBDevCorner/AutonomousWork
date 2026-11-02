// Event-driven OpenCode reviewer (#37). The model only reads files and prints a
// verdict; this module decides eligibility and validates the verdict deterministically.
// Commands: prepare | merge-check | check-model <models.txt> <model> <variant> | parse <opencode.log> | enqueue <verdict.json>
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitHub } from '../autonomy/github.mjs';
import { QueueApi, evaluate } from './processor.mjs';
import { decidedArbitration } from '../autonomy/policy.mjs';
import { decisionVerdict } from '../autonomy/arbitration.mjs';

const SHA = /^[a-f0-9]{40}$/;
const VERDICTS = new Set(['APPROVE', 'REQUEST_CHANGES', 'WITHHOLD']);
const SEVERITIES = new Set(['P0', 'P1', 'P2']);
const FINDING_KEYS = new Set(['severity', 'path', 'line', 'location', 'description']);
const VERDICT_KEYS = new Set(['verdict', 'summary', 'deployment_context', 'findings']);
const MAX_SUMMARY = 4000;
const PASS = { APPROVE: 'review_guards_passed_no_mutation', REQUEST_CHANGES: 'blocking_findings_recorded_no_mutation',
  MERGE_CHECK: 'merge_guards_passed_no_mutation' };
// The same head is reviewed by another actor, or moved on: nothing to do, not a failure.
const NOOP = new Set(['trusted_same_head_verdict_exists', 'reviewed_head_changed']);
const text = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;

export function reviewInput(env) {
  const input = { taskId: env.TASK_ID, projectId: env.PROJECT_ID, repository: env.REPOSITORY,
    pr: Number(env.PR), headSha: env.HEAD_SHA,
    supersedesReviewId: env.SUPERSEDES_REVIEW_ID ? Number(env.SUPERSEDES_REVIEW_ID) : null };
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(input.taskId ?? '') || !/^[a-z0-9-]+$/.test(input.projectId ?? '') ||
      !/^AlexBDevCorner\/[A-Za-z0-9_.-]+$/.test(input.repository ?? '') ||
      !/^[1-9][0-9]*$/.test(env.PR ?? '') || !Number.isSafeInteger(input.pr) || !SHA.test(input.headSha ?? '') ||
      !/^([1-9][0-9]*)?$/.test(env.SUPERSEDES_REVIEW_ID ?? '') ||
      (input.supersedesReviewId !== null && !Number.isSafeInteger(input.supersedesReviewId)))
    throw new Error('Invalid review dispatch inputs');
  return input;
}

// A synthetic, never-persisted queue row lets the bridge's own guards decide eligibility.
export const candidateRow = (input, verdict, findings, now) => ({
  id: randomUUID(), schema_version: 1, source: 'opencode-actions', test_only: false, status: 'processing',
  repository: input.repository, project_id: input.projectId, task_id: input.taskId, pr_number: input.pr,
  reviewed_sha: input.headSha, verdict, findings, ci: {}, review_summary: '',
  observed_at: new Date(now).toISOString(),
});

export async function eligibility({ api, input, verdict = 'APPROVE', findings = [], now = Date.now(), verify = evaluate }) {
  let decision;
  // The dispatcher commits to control master every tick; re-read instead of failing on that race.
  for (let i = 0; i < 3 && (!decision || decision.reason === 'control_master_advanced'); i++)
    decision = await verify({ api, row: candidateRow(input, verdict, findings, now), now, live: true });
  // A re-review must supersede exactly the latest trusted review the bridge accepted as overturned;
  // a first review must supersede nothing. This keeps the queue's per-head dedupe honest.
  const supersedes = verdict === 'MERGE_CHECK' || verdict === 'WITHHOLD' ||
    (decision.evidence?.latest_trusted_review_id ?? null) === input.supersedesReviewId;
  if (supersedes && ((decision.status === 'dry_run' && decision.reason === PASS[verdict]) ||
      (verdict === 'WITHHOLD' && decision.reason === 'reviewer_withheld'))) return { eligible: true, decision };
  if (NOOP.has(decision.reason)) return { eligible: false, decision };
  throw new Error('Review not eligible: ' + decision.status + '/' + decision.reason);
}

// `opencode models <provider> --verbose` prints "<provider/model>" then its JSON metadata.
export function checkModel(listing, model, variant) {
  const models = new Map();
  for (const m of listing.matchAll(/^(\S+\/\S+)\r?\n(\{[\s\S]*?\r?\n\})/gm)) {
    try { models.set(m[1], JSON.parse(m[2])); } catch { /* ignore unparsable metadata */ }
  }
  const meta = models.get(model);
  if (!meta) throw new Error('Configured reviewer model is not available: ' + model);
  // Never let the CLI silently fall back to its default reasoning effort.
  if (!Object.hasOwn(meta.variants ?? {}, variant))
    throw new Error('Reviewer variant ' + variant + ' is not supported by ' + model);
  return { model, variant };
}

export function validateVerdict(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !VERDICT_KEYS.has(k))) throw new Error('Verdict has unknown or missing fields');
  if (!VERDICTS.has(value.verdict)) throw new Error('Unknown verdict');
  if (!text(value.summary, 2500) || !text(value.deployment_context, 600)) throw new Error('Summary or deployment context missing');
  if (!Array.isArray(value.findings) || value.findings.length > 20) throw new Error('Invalid findings list');
  for (const f of value.findings) {
    if (!f || typeof f !== 'object' || Object.keys(f).some(k => !FINDING_KEYS.has(k)) ||
        !SEVERITIES.has(f.severity) || !text(f.description, 1500) ||
        (f.path !== undefined && !text(f.path, 300)) || (f.location !== undefined && !text(f.location, 300)) ||
        (f.line !== undefined && (!Number.isSafeInteger(f.line) || f.line < 1)))
      throw new Error('Malformed finding');
    if (f.severity !== 'P2' && !((f.path && f.line) || f.location)) throw new Error('Blocking finding lacks a location');
  }
  const blockingFindings = value.findings.filter(f => f.severity !== 'P2'), blocking = blockingFindings.length;
  // The bridge rejects review bodies over 12000 characters; fail here instead of looping there.
  if (JSON.stringify(blockingFindings).length > 7000) throw new Error('Blocking findings too long for one review');
  if (value.verdict === 'REQUEST_CHANGES' && !blocking) throw new Error('REQUEST_CHANGES without a P0/P1 finding');
  if (value.verdict === 'APPROVE' && blocking) throw new Error('APPROVE with a P0/P1 finding');
  return value;
}

// The model's final message carries the verdict; earlier occurrences may be quoted PR text.
export function parseVerdict(log) {
  const blocks = [...String(log).matchAll(/BEGIN_REVIEW_VERDICT\s*([\s\S]*?)\s*END_REVIEW_VERDICT/g)];
  if (!blocks.length) throw new Error('Reviewer produced no verdict block');
  const raw = blocks.at(-1)[1].replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('Reviewer verdict is not valid JSON'); }
  return validateVerdict(value);
}

const where = f => f.path && f.line ? f.path + ':' + f.line : f.location ?? f.path ?? 'general';

export function queueRow(verdict, input, { model, variant, runUrl, ci, now = Date.now() }) {
  const footer = '\n\nReviewer: OpenCode ' + model + ' (' + variant + ')' + (runUrl ? ' — ' + runUrl : '');
  let summary = 'Deployment context: ' + verdict.deployment_context.trim() + '\n\n' + verdict.summary.trim();
  const suggestions = verdict.findings.filter(f => f.severity === 'P2');
  if (suggestions.length) {
    // P2s are surfaced in the review body but never start a correction loop.
    summary += '\n\nNon-blocking suggestions (P2):';
    for (const f of suggestions) {
      const line = '\n- ' + where(f) + ': ' + f.description.trim();
      if (summary.length + line.length + footer.length + 4 > MAX_SUMMARY) { summary += '\n- …'; break; }
      summary += line;
    }
  }
  summary = (summary.slice(0, MAX_SUMMARY - footer.length) + footer);
  return {
    repository: input.repository, project_id: input.projectId, task_id: input.taskId, pr_number: input.pr,
    reviewed_sha: input.headSha, verdict: verdict.verdict, supersedes_review_id: input.supersedesReviewId,
    findings: verdict.findings.filter(f => f.severity !== 'P2'),
    ci: { state: ci, reviewer: { model, variant } }, review_summary: summary,
    observed_at: new Date(now).toISOString(),
  };
}

const pick = (items, fields) => items.map(i => Object.fromEntries(fields.map(f => [f, f.split('.').reduce((o, k) => o?.[k], i) ?? null])));

// Untrusted PR evidence for the model, written as data files next to the PR checkout.
export async function collectEvidence({ api, input, dir }) {
  const prefix = '/repos/' + input.repository;
  const [pr, reviews, comments, reviewComments] = await Promise.all([
    api.request('GET', prefix + '/pulls/' + input.pr),
    api.pages(prefix + '/pulls/' + input.pr + '/reviews'),
    api.pages(prefix + '/issues/' + input.pr + '/comments'),
    api.pages(prefix + '/pulls/' + input.pr + '/comments'),
  ]);
  if (pr?.head?.sha !== input.headSha || !SHA.test(pr?.base?.sha ?? '')) throw new Error('PR head moved during evidence collection');
  mkdirSync(dir, { recursive: true });
  const write = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n');
  write('pr.json', { number: pr.number, title: pr.title, body: pr.body, author: pr.user?.login,
    base: { ref: pr.base.ref, sha: pr.base.sha }, head: { ref: pr.head.ref, sha: pr.head.sha } });
  write('reviews.json', pick(reviews, ['user.login', 'state', 'commit_id', 'submitted_at', 'body']));
  write('comments.json', pick(comments, ['user.login', 'created_at', 'body']));
  write('review-comments.json', pick(reviewComments, ['user.login', 'commit_id', 'path', 'line', 'created_at', 'body']));
  if (input.supersedesReviewId) {
    // Context for a same-SHA re-review: which finding a binding arbitration overturned, and why.
    const state = JSON.parse(readFileSync('automation/state.json', 'utf8'));
    const execution = state.executions.find(e => e.taskId === input.taskId);
    const record = execution && decidedArbitration(execution, input.supersedesReviewId, input.headSha, 'rereview');
    if (!record?.decisionCommentId) throw new Error('No binding arbitration record for this re-review');
    const comment = await api.request('GET', prefix + '/issues/comments/' + record.decisionCommentId);
    const verdict = decisionVerdict(comment.body);
    write('arbitration.json', { overturned_review_id: input.supersedesReviewId, decision: verdict.decision,
      rationale: verdict.rationale, evidence: verdict.evidence, decision_url: record.decisionUrl });
  }
  return pr.base.sha;
}

function output(env, values) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => k + '=' + v + '\n').join(''));
}

async function main([command, file, ...rest]) {
  const env = process.env;
  if (command === 'check-model') {
    // Shared by the reviewer and the arbiter, which use independently configured models.
    const [model, variant] = rest;
    checkModel(readFileSync(file, 'utf8'), model, variant);
    console.info('Model confirmed:', model, variant);
    return;
  }
  if (command === 'parse') {
    const verdict = parseVerdict(readFileSync(file, 'utf8'));
    writeFileSync(env.VERDICT_FILE, JSON.stringify(verdict, null, 2) + '\n');
    console.info('Reviewer verdict:', verdict.verdict, verdict.findings.length, 'finding(s)');
    return;
  }
  const input = reviewInput(env);
  if (!env.GITHUB_TOKEN_READ) throw new Error('Read-only GitHub token missing');
  const api = new GitHub(env.GITHUB_TOKEN_READ);
  if (command === 'prepare') {
    const { eligible, decision } = await eligibility({ api, input });
    if (!eligible) {
      console.info('No review needed:', decision.reason);
      output(env, { eligible: 'false' });
      return;
    }
    const base = await collectEvidence({ api, input, dir: env.EVIDENCE_DIR });
    output(env, { eligible: 'true', base_sha: base });
    return;
  }
  if (env.GITHUB_REPOSITORY !== 'AlexBDevCorner/AutonomousWork' || env.GITHUB_REF !== 'refs/heads/master')
    throw new Error('Enqueue must run on the control default branch');
  const queue = new QueueApi(env.REVIEW_BRIDGE_QUEUE_TOKEN, fetch, 'live');
  if (command === 'merge-check') {
    // Model-free: an existing trusted exact-head approval only needs the bridge's guarded merge.
    const { eligible, decision } = await eligibility({ api, input, verdict: 'MERGE_CHECK' });
    if (!eligible) { console.info('No merge check needed:', decision.reason); return; }
    const id = await queue.enqueue({ repository: input.repository, project_id: input.projectId,
      task_id: input.taskId, pr_number: input.pr, reviewed_sha: input.headSha, verdict: 'MERGE_CHECK',
      findings: [], ci: { state: decision.evidence?.ci ?? 'unknown' },
      review_summary: 'Merge check for an existing trusted exact-head approval.', observed_at: new Date().toISOString() });
    console.info(id ? 'Queued merge check ' + id : 'Merge check already pending for this head');
    return;
  }
  if (command === 'enqueue') {
    const verdict = validateVerdict(JSON.parse(readFileSync(file, 'utf8')));
    const blocking = verdict.findings.filter(f => f.severity !== 'P2');
    // Re-check against live state: a head/CI/review change since the model ran discards the verdict.
    const { eligible, decision } = await eligibility({ api, input, verdict: verdict.verdict, findings: blocking });
    if (!eligible) { console.info('Verdict discarded:', decision.reason); return; }
    const row = queueRow(verdict, input, { model: env.REVIEWER_MODEL, variant: env.REVIEWER_VARIANT,
      runUrl: env.RUN_URL, ci: decision.evidence?.ci ?? 'unknown' });
    const id = await queue.enqueue(row);
    console.info(id ? 'Queued verdict ' + id : 'Exact-head verdict already queued; not duplicated');
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
      '### OpenCode review ' + input.taskId + ' #' + input.pr + '\n- Verdict: ' + verdict.verdict +
      '\n- Queue: ' + (id ?? 'duplicate') + '\n\n' + row.review_summary + '\n');
    return;
  }
  throw new Error('Usage: opencode-review.mjs prepare | merge-check | check-model <file> <model> <variant> | parse <file> | enqueue <file>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(error => {
    console.error('OpenCode review stopped:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
