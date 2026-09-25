// Step 5: pure guards for an isolated disposable PR. Never authorize a normal task PR.
import { PROTOCOL_BLOB_SHA } from './guards.mjs';

export const MERGE_FIXTURE = Object.freeze({
  repo: 'AlexBDevCorner/AutonomousWork',
  head: 'review-bridge-fixture/step5-head',
  target: 'review-bridge-fixture/step5-target',
  file: 'docs/review-bridge-fixtures/step5.md',
  marker: '<!-- review-bridge-merge-fixture:v1 -->',
  worker: 'autonomousworkdispatcher[bot]',
  reviewer: 'AlexBDevCorner',
  requiredChecks: ['validate', 'fixture-merge-validation'],
});
const SHA = /^[a-f0-9]{40}$/;
export const isSha = value => typeof value === 'string' && SHA.test(value);
const decision = (outcome, reason, evidence = {}) => ({ outcome, reason, evidence });

export function parseFixture(text) {
  if (typeof text !== 'string' || text.length > 4000) return false;
  return [...text.matchAll(/^fixture_id:\s*(\S+)\s*$/gm)].map(m => m[1]).join() === 'step5' &&
    [...text.matchAll(/^fixture_status:\s*(\S+)\s*$/gm)].map(m => m[1]).join() === 'ready';
}
export function parseBaseline(text) {
  if (typeof text !== 'string' || text.split(MERGE_FIXTURE.marker).length !== 2) return null;
  const rows = [...text.matchAll(/^Target baseline SHA: ([a-f0-9]{40})\s*$/gm)];
  return rows.length === 1 ? rows[0][1] : null;
}
export function lastCheck(checks, name, sha) {
  if (!Array.isArray(checks)) return null;
  return checks.filter(c => c && c.name === name && c.head_sha === sha &&
    c.app?.slug === 'github-actions' && Number.isSafeInteger(c.id))
    .sort((a,b) => b.id - a.id)[0] ?? null;
}
export function exactHeadTrustedReviews(reviews, config, sha, author) {
  if (!Array.isArray(reviews) || !Array.isArray(config?.reviewers)) throw Error('Invalid review or reviewer configuration');
  const trusted = reviews.filter(r => r && config.reviewers.includes(r.user?.login) &&
    r.user.login !== author && r.commit_id === sha &&
    ['APPROVED','CHANGES_REQUESTED'].includes(r.state));
  // Invalid submitted_at or id on a matching trusted completed review is ambiguous.
  if (trusted.some(r => !Number.isSafeInteger(r.id) || !r.submitted_at ||
      Number.isNaN(Date.parse(r.submitted_at)))) throw Error('Unverifiable trusted exact-head review');
  return trusted.sort((a,b) =>
    Date.parse(a.submitted_at)-Date.parse(b.submitted_at) || a.id-b.id);
}

