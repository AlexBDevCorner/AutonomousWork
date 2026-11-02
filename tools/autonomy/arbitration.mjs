// Independent technical arbitration of review disputes (#35), deterministic part.
// A model only proposes a typed verdict; these rules decide whether a dispute may be
// arbitrated, whether a verdict binds, and what it may cause. Nothing here approves,
// merges, waives CI, or edits task requirements.
import { createHash } from 'node:crypto';
import { latestReview, requiredCiState, reviewDisagreement, runTitle } from './policy.mjs';

export const DECISIONS = ['UPHOLD_REVIEWER', 'UPHOLD_WORKER', 'COMPROMISE_FIX', 'ESCALATE_HUMAN'];
// One arbiter call per dispute plus one retry for a failed run (provider/quota/invalid output).
export const MAX_ARBITRATION_RUNS = 2;
export const arbitrationTitle = (taskId, reviewId, headSha) => `arbitrate ${taskId} ${reviewId} ${headSha}`;

const RISKS = new Set(['none', 'security', 'data_loss', 'save_corruption', 'integrity']);
const VERDICT_KEYS = new Set(['decision', 'task_id', 'review_id', 'reviewed_sha', 'fingerprint', 'confidence',
  'high_impact_risk', 'rationale', 'evidence', 'trigger', 'invariant', 'correction', 'reason']);
const text = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
const sha256 = value => createHash('sha256').update(value).digest('hex');

// Unique per (repository, PR, SHA, review ID, disagreement). An edited disagreement is a new dispute.
export function disputeFingerprint({ repository, pr, headSha, reviewId, disagreement }) {
  return sha256([repository.toLowerCase(), pr, headSha, reviewId, disagreement.id, disagreement.updated_at,
    sha256(disagreement.body)].join('\n'));
}

// Same exact-head guards as operator recovery (chooseRetry), minus the human comment:
// the unchanged reviewed head, green CI, the disputed review still the latest trusted
// verdict, and an authenticated worker disagreement for exactly that review and head.
export function arbitrationRequest(execution, snapshot, config, now = Date.now()) {
  if (execution.status !== 'blocked' || execution.blockReason !== 'autonomous_review_disagreement') return null;
  const attempt = execution.attempts.at(-1), target = config.projects[execution.projectId];
  // Disputing an arbitration-directed correction is never re-arbitrated; the human decides.
  if (!target || attempt?.kind !== 'correction' || attempt.conclusion !== 'success' || attempt.reason === 'arbitration_resolution' ||
      !attempt.reviewId || !/^[a-f0-9]{40}$/.test(attempt.headSha ?? '')) return null;
  const prs = snapshot.prs.filter(p => p.head.ref === `autonomous/${execution.taskId}` &&
    p.head.repo?.full_name === execution.repository);
  const pr = prs[0];
  if (prs.length !== 1 || pr.number !== execution.pr || pr.state !== 'open' || pr.draft || pr.mergeable === false ||
      pr.base.ref !== target.branch || pr.head.sha !== attempt.headSha) return null;
  if (requiredCiState(snapshot.checks[pr.number] ?? [], config.requiredChecks).state !== 'green') return null;
  const review = latestReview(pr, snapshot.reviews[pr.number] ?? [], config.reviewers);
  if (review?.state !== 'CHANGES_REQUESTED' || review.id !== attempt.reviewId) return null;
  const runs = snapshot.runs.filter(r => r.display_title === runTitle(execution.taskId, attempt.id));
  if (runs.length !== 1) return null;
  const disagreement = reviewDisagreement(pr, snapshot.comments?.[pr.number] ?? [], attempt.reviewId, attempt.headSha,
    { attempt, run: runs[0], repository: execution.repository, taskId: execution.taskId, target, now });
  if (!disagreement) return null;
  return { taskId: execution.taskId, repository: execution.repository, pr: pr.number, headSha: attempt.headSha,
    reviewId: attempt.reviewId, disagreementUrl: disagreement.html_url,
    fingerprint: disputeFingerprint({ repository: execution.repository, pr: pr.number, headSha: attempt.headSha,
      reviewId: attempt.reviewId, disagreement }) };
}

