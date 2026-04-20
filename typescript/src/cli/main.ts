/**
 * `licensing-keys` CLI entrypoint.
 *
 * Subcommands:
 *   make-root       Create a new root key.
 *   issue-signing   Issue a signing key certified by a root.
 *   rotate          Rotate the active signing key for (scope, alg).
 *   list            List stored keys (no secrets).
 *
 * Passphrase input is ENV-ONLY. Never accepted on argv. Empty passphrases
 * are refused: an unset or empty passphrase env var exits with code 1.
 *
 *   LICENSING_ROOT_PASSPHRASE      — unlocks / creates root keys
 *   LICENSING_SIGNING_PASSPHRASE   — unlocks / creates signing keys
 *
 * Exit codes:
 *   0   success
 *   1   user error (bad args, empty passphrase, unknown alg, etc.)
 *   2   system error (I/O, unexpected)
 */

import { parseArgs } from 'node:util';
import {
  ed25519Backend,
  hmacBackend,
  rsaPssBackend,
  type SignatureBackend,
} from '../crypto/index.ts';
import { LicensingError } from '../errors.ts';
import { KeyHierarchy } from '../key-hierarchy.ts';
import type { KeyAlg, LicenseKey, UUIDv7 } from '../types.ts';
import { JsonFileKeyStore } from './json-keystore.ts';

/**
 * All three signature backends are compiled in. Collapsing the former
 * `@licensing/crypto-*` packages into `@licensing/sdk` eliminates the
 * dynamic `import()` dance that previously lived in `backend-loader.ts`,
 * which could not be made reliably resolvable across bun workspaces AND
 * published-to-npm installs without opening a supply-chain footgun (CWD-
 * relative resolution). This is the same structure as the Go port's
 * single-module layout.
 *
 * Tree-shaking: downstream consumers that only verify tokens don't need
 * this map — they import from `@licensing/sdk/crypto/ed25519` (or the
 * specific backend) and register it into their own `AlgorithmRegistry`.
 * The CLI is the one caller that genuinely needs all three.
 */
const DEFAULT_BACKENDS: ReadonlyMap<KeyAlg, SignatureBackend> = new Map<KeyAlg, SignatureBackend>([
  ['ed25519', ed25519Backend],
  ['rs256-pss', rsaPssBackend],
  ['hs256', hmacBackend],
]);

export const USAGE = `\
licensing-keys — root/signing key management for @licensing/sdk

USAGE
  licensing-keys <command> [options]

COMMANDS
  make-root      Create a root key
  issue-signing  Issue a signing key under a root
  rotate         Rotate the active signing key (outgoing -> retiring)
  list           List keys (no secrets)

COMMON OPTIONS
  --store <path>      Path to the JSON keystore file (default: ./licensing-keys.json)
  --alg <alg>         Algorithm: ed25519 | rs256-pss | hs256
  --scope <uuid>      Scope id (optional; omit for global scope)
  --kid <string>      Override generated kid (optional)

make-root OPTIONS
  --not-after <iso>   Root validity end (optional)
  ENV: LICENSING_ROOT_PASSPHRASE (required, non-empty)

issue-signing OPTIONS
  --root-kid <kid>    Root kid to certify under (required)
  --not-after <iso>   Signing key validity end (optional)
  ENV: LICENSING_ROOT_PASSPHRASE, LICENSING_SIGNING_PASSPHRASE (both required, non-empty)

rotate OPTIONS
  --root-kid <kid>    Root kid (required; same scope+alg as the outgoing key)
  --retire-at <iso>   Clamp outgoing not_after to this instant (optional)
  ENV: LICENSING_ROOT_PASSPHRASE, LICENSING_SIGNING_PASSPHRASE (both required, non-empty)

list OPTIONS
  --role <role>       Filter: root | signing
  --state <state>     Filter: active | retiring

EXAMPLES
  LICENSING_ROOT_PASSPHRASE=... licensing-keys make-root --alg ed25519
  LICENSING_ROOT_PASSPHRASE=... LICENSING_SIGNING_PASSPHRASE=... \\
    licensing-keys issue-signing --alg ed25519 --root-kid root-xyz
`;

export interface RunOptions {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
  /** Optional backend overrides. Entries in this map take precedence over
   *  the compiled-in defaults for the matching alg. Tests / embedders use
   *  this to inject stub backends (e.g., a deterministic signer in CI); in
   *  production this is left unset and all three bundled backends apply. */
  readonly backends?: ReadonlyMap<KeyAlg, SignatureBackend>;
}

export type ExitCode = 0 | 1 | 2;