export function evaluateFixture({ config, protocolSha, masterSha, pr, openPrs,
  files, fixtureText, checks, reviews, targetSha, expectedSha, action }) {
  if (!['VERIFY_ONLY','APPROVE','MERGE_CHECK','MERGE'].includes(action) || !isSha(expectedSha))
    return decision('withheld','invalid_request');
  if (!isSha(masterSha) || !config || config.enabled !== true ||
      config.controlRepository !== MERGE_FIXTURE.repo || config.controlBranch !== 'master' ||
      !Array.isArray(config.reviewers) || !config.reviewers.includes(MERGE_FIXTURE.reviewer) ||
      protocolSha !== PROTOCOL_BLOB_SHA)
    return decision('withheld','global_control_or_protocol_changed');
  if (!pr || pr.head?.sha !== expectedSha)
    return decision('stale','pr_head_does_not_match_expected_sha');
  if (pr.state === 'closed' && pr.merged === true &&
      isSha(pr.merge_commit_sha ?? '') && isSha(targetSha)) {
    // Only a genuine GitHub-verified merge of the exact fixture is a duplicate no-op.
    const structural = pr.head?.ref === MERGE_FIXTURE.head &&
      pr.head?.repo?.full_name === MERGE_FIXTURE.repo &&
      pr.base?.repo?.full_name === MERGE_FIXTURE.repo &&
      pr.base?.ref === MERGE_FIXTURE.target &&
      pr.user?.login === MERGE_FIXTURE.worker &&
      parseBaseline(pr.body) !== null;
    if (structural && targetSha === pr.merge_commit_sha)
      return decision('already_merged','exact_fixture_already_merged',
        {pr:pr.number, head:expectedSha, merge_sha:pr.merge_commit_sha});
    return decision('withheld','merged_pr_identity_or_target_unverified');
  }
  if (pr.state !== 'open' || pr.merged === true || pr.draft !== false ||
      pr.mergeable !== true || !Number.isSafeInteger(pr.number) || pr.number < 1 ||
      pr.head?.repo?.full_name !== MERGE_FIXTURE.repo ||
      pr.base?.repo?.full_name !== MERGE_FIXTURE.repo ||
      pr.head?.ref !== MERGE_FIXTURE.head || pr.base?.ref !== MERGE_FIXTURE.target ||
      pr.user?.login !== MERGE_FIXTURE.worker ||
      !Array.isArray(pr.labels) || pr.labels.length !== 0 ||
      !isSha(pr.base?.sha) || parseBaseline(pr.body) !== pr.base.sha ||
      !isSha(targetSha) || targetSha !== pr.base.sha)
    return decision('withheld','fixture_pr_mapping_or_target_mismatch');
  if (!Array.isArray(openPrs) ||
      openPrs.filter(p => p.state === 'open' &&
        p.head?.repo?.full_name === MERGE_FIXTURE.repo &&
        p.head?.ref === MERGE_FIXTURE.head).length !== 1 ||
      !openPrs.some(p => p.number === pr.number && p.state === 'open' &&
        p.head?.ref === MERGE_FIXTURE.head))
    return decision('withheld','duplicate_or_missing_fixture_pr');
  if (!Array.isArray(files) || files.length !== 1 ||
      files[0].filename !== MERGE_FIXTURE.file ||
      !['added','modified'].includes(files[0].status) || !parseFixture(fixtureText))
    return decision('withheld','fixture_file_or_contents_invalid');
  const statuses = Object.fromEntries(MERGE_FIXTURE.requiredChecks.map(name => {
    const current = lastCheck(checks, name, expectedSha);
    return [name, current?.status === 'completed' && current.conclusion === 'success'
      ? 'success' : (current?.conclusion ?? current?.status ?? 'missing')];
  }));
  if (Object.values(statuses).some(x => x !== 'success'))
    return decision('withheld','required_exact_head_ci_not_green',statuses);
  let trusted;
  try { trusted = exactHeadTrustedReviews(reviews, config, expectedSha, pr.user.login); }
  catch { return decision('withheld','trusted_review_unverifiable'); }
  const latest = trusted.at(-1) ?? null;
  const evidence = {
    pr:pr.number,head:expectedSha,baseline:targetSha,control_sha:masterSha,
    check_statuses:statuses,review_id:latest?.id ?? null,review_state:latest?.state ?? null,
  };
  if (action === 'APPROVE') {
    if (latest?.state === 'APPROVED')
      return decision('already_reviewed','trusted_exact_head_approval_exists',evidence);
    if (latest) return decision('withheld','trusted_exact_head_changes_requested',evidence);
    return decision('eligible_approve','all_fixture_approval_guards_passed',evidence);
  }
  if (action === 'VERIFY_ONLY')
    return decision('inspected','fixture_checks_read',evidence);
  if (!latest || latest.state !== 'APPROVED')
    return decision('withheld','latest_exact_head_trusted_approval_missing',evidence);
  return decision('eligible_merge','all_fixture_merge_guards_passed',evidence);
}