// Exactly-once per fingerprint. A decided or escalated dispute is never re-arbitrated;
// a failed run is retried once, then the dispute stays with the human.
export function planArbitration(execution, request, runs) {
  if (!request) return { action: 'none' };
  const record = (execution.arbitrations ?? []).find(a => a.fingerprint === request.fingerprint);
  if (record && ['decided', 'escalated'].includes(record.status)) return { action: 'none', record };
  const mine = runs.filter(r => r.display_title === arbitrationTitle(request.taskId, request.reviewId, request.headSha));
  if (mine.some(r => r.status !== 'completed')) return { action: 'wait', record };
  if (mine.some(r => r.conclusion === 'success')) return { action: 'await_verdict', record };
  if (mine.length >= MAX_ARBITRATION_RUNS) return { action: 'escalate', record, reason: 'arbitration_runs_exhausted' };
  return { action: 'dispatch', record };
}

export function validateVerdict(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !VERDICT_KEYS.has(k))) throw new Error('Arbitration verdict has unknown fields');
  if (!DECISIONS.includes(value.decision)) throw new Error('Unknown arbitration decision');
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(value.task_id ?? '') || !Number.isSafeInteger(value.review_id) ||
      !/^[a-f0-9]{40}$/.test(value.reviewed_sha ?? '') || !/^[a-f0-9]{64}$/.test(value.fingerprint ?? ''))
    throw new Error('Arbitration verdict is not bound to a dispute');
  if (!['high', 'medium', 'low'].includes(value.confidence) || !RISKS.has(value.high_impact_risk))
    throw new Error('Arbitration confidence or risk missing');
  if (!text(value.rationale, 4000)) throw new Error('Arbitration rationale missing');
  if (value.decision === 'ESCALATE_HUMAN') {
    if (!text(value.reason, 2000)) throw new Error('Escalation reason missing');
    return value;
  }
  if (!Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 20 ||
      value.evidence.some(e => !e || typeof e !== 'object' || !text(e.path, 300) || !text(e.note, 1000) ||
        (e.line !== undefined && (!Number.isSafeInteger(e.line) || e.line < 1))))
    throw new Error('Arbitration verdict lacks code evidence');
  // A material finding must be reproducible and say exactly what bounded correction is required.
  if (value.decision !== 'UPHOLD_WORKER' &&
      !(text(value.trigger, 2000) && text(value.invariant, 1000) && text(value.correction, 3000)))
    throw new Error('Upheld finding lacks trigger, invariant or bounded correction');
  return value;
}

// Decide what a structurally valid verdict may do for this exact dispute.
export function applyVerdict(request, verdict) {
  if (verdict.task_id !== request.taskId || verdict.review_id !== request.reviewId ||
      verdict.reviewed_sha !== request.headSha || verdict.fingerprint !== request.fingerprint)
    return { status: 'stale', action: 'none', reason: 'verdict_not_bound_to_current_dispute' };
  const escalate = reason => ({ status: 'escalated', action: 'hold', decision: verdict.decision, reason });
  if (verdict.decision === 'ESCALATE_HUMAN') return escalate('arbiter_escalated');
  // Uncertain verdicts never bind, in either direction.
  if (verdict.confidence !== 'high') return escalate('arbiter_not_confident');
  // Never overturn a blocker automatically where save corruption, data loss, security or
  // integrity is at stake; a human decides those.
  if (verdict.decision === 'UPHOLD_WORKER' && verdict.high_impact_risk !== 'none')
    return escalate('high_impact_overturn_requires_human');
  if (verdict.decision === 'UPHOLD_WORKER')
    return { status: 'decided', action: 'rereview', decision: verdict.decision, overturnedReviewId: request.reviewId };
  return { status: 'decided', action: 'correction', decision: verdict.decision, correction: verdict.correction };
}

