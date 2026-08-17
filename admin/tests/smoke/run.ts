/**
 * Runs each smoke file in its own `bun test` process, sequentially.
 *
 * bunwright exposes `browser` as a module-level singleton. Bun runs test
 * FILES concurrently in one process, so two smoke files share that one
 * browser — and whichever `afterAll` fires first calls `browser.close()`
 * out from under the other, which then fails mid-`beforeAll` during
 * sign-in. Each file passes alone and they fail together, which is the
 * signature of shared global state rather than a bad assertion.
 *
 * One process per file gives each its own singleton. Sequential rather
 * than parallel because every file also boots the built Nitro server, and
 * parallel runs would contend for the port as well.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;

const files = readdirSync(here)
  .filter((f) => f.endsWith('.smoke.test.ts'))
  .sort();

if (files.length === 0) {
  console.error('no *.smoke.test.ts files found in tests/smoke');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  console.log(`\n─── ${file} ───`);
  const proc = Bun.spawnSync(['bun', 'test', join('tests/smoke', file)], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });
  if (proc.exitCode !== 0) failed++;
}

if (failed > 0) {
  console.error(`\n${failed} of ${files.length} smoke file(s) failed`);
  process.exit(1);
}
console.log(`\nall ${files.length} smoke file(s) passed`);
