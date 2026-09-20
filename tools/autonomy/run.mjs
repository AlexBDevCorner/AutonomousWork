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

async function main() {
  const args = process.argv.slice(2);
  let retryTaskId = null;
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--retry') {
      if (retryTaskId || !args[i + 1] || !/^[A-Z][A-Z0-9]*-[0-9]+$/.test(args[i + 1]))
        throw new Error('Usage: node tools/autonomy/run.mjs [--apply | --validate] [--retry TASK-ID]');
      retryTaskId = args[++i];
    } else {
      flags.push(args[i]);
    }
  }
  if (flags.some(a => !['--apply', '--validate'].includes(a)) ||
      (retryTaskId && (!flags.includes('--apply') || flags.includes('--validate'))))
    throw new Error('Usage: node tools/autonomy/run.mjs [--apply | --validate] [--retry TASK-ID]');
  const root = process.cwd(), { config, state, catalog } = load(root);
  if (flags.includes('--validate')) { console.log('Automation configuration and state valid.'); return; }
  if (flags.includes('--apply') && execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim())
    throw new Error('Apply requires a clean checkout; commit/review planning changes first.');
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const taskTexts = Object.fromEntries(catalog.tasks.map(t => [t.relativePath, readFileSync(resolve(root, t.relativePath), 'utf8')]));
  const api = new GitHub(process.env.GH_TOKEN);
  const result = await coordinate({ config, state, catalog, sourceSha, taskTexts, api,
    apply: flags.includes('--apply'), retryTaskId });
  writeFileSync('automation/STATUS.md', result.summary);
  writeFileSync('automation/review-queue.json', JSON.stringify(result.reviewQueue, null, 2) + '\n');
  console.log(JSON.stringify({ applied: result.applied, executionEnabled: config.enabled, selected: result.selected,
    reviewQueue: result.reviewQueue, executions: result.state.executions.length }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, 'run.mjs'))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