/** Programmatic entry point. Pure wrt argv/env/IO channels — tests
 *  invoke this directly instead of spawning a subprocess. */
export async function run(opts: RunOptions): Promise<ExitCode> {
  const [cmd, ...rest] = opts.argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    opts.stdout(USAGE);
    return 0;
  }
  try {
    switch (cmd) {
      case 'make-root':
        return await cmdMakeRoot(rest, opts);
      case 'issue-signing':
        return await cmdIssueSigning(rest, opts);
      case 'rotate':
        return await cmdRotate(rest, opts);
      case 'list':
        return await cmdList(rest, opts);
      default:
        opts.stderr(`licensing-keys: unknown command: ${cmd}\n${USAGE}`);
        return 1;
    }
  } catch (e) {
    return reportError(e, opts);
  }
}

// -------- subcommands --------

async function cmdMakeRoot(argv: readonly string[], opts: RunOptions): Promise<ExitCode> {
  const args = parseArgs({
    args: [...argv],
    options: {
      store: { type: 'string' },
      alg: { type: 'string' },
      scope: { type: 'string' },
      kid: { type: 'string' },
      'not-after': { type: 'string' },
    },
    strict: true,
  });
  const alg = requireAlg(args.values.alg);
  const storePath = args.values.store ?? './licensing-keys.json';
  const passphrase = requireEnv(opts.env, 'LICENSING_ROOT_PASSPHRASE');

  const backend = resolveBackend(alg, opts);
  const store = new JsonFileKeyStore(storePath);
  const h = new KeyHierarchy({ store, backends: new Map([[alg, backend]]) });
  const root = await h.generateRoot({
    scope_id: (args.values.scope ?? null) as UUIDv7 | null,
    alg,
    passphrase,
    ...(args.values.kid !== undefined ? { kid: args.values.kid } : {}),
    ...(args.values['not-after'] !== undefined ? { not_after: args.values['not-after'] } : {}),
  });
  opts.stdout(`${formatKey(root)}\n`);
  return 0;
}

async function cmdIssueSigning(argv: readonly string[], opts: RunOptions): Promise<ExitCode> {
  const args = parseArgs({
    args: [...argv],
    options: {
      store: { type: 'string' },
      alg: { type: 'string' },
      scope: { type: 'string' },
      kid: { type: 'string' },
      'root-kid': { type: 'string' },
      'not-after': { type: 'string' },
    },
    strict: true,
  });
  const alg = requireAlg(args.values.alg);
  const rootKid = requireFlag(args.values['root-kid'], '--root-kid');
  const storePath = args.values.store ?? './licensing-keys.json';
  const rootPassphrase = requireEnv(opts.env, 'LICENSING_ROOT_PASSPHRASE');
  const signingPassphrase = requireEnv(opts.env, 'LICENSING_SIGNING_PASSPHRASE');

  const backend = resolveBackend(alg, opts);
  const store = new JsonFileKeyStore(storePath);
  const h = new KeyHierarchy({ store, backends: new Map([[alg, backend]]) });
  const signing = await h.issueSigning({
    scope_id: (args.values.scope ?? null) as UUIDv7 | null,
    alg,
    rootKid,
    rootPassphrase,
    signingPassphrase,
    ...(args.values.kid !== undefined ? { kid: args.values.kid } : {}),
    ...(args.values['not-after'] !== undefined ? { not_after: args.values['not-after'] } : {}),
  });
  opts.stdout(`${formatKey(signing)}\n`);
  return 0;
}

async function cmdRotate(argv: readonly string[], opts: RunOptions): Promise<ExitCode> {
  const args = parseArgs({
    args: [...argv],
    options: {
      store: { type: 'string' },
      alg: { type: 'string' },
      scope: { type: 'string' },
      kid: { type: 'string' },
      'root-kid': { type: 'string' },
      'retire-at': { type: 'string' },
    },
    strict: true,
  });
  const alg = requireAlg(args.values.alg);
  const rootKid = requireFlag(args.values['root-kid'], '--root-kid');
  const storePath = args.values.store ?? './licensing-keys.json';
  const rootPassphrase = requireEnv(opts.env, 'LICENSING_ROOT_PASSPHRASE');
  const signingPassphrase = requireEnv(opts.env, 'LICENSING_SIGNING_PASSPHRASE');

  const backend = resolveBackend(alg, opts);
  const store = new JsonFileKeyStore(storePath);
  const h = new KeyHierarchy({ store, backends: new Map([[alg, backend]]) });
  const { outgoing, incoming } = await h.rotateSigning({
    scope_id: (args.values.scope ?? null) as UUIDv7 | null,
    alg,
    rootKid,
    rootPassphrase,
    signingPassphrase,
    ...(args.values.kid !== undefined ? { kid: args.values.kid } : {}),
    ...(args.values['retire-at'] !== undefined
      ? { retireOutgoingAt: args.values['retire-at'] }
      : {}),
  });
  opts.stdout(`retiring:\n${formatKey(outgoing)}\n\nactive:\n${formatKey(incoming)}\n`);
  return 0;
}

