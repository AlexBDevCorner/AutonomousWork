// No secrets and no network: fixture-validation is an actual red/green CI check.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { FILE, parseFixture } from './review-write.mjs';

export function verifyFixture(source) {
  return parseFixture(source) === 'ready';
}
function main() {
  const source = readFileSync(FILE, 'utf8');
  if (!verifyFixture(source)) {
    console.error('Fixture contract failed: fixture_status must be ready (see Step 4 guide)');
    process.exitCode = 1;
  } else console.log('Disposable fixture meets repository contract.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
