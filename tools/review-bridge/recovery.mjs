import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { GitHub } from '../autonomy/github.mjs';
import { QueueApi } from './processor.mjs';
import { runReviewer, safeReason } from './reviewer.mjs';

export async function recoverRows({ queue, processRow, limit = 10 }) {
  if (!queue || typeof queue.recoverable !== 'function' || typeof processRow !== 'function')
    throw new Error('Invalid recovery dependencies');
  const ids = await queue.recoverable(limit);
  const outcomes = [];
  for (const id of ids) {
    try {
      outcomes.push({ id, ...(await processRow(id)) });
    } catch (error) {
      outcomes.push({ id, outcome: 'error', error: safeReason(error) });
    }
  }
  return outcomes;
}

function assertEnvironment(env) {
  if (env.GITHUB_REPOSITORY !== 'AlexBDevCorner/AutonomousWork' ||
      env.GITHUB_REF !== 'refs/heads/master' ||
      env.AUTONOMOUS_REVIEW_ENABLED !== 'true' ||
      !env.READ_GH_TOKEN || !env.MERGE_GH_TOKEN ||
      !env.AUTONOMOUS_REVIEWER_TOKEN ||
      !env.REVIEW_BRIDGE_QUEUE_TOKEN ||
      env.REVIEW_BRIDGE_QUEUE_TOKEN.length < 32) {
    throw new Error('Recovery disabled or required credentials missing');
  }
}

async function main() {
  assertEnvironment(process.env);
  const queue = new QueueApi(process.env.REVIEW_BRIDGE_QUEUE_TOKEN, fetch, 'live');
  const api = new GitHub(process.env.READ_GH_TOKEN);
  const outcomes = await recoverRows({
    queue,
    processRow: id => runReviewer({
      queue,
      api,
      reviewerToken: process.env.AUTONOMOUS_REVIEWER_TOKEN,
      mergeToken: process.env.MERGE_GH_TOKEN,
      id,
    }),
  });

  for (const item of outcomes)
    console.info('Review recovery:', item.id, item.outcome, item.status ?? '', item.reason ?? '');

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '### Review bridge recovery\n- Candidates: ' + outcomes.length +
      '\n- Errors: ' + outcomes.filter(x => x.outcome === 'error').length + '\n');
  }
  if (outcomes.some(x => x.outcome === 'error')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => {
    console.error('Review recovery stopped:', safeReason(error));
    process.exitCode = 1;
  });
