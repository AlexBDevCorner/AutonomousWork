// Operator-invoked disposable PR creator. Uses the WORKER GitHub App only,
// so a separate human reviewer may approve without reviewing their own PR.
// This code never edits any existing autonomous task or queue record.
import { Buffer } from 'node:buffer';
import { pathToFileURL } from 'node:url';
import { GitHub } from '../autonomy/github.mjs';
import { REPO, BRANCH, FILE, MARKER, parseFixture } from './review-write.mjs';

const FIXTURE = status => '# Disposable review bridge Step 4 fixture\n\n' +
  'fixture_id: step4\nfixture_status: ' + status + '\n\n' +
  'This file is intentionally isolated from production code. ' +
  'See docs/supabase-review-bridge-step4-setup.md for the validation contract.\n';

export function verifyMakerInputs({ phase, confirmation, existingPr }) {
  if (!['create', 'repair'].includes(phase) ||
      confirmation !== (phase === 'create' ? 'CREATE_STEP4_FIXTURE' : 'REPAIR_STEP4_FIXTURE'))
    throw new Error('Explicit fixture operation and confirmation required');
  if (phase === 'repair' && (!Number.isSafeInteger(existingPr) || existingPr < 1))
    throw new Error('Repair requires an exact existing fixture PR number');
  if (phase === 'create' && existingPr) throw new Error('Create does not accept an existing PR number');
}

export async function operate({ api, phase, confirmation, prNumber = 0 }) {
  verifyMakerInputs({ phase, confirmation, existingPr: prNumber });
  const prefix = '/repos/' + REPO;
  const prs = await api.pages(prefix + '/pulls?state=all&head=AlexBDevCorner:' + BRANCH);
  if (phase === 'create') {
    if (prs.length) throw new Error('Fixture PR already exists; do not recreate');
    // Do not overwrite any branch left by an interrupted earlier attempt.
    try {
      await api.request('GET', prefix + '/git/ref/heads/' + BRANCH);
      throw new Error('Fixture branch already exists; inspect manually rather than overwrite');
    } catch (e) {
      if (!String(e.message).includes('HTTP 404')) throw e;
    }
    const master = await api.request('GET', prefix + '/git/ref/heads/master');
    if (!/^[a-f0-9]{40}$/.test(master?.object?.sha ?? ''))
      throw new Error('Cannot pin master before creating fixture');
    await api.request('POST', prefix + '/git/refs',
      { ref: 'refs/heads/' + BRANCH, sha: master.object.sha });
    await api.request('PUT', prefix + '/contents/' + FILE, {
      message: 'Add deliberately broken disposable Step 4 fixture',
      content: Buffer.from(FIXTURE('broken')).toString('base64'),
      branch: BRANCH,
    });
    const created = await api.request('POST', prefix + '/pulls', {
      title: '[Step 4 fixture] Controlled review and correction only — DO NOT MERGE',
      head: BRANCH, base: 'master', draft: false,
      body: MARKER + '\n\nManual review bridge permission/commit-ID test only. ' +
        'Deliberate defect: fixture_status is broken. This PR must never be merged.',
    });
    if (!Number.isSafeInteger(created?.number) || created.head?.ref !== BRANCH)
      throw new Error('Fixture PR creation response was unexpected; inspect manually');
    return { operation: 'created', pr: created.number, sha: created.head.sha };
  }
  if (prs.length !== 1 || prs[0].number !== prNumber || prs[0].state !== 'open')
    throw new Error('Existing open fixture PR mapping mismatch');
  const pr = await api.request('GET', prefix + '/pulls/' + prNumber);
  if (pr.user?.login !== 'autonomousworkdispatcher[bot]' ||
      pr.head?.ref !== BRANCH || pr.head?.repo?.full_name !== REPO ||
      pr.base?.ref !== 'master' || pr.base?.repo?.full_name !== REPO ||
      !pr.body?.includes(MARKER) || pr.draft)
    throw new Error('Fixture author, branch or identity mismatch');
  const changed = await api.pages(prefix + '/pulls/' + prNumber + '/files');
  if (changed.length !== 1 || changed[0].filename !== FILE)
    throw new Error('Fixture contains unrelated changes');
  const file = await api.request('GET', prefix + '/contents/' + FILE + '?ref=' + BRANCH);
  if (file.encoding !== 'base64' || parseFixture(Buffer.from(file.content, 'base64').toString('utf8')) !== 'broken')
    throw new Error('Fixture is not in the deliberately broken state');
  const reviews = await api.pages(prefix + '/pulls/' + prNumber + '/reviews');
  // A genuine old-head REQUEST_CHANGES is the prerequisite for the repair test.
  if (!reviews.some(r => r.user?.login === 'AlexBDevCorner' &&
      r.state === 'CHANGES_REQUESTED' && r.commit_id === pr.head.sha))
    throw new Error('First perform the genuine exact-head REQUEST_CHANGES test');
  const update = await api.request('PUT', prefix + '/contents/' + FILE, {
    message: 'Repair disposable fixture after reviewed validation failure',
    content: Buffer.from(FIXTURE('ready')).toString('base64'),
    sha: file.sha, branch: BRANCH,
  });
  const newHead = update?.commit?.sha;
  if (!/^[a-f0-9]{40}$/.test(newHead ?? '') || newHead === pr.head.sha)
    throw new Error('Fixture correction commit not confirmed');
  return { operation: 'repaired', pr: prNumber, sha: newHead };
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== REPO ||
      process.env.GITHUB_REF !== 'refs/heads/master' ||
      process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch')
    throw new Error('Fixture creation only supports manual master dispatch');
  const api = new GitHub(process.env.FIXTURE_WORKER_TOKEN);
  const result = await operate({
    api, phase: process.env.FIXTURE_PHASE, confirmation: process.env.FIXTURE_CONFIRM,
    prNumber: Number(process.env.FIXTURE_PR ?? 0),
  });
  console.log('Fixture:', result.operation, 'PR:', result.pr, 'head:', result.sha);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