async function cmdList(argv: readonly string[], opts: RunOptions): Promise<ExitCode> {
  const args = parseArgs({
    args: [...argv],
    options: {
      store: { type: 'string' },
      role: { type: 'string' },
      state: { type: 'string' },
      scope: { type: 'string' },
      alg: { type: 'string' },
    },
    strict: true,
  });
  const storePath = args.values.store ?? './licensing-keys.json';
  const store = new JsonFileKeyStore(storePath);
  // `list` doesn't need a KeyHierarchy — it's a read-only store browse.
  const records = await store.list({
    ...(args.values.role !== undefined ? { role: args.values.role as LicenseKey['role'] } : {}),
    ...(args.values.state !== undefined ? { state: args.values.state as LicenseKey['state'] } : {}),
    ...(args.values.scope !== undefined ? { scope_id: args.values.scope as UUIDv7 } : {}),
    ...(args.values.alg !== undefined ? { alg: args.values.alg as KeyAlg } : {}),
  });
  if (records.length === 0) {
    opts.stdout('(no keys)\n');
    return 0;
  }
  for (const rec of records) opts.stdout(`${formatKey(rec)}\n`);
  return 0;
}

// -------- helpers --------

const VALID_ALGS: readonly KeyAlg[] = ['ed25519', 'rs256-pss', 'hs256'];

function requireAlg(v: string | undefined): KeyAlg {
  if (!v) throw new UsageError('--alg is required');
  if (!VALID_ALGS.includes(v as KeyAlg)) {
    throw new UsageError(`--alg must be one of: ${VALID_ALGS.join(', ')} (got ${v})`);
  }
  return v as KeyAlg;
}

function requireFlag(v: string | undefined, name: string): string {
  if (!v) throw new UsageError(`${name} is required`);
  return v;
}

function requireEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const v = env[name];
  if (v === undefined || v.length === 0) {
    // Spec: "Generation refuses empty passphrase".
    throw new UsageError(`env var ${name} is required and must be non-empty`);
  }
  return v;
}

/** Pick a backend for `alg`. Prefer the caller's explicit override; fall
 *  back to the compiled-in default registry. All three built-in backends
 *  are always available; `opts.backends` is only used by tests or embedders
 *  that want to install a stub (e.g., a mock signer in CI). */
function resolveBackend(alg: KeyAlg, opts: RunOptions): SignatureBackend {
  const override = opts.backends?.get(alg);
  if (override) return override;
  const b = DEFAULT_BACKENDS.get(alg);
  if (!b) {
    // Defensive: requireAlg already whitelists alg. This only trips if a
    // caller adds a new alg to the union without wiring a backend.
    throw new UsageError(`no backend registered for alg: ${alg}`);
  }
  return b;
}

function formatKey(rec: LicenseKey): string {
  // Never print private material. Show the public surface + state only.
  return [
    `  id:         ${rec.id}`,
    `  kid:        ${rec.kid}`,
    `  alg:        ${rec.alg}`,
    `  role:       ${rec.role}`,
    `  state:      ${rec.state}`,
    `  scope:      ${rec.scope_id ?? '(global)'}`,
    `  not_before: ${rec.not_before}`,
    `  not_after:  ${rec.not_after ?? '(none)'}`,
    rec.rotated_from ? `  rotated_from: ${rec.rotated_from}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

/** Thrown by arg/env validators — mapped to exit code 1. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function reportError(e: unknown, opts: RunOptions): ExitCode {
  if (e instanceof UsageError) {
    opts.stderr(`licensing-keys: ${e.message}\n`);
    return 1;
  }
  if (e instanceof LicensingError) {
    // Typed library errors are user-facing (bad passphrase, unknown kid, etc.)
    opts.stderr(`licensing-keys: ${e.code}: ${e.message}\n`);
    return 1;
  }
  // Anything else is a bug or system failure.
  const msg = (e as Error)?.stack ?? String(e);
  opts.stderr(`licensing-keys: unexpected error:\n${msg}\n`);
  return 2;
}
