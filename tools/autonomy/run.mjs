import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { GitHub } from './github.mjs';
import { coordinate, validateState } from './coordinator.mjs';

export function load(root) {
  const config = JSON.parse(readFileSync(resolve(root, 'automation/config.json'), 'utf8'));
  const state = JSON.parse(readFileSync(resolve(root, 'automation/state.json'), 'utf8'));
  // The workflow builds first; executing the DLL keeps build output off the JSON channel.
  const dll = resolve(root, 'tools/AutonomousWork.Cli/bin/Release/net8.0/autonomous-work.dll');
  const catalog = JSON.parse(execFileSync('dotnet', [dll, 'catalog', '--root', root], { encoding: 'utf8' }));
  validateState(catalog, state, config);
  return { config, state, catalog };
}

export function parseArgs(args) {
  const usage = 'Usage: node tools/autonomy/run.mjs [--apply | --validate] [--retry TASK-ID | --resume-correction TASK-ID --review-id ID --expected-head SHA --resolution-url URL]';
  const values = {}, flags = new Set();
  const valueFlags = ['--retry', '--resume-correction', '--review-id', '--expected-head', '--resolution-url'];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueFlags.includes(arg) && !(arg in values) && args[i + 1] && !args[i + 1].startsWith('--'))
      values[arg] = args[++i];
    else if (['--apply', '--validate'].includes(arg) && !flags.has(arg)) flags.add(arg);
    else throw new Error(usage);
  }
  const retryTaskId = values['--retry'] ?? null, resume = values['--resume-correction'];
  const recoveryFlags = valueFlags.slice(1);
  const hasRecovery = recoveryFlags.some(k => k in values);
  if ((flags.has('--apply') && flags.has('--validate')) ||
      (retryTaskId && (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(retryTaskId) || !flags.has('--apply') || hasRecovery)) ||
      (hasRecovery && (flags.has('--validate') || recoveryFlags.some(k => !values[k]) ||
        !/^[A-Z][A-Z0-9]*-[0-9]+$/.test(resume) || !/^[1-9][0-9]*$/.test(values['--review-id']) ||
        !Number.isSafeInteger(Number(values['--review-id'])) || !/^[a-f0-9]{40}$/.test(values['--expected-head']) ||
        !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9][0-9]*#issuecomment-[1-9][0-9]*$/.test(values['--resolution-url']))))
    throw new Error(usage);
  return { apply: flags.has('--apply'), validate: flags.has('--validate'), retryTaskId,
    reviewRecovery: hasRecovery ? { taskId: resume, reviewId: Number(values['--review-id']),
      headSha: values['--expected-head'], resolutionUrl: values['--resolution-url'] } : null };
}

async function main() {
  const { apply, validate, retryTaskId, reviewRecovery } = parseArgs(process.argv.slice(2));
  const root = process.cwd(), { config, state, catalog } = load(root);
  if (validate) { console.log('Automation configuration and state valid.'); return; }
  if (apply && execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim())
    throw new Error('Apply requires a clean checkout; commit/review planning changes first.');
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const taskTexts = Object.fromEntries(catalog.tasks.map(t => [t.relativePath, readFileSync(resolve(root, t.relativePath), 'utf8')]));
  const api = new GitHub(process.env.GH_TOKEN);
  const result = await coordinate({ config, state, catalog, sourceSha, taskTexts, api,
    apply, retryTaskId, reviewRecovery });
  writeFileSync('automation/STATUS.md', result.summary);
  writeFileSync('automation/review-queue.json', JSON.stringify(result.reviewQueue, null, 2) + '\n');
  console.log(JSON.stringify({ applied: result.applied, executionEnabled: config.enabled, selected: result.selected,
    reviewQueue: result.reviewQueue, executions: result.state.executions.length }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, 'run.mjs'))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