// Append-only ledger entry; earlier attempts, reasons and dispute URLs are never rewritten.
export function arbitrationRecord(request, outcome, now, decision = null) {
  return { fingerprint: request.fingerprint, reviewId: request.reviewId, headSha: request.headSha,
    disagreementUrl: request.disagreementUrl, status: outcome.status, action: outcome.action,
    decision: outcome.decision ?? null, reason: outcome.reason ?? null, decidedAt: new Date(now).toISOString(),
    ...(decision ? { decisionUrl: decision.url, decisionCommentId: decision.id } : {}),
    ...(outcome.correction ? { correction: outcome.correction } : {}) };
}

export const ARBITRATION_WORKFLOW = 'autonomous-arbitration.yml';
// API-owned identity of the worker GitHub App; only trusted deterministic jobs mint its tokens.
export const APP_BOT = { login: 'autonomousworkdispatcher[bot]', id: 327051536 };
const MARKER = '<!-- autonomous-arbitration:v1 -->';

// Posted on the PR by the model-free decide job: human-readable and machine-verifiable.
export function decisionComment(request, verdict, runId, outcome) {
  return [MARKER, `Review-ID: ${request.reviewId}`, `Reviewed-SHA: ${request.headSha}`,
    `Fingerprint: ${request.fingerprint}`, `Run-ID: ${runId}`, `Decision: ${verdict.decision}`,
    `Outcome: ${outcome.status}/${outcome.action}${outcome.reason ? ' (' + outcome.reason + ')' : ''}`, '',
    '## Independent arbitration of the disputed review finding', '',
    'This resolves only the disputed finding(s) of review ' + request.reviewId + '. It is not an approval and ' +
    'does not waive CI, other review findings or task requirements.', '',
    verdict.rationale, '', '```json', JSON.stringify(verdict, null, 2), '```'].join('\n');
}

// The latest App-authored decision for exactly this dispute, produced by a successful
// master arbitration run, whose verdict still validates and binds. Anything else is ignored.
export function arbitrationDecision(pr, comments, request, runs) {
  const lines = c => c.body.split(/\r?\n/);
  const candidates = comments.filter(c => c.user?.login === APP_BOT.login && c.user.id === APP_BOT.id &&
    c.user.type === 'Bot' && typeof c.body === 'string' && Number.isSafeInteger(c.id) &&
    c.html_url === `https://github.com/${request.repository}/pull/${pr.number}#issuecomment-${c.id}` &&
    lines(c)[0] === MARKER && lines(c)[1] === `Review-ID: ${request.reviewId}` &&
    lines(c)[2] === `Reviewed-SHA: ${request.headSha}` && lines(c)[3] === `Fingerprint: ${request.fingerprint}`)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
  const comment = candidates.at(-1);
  if (!comment) return null;
  const runId = Number(/^Run-ID: ([1-9][0-9]*)$/.exec(lines(comment)[4] ?? '')?.[1]);
  const run = runs.find(r => r.id === runId);
  if (!run || run.display_title !== arbitrationTitle(request.taskId, request.reviewId, request.headSha) ||
      run.path !== `.github/workflows/${ARBITRATION_WORKFLOW}` || run.head_branch !== 'master' ||
      run.event !== 'workflow_dispatch' || run.status !== 'completed' || run.conclusion !== 'success') return null;
  try {
    const verdict = decisionVerdict(comment.body);
    const outcome = applyVerdict(request, verdict);
    return outcome.status === 'stale' ? null : { url: comment.html_url, id: comment.id, verdict, outcome };
  } catch { return null; }
}

// The verdict JSON embedded in a decision comment (the last fenced json block).
export function decisionVerdict(body) {
  const json = [...String(body).matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].at(-1)?.[1];
  return validateVerdict(JSON.parse(json));
}
