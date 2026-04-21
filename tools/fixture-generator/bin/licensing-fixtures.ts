#!/usr/bin/env bun

/**
 * Thin shebang wrapper so the tool can be invoked as a bin entry or run
 * directly with `bun run`. All logic lives in `../src/cli.ts` so tests can
 * import and drive it without touching argv or the filesystem.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../src/cli.ts';

// fixtures/ lives at the repo root, four levels up from tools/fixture-generator/bin/
const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '..', '..', '..', 'fixtures');

const code = await run(process.argv.slice(2), { fixturesDir });
process.exit(code);
