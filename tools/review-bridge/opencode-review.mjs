// Event-driven OpenCode reviewer (#37). The model only reads files and prints a
// verdict; this module decides eligibility and validates the verdict deterministically.
// Commands: prepare | merge-check | check-model <models.txt> | parse <opencode.log> | apply <verdict.json>
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitHub } from '../autonomy/github.mjs';
import { evaluate } from './processor.mjs';
import { githubWrite, guardedMerge, postReview } from './reviewer.mjs';

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
    pr: Number(env.PR), headSha: env.HEAD_SHA };
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(input.taskId ?? '') || !/^[a-z0-9-]+$/.test(input.projectId ?? '') ||
      !/^AlexBDevCorner\/[A-Za-z0-9_.-]+$/.test(input.repository ?? '') ||
      !/^[1-9][0-9]*$/.test(env.PR ?? '') || !Number.isSafeInteger(input.pr) || !SHA.test(input.headSha ?? ''))
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
  if ((decision.status === 'dry_run' && decision.reason === PASS[verdict]) ||
      (verdict === 'WITHHOLD' && decision.reason === 'reviewer_withheld')) return { eligible: true, decision };
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

// The in-memory review row the bridge's guarded writers consume (never persisted).
export function reviewRow(verdict, input, { model, variant, runUrl, ci, now = Date.now() }) {
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
  return { ...candidateRow(input, verdict.verdict, verdict.findings.filter(f => f.severity !== 'P2'), now),
    ci: { state: ci, reviewer: { model, variant } }, review_summary: summary };
}

// Re-checks the verdict against live state, then applies it only through the bridge's guarded,
// independently confirmed GitHub writes. A changed head/CI/review discards the verdict.
export async function publish({ verdict, input, api, writes, meta, check = eligibility }) {
  const blocking = verdict.findings.filter(f => f.severity !== 'P2');
  const { eligible, decision } = await check({ api, input, verdict: verdict.verdict, findings: blocking });
  if (!eligible) return { outcome: 'discarded', reason: decision.reason };
  const row = reviewRow(verdict, input, { ...meta, ci: decision.evidence?.ci ?? 'unknown' });
  // An escalation posts no review; a PR comment makes it visible to the human.
  if (verdict.verdict === 'WITHHOLD') { await writes.comment(row); return { outcome: 'withheld', row }; }
  const reviewId = await writes.review(row);
  if (verdict.verdict !== 'APPROVE') return { outcome: 'review_posted', reviewId, row };
  const merge = await writes.merge(row);
  return merge.merged ? { outcome: 'merged', reviewId, mergeSha: merge.sha, row }
    : { outcome: 'review_posted_merge_withheld', reviewId, reason: merge.decision?.reason, row };
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
  return pr.base.sha;
}

function output(env, values) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => k + '=' + v + '\n').join(''));
}

async function main([command, file]) {
  const env = process.env;
  if (command === 'check-model') {
    checkModel(readFileSync(file, 'utf8'), env.REVIEWER_MODEL, env.REVIEWER_VARIANT);
    console.info('Reviewer model confirmed:', env.REVIEWER_MODEL, env.REVIEWER_VARIANT);
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
  if (env.GITHUB_REPOSITORY !== 'AlexBDevCorner/AutonomousWork' || env.GITHUB_REF !== 'refs/heads/master' ||
      env.AUTONOMOUS_REVIEW_ENABLED !== 'true' || !env.MERGE_GH_TOKEN)
    throw new Error('GitHub writes must run enabled on the control default branch with the App token');
  const merge = row => guardedMerge({ api, fetcher: fetch, token: env.MERGE_GH_TOKEN, row, clock: Date.now });
  if (command === 'merge-check') {
    // Model-free: an existing trusted exact-head approval only needs the bridge's guarded merge,
    // which re-evaluates every merge guard twice and merges with the expected head SHA.
    const result = await merge(candidateRow(input, 'MERGE_CHECK', [], Date.now()));
    if (result.merged) { console.info('Merged', input.repository + '#' + input.pr, result.sha); return; }
    if (NOOP.has(result.decision?.reason) || result.decision?.reason === 'head_changed_before_merge') {
      console.info('No merge needed:', result.decision.reason);
      return;
    }
    // Fail so the dispatcher's bounded retry re-checks a possibly transient guard.
    throw new Error('Merge withheld: ' + result.decision?.status + '/' + result.decision?.reason);
  }
  if (command === 'apply') {
    if (!env.AUTONOMOUS_REVIEWER_TOKEN) throw new Error('Independent reviewer token missing');
    const verdict = validateVerdict(JSON.parse(readFileSync(file, 'utf8')));
    const writes = {
      review: row => postReview({ api, fetcher: fetch, row, reviewerToken: env.AUTONOMOUS_REVIEWER_TOKEN,
        appToken: env.MERGE_GH_TOKEN }),
      merge,
      comment: row => githubWrite({ fetcher: fetch, token: env.MERGE_GH_TOKEN, method: 'POST',
        path: '/repos/' + row.repository + '/issues/' + row.pr_number + '/comments',
        body: { body: '<!-- autonomous-review-withheld:v1 -->\nAutonomous review withheld for ' + row.reviewed_sha +
          '; a human decision is needed.\n\n' + row.review_summary } }),
    };
    const result = await publish({ verdict, input, api, writes,
      meta: { model: env.REVIEWER_MODEL, variant: env.REVIEWER_VARIANT, runUrl: env.RUN_URL } });
    console.info('OpenCode review:', result.outcome, result.reason ?? '', result.reviewId ?? '', result.mergeSha ?? '');
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
      '### OpenCode review ' + input.taskId + ' #' + input.pr + '\n- Verdict: ' + verdict.verdict +
      '\n- Outcome: ' + result.outcome + (result.reason ? ' (' + result.reason + ')' : '') +
      '\n\n' + (result.row?.review_summary ?? '') + '\n');
    return;
  }
  throw new Error('Usage: opencode-review.mjs prepare | merge-check | check-model <file> | parse <file> | apply <file>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(error => {
    console.error('OpenCode review stopped:', error instanceof Error ? error.message : 'unknown error');
    process.exitCode = 1;
  });
