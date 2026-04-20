#!/usr/bin/env node

// Thin launcher for the `licensing-keys` CLI. Keeps the real logic in
// `src/cli/main.ts` where it's testable without spawning a subprocess.
//
// Resolution order:
//   1. Built dist (`../dist/cli/index.js`) — used by published installs.
//   2. Source (`../src/cli/index.ts`)       — used under Bun during dev.
//
// We probe #1 first because published consumers only have `dist/` in
// their tarball; falling through to #2 only matters for contributors
// running from a checkout.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(here, '../dist/cli/index.js');
const srcEntry = resolve(here, '../src/cli/index.ts');

const target = existsSync(distEntry) ? pathToFileURL(distEntry).href : pathToFileURL(srcEntry).href;

const { run } = await import(target);

const code = await run({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
process.exit(code);
