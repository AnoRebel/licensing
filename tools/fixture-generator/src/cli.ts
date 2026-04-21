/**
 * CLI orchestrator for the fixture generator.
 *
 * Subcommands:
 *   build <vector-dir>      Regenerate canonical_*.bin + expected_token.txt
 *                           for a single vector directory.
 *   build-all               Scan fixtures/tokens/<nnn>/ and build each.
 *   tamper <vector-dir>     Read <vector-dir>/tampers.json and emit sibling
 *                           directories under fixtures/tokens-invalid/.
 *   tamper-all              Run `tamper` for every vector that has a
 *                           tampers.json.
 *
 * All commands are idempotent — running them twice produces the same bytes
 * (deterministic signing only works for Ed25519 and HMAC; RSA-PSS uses a
 * random salt, so RSA vectors are regenerated fresh each run — see the
 * README note in fixtures/tokens/<rsa-vector>/).
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { type GeneratedToken, generate } from './generate.ts';
import { tamper } from './tamper.ts';
import type { TamperManifest, ValidInputs } from './types.ts';

export interface RunOptions {
  /** Absolute path to the repository's `fixtures/` directory. */
  readonly fixturesDir: string;
  /** Optional writer override for tests; defaults to `writeFileSync`. */
  readonly write?: (path: string, data: Uint8Array | string) => void;
}

export async function run(argv: readonly string[], opts: RunOptions): Promise<number> {
  const args = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    options: {},
  });
  const [cmd, ...rest] = args.positionals;
  const writer =
    opts.write ??
    ((p, d) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, d);
    });

  switch (cmd) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      printHelp();
      return 0;

    case 'build': {
      const dir = rest[0];
      if (!dir) {
        console.error('usage: licensing-fixtures build <vector-dir>');
        return 2;
      }
      await buildOne(resolve(dir), opts.fixturesDir, writer);
      return 0;
    }

    case 'build-all': {
      const tokensDir = join(opts.fixturesDir, 'tokens');
      const vectorDirs = listVectorDirs(tokensDir);
      for (const d of vectorDirs) {
        await buildOne(d, opts.fixturesDir, writer);
      }
      console.info(`built ${vectorDirs.length} vectors`);
      return 0;
    }

    case 'tamper': {
      const dir = rest[0];
      if (!dir) {
        console.error('usage: licensing-fixtures tamper <vector-dir>');
        return 2;
      }
      await tamperOne(resolve(dir), opts.fixturesDir, writer);
      return 0;
    }

    case 'tamper-all': {
      const tokensDir = join(opts.fixturesDir, 'tokens');
      const vectorDirs = listVectorDirs(tokensDir);
      let count = 0;
      for (const d of vectorDirs) {
        const n = await tamperOne(d, opts.fixturesDir, writer).catch((e) => {
          if (isMissingTampers(e)) return 0;
          throw e;
        });
        count += n;
      }
      console.info(`emitted ${count} tamper variants`);
      return 0;
    }

    default:
      console.error(`unknown subcommand: ${cmd}`);
      printHelp();
      return 2;
  }
}

function printHelp(): void {
  console.info(
    [
      'licensing-fixtures — regenerate LIC1 test vectors.',
      '',
      'Usage:',
      '  licensing-fixtures build      <vector-dir>   Rebuild one vector',
      '  licensing-fixtures build-all                  Rebuild every vector under fixtures/tokens/',
      '  licensing-fixtures tamper     <vector-dir>   Emit the tampers.json siblings',
      '  licensing-fixtures tamper-all                 Emit every tampers.json',
      '',
      'Note: RSA-PSS uses randomized salts, so RSA vectors change on every run.',
      'Ed25519 and HMAC are deterministic.',
    ].join('\n'),
  );
}

async function buildOne(
  vectorDir: string,
  fixturesDir: string,
  write: (p: string, d: Uint8Array | string) => void,
): Promise<GeneratedToken> {
  const inputs = readInputs(vectorDir);
  const generated = await generate(fixturesDir, inputs);
  write(join(vectorDir, 'canonical_header.bin'), generated.canonicalHeader);
  write(join(vectorDir, 'canonical_payload.bin'), generated.canonicalPayload);
  write(join(vectorDir, 'expected_token.txt'), `${generated.token}\n`);
  return generated;
}

async function tamperOne(
  vectorDir: string,
  fixturesDir: string,
  write: (p: string, d: Uint8Array | string) => void,
): Promise<number> {
  const inputs = readInputs(vectorDir);
  const manifest = readTamperManifest(vectorDir);
  const source = await generate(fixturesDir, inputs);

  const invalidRoot = join(fixturesDir, 'tokens-invalid');
  let emitted = 0;
  for (const spec of manifest.variants) {
    const variantDir = join(invalidRoot, `${manifest.source}-${spec.variant}`);
    const tampered = await tamper(fixturesDir, inputs, source, spec);
    // Mirror the valid-vector file shape so both ports can read them the
    // same way. We additionally write a `spec.json` so the test-side knows
    // what kind of tamper this is — useful for asserting the right rejection
    // error class.
    write(join(variantDir, 'canonical_header.bin'), tampered.canonicalHeader);
    write(join(variantDir, 'canonical_payload.bin'), tampered.canonicalPayload);
    write(join(variantDir, 'token.txt'), `${tampered.token}\n`);
    write(
      join(variantDir, 'spec.json'),
      `${JSON.stringify({ source: manifest.source, ...spec }, null, 2)}\n`,
    );
    emitted++;
  }
  return emitted;
}

// ---------- fs helpers ----------

function listVectorDirs(tokensDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(tokensDir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => /^[0-9]{3}/.test(e))
    .map((e) => join(tokensDir, e))
    .sort();
}

function readInputs(vectorDir: string): ValidInputs {
  const raw = readFileSync(join(vectorDir, 'inputs.json'), 'utf8');
  const parsed = JSON.parse(raw) as ValidInputs;
  // Light shape check — full validation is the job of the core.
  if (!parsed.alg || !parsed.kid || !parsed.key_ref || !parsed.header || !parsed.payload) {
    throw new Error(`inputs.json in ${basename(vectorDir)} missing required fields`);
  }
  return parsed;
}

function readTamperManifest(vectorDir: string): TamperManifest {
  const raw = readFileSync(join(vectorDir, 'tampers.json'), 'utf8');
  const parsed = JSON.parse(raw) as TamperManifest;
  if (!parsed.source || !Array.isArray(parsed.variants)) {
    throw new Error(`tampers.json in ${basename(vectorDir)} is missing source or variants`);
  }
  return parsed;
}

function isMissingTampers(e: unknown): boolean {
  return e instanceof Error && 'code' in e && (e as { code: unknown }).code === 'ENOENT';
}
