/**
 * `licensing-keys` CLI tests.
 *
 * Backends (ed25519 / rs256-pss / hs256) are compiled into `@licensing/sdk`
 * and wired up statically in `src/cli/main.ts` — no dynamic resolution, no
 * per-test backend injection needed. Tests call `run()` in-process with
 * stubbed argv/env/IO channels so we assert exit codes, stdout lines, and
 * keystore JSON shape deterministically without spawning a subprocess.
 * One end-to-end `Bun.spawn` test at the bottom confirms the shebang +
 * launcher actually work against the bundled bin.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, USAGE } from '../../src/cli/index.ts';

interface CapturedIO {
  out: string;
  err: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

function mkIO(): CapturedIO {
  const io: CapturedIO = {
    out: '',
    err: '',
    stdout: (s: string) => {
      io.out += s;
    },
    stderr: (s: string) => {
      io.err += s;
    },
  };
  return io;
}

let tmp: string;
let storePath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'licensing-keys-'));
  storePath = join(tmp, 'keys.json');
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('licensing-keys — help', () => {
  it('prints USAGE with no args and exits 0', async () => {
    const io = mkIO();
    const code = await run({ argv: [], env: {}, stdout: io.stdout, stderr: io.stderr });
    expect(code).toBe(0);
    expect(io.out).toBe(USAGE);
  });

  it('prints USAGE for --help and exits 0', async () => {
    const io = mkIO();
    const code = await run({
      argv: ['--help'],
      env: {},
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(io.out).toContain('USAGE');
  });

  it('exits 1 on unknown command', async () => {
    const io = mkIO();
    const code = await run({
      argv: ['frobnicate'],
      env: {},
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
    expect(io.err).toContain('unknown command');
  });
});

describe('licensing-keys make-root — passphrase requirement', () => {
  it('refuses when LICENSING_ROOT_PASSPHRASE is unset (exit 1)', async () => {
    const io = mkIO();
    const code = await run({
      argv: ['make-root', '--alg', 'ed25519', '--store', storePath],
      env: {}, // no passphrase
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
    expect(io.err).toContain('LICENSING_ROOT_PASSPHRASE');
    expect(existsSync(storePath)).toBe(false);
  });

  it('refuses when LICENSING_ROOT_PASSPHRASE is empty (exit 1)', async () => {
    const io = mkIO();
    const code = await run({
      argv: ['make-root', '--alg', 'ed25519', '--store', storePath],
      env: { LICENSING_ROOT_PASSPHRASE: '' },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
    expect(io.err).toContain('LICENSING_ROOT_PASSPHRASE');
  });

  it('rejects an unknown --alg', async () => {
    const io = mkIO();
    const code = await run({
      argv: ['make-root', '--alg', 'rsa-weird', '--store', storePath],
      env: { LICENSING_ROOT_PASSPHRASE: 'pw' },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
    expect(io.err).toContain('--alg must be one of');
  });

  it('rejects a missing --alg', async () => {
    const io = mkIO();
    const code = await run({
      argv: ['make-root', '--store', storePath],
      env: { LICENSING_ROOT_PASSPHRASE: 'pw' },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
    expect(io.err).toContain('--alg is required');
  });
});

describe('licensing-keys make-root — happy path', () => {
  it('creates a root key and persists it to the JSON store', async () => {
    const io = mkIO();
    const code = await run({
      argv: ['make-root', '--alg', 'ed25519', '--store', storePath],
      env: { LICENSING_ROOT_PASSPHRASE: 'rootpw' },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect({ code, out: io.out, err: io.err }).toMatchObject({ code: 0 });
    expect(io.out).toContain('role:       root');
    expect(io.out).toContain('state:      active');
    expect(io.out).toContain('alg:        ed25519');
    expect(existsSync(storePath)).toBe(true);

    const lines = readFileSync(storePath, 'utf8').trim().split('\n');
    expect(lines[0]).toBe('{"__kind":"licensing-keys/v1"}');
    expect(lines.length).toBe(2);
    const rec = JSON.parse(lines[1] as string);
    expect(rec.role).toBe('root');
    expect(rec.alg).toBe('ed25519');
    expect(rec.private_pem_enc).toContain('-----BEGIN ENCRYPTED PRIVATE KEY-----');
    expect(rec.private_pem_enc).not.toContain('-----BEGIN PRIVATE KEY-----');
  });
});

describe('licensing-keys issue-signing', () => {
  async function makeRoot(env = 'rootpw'): Promise<string> {
    const io = mkIO();
    const code = await run({
      argv: ['make-root', '--alg', 'ed25519', '--store', storePath],
      env: { LICENSING_ROOT_PASSPHRASE: env },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    const kidLine = io.out.split('\n').find((l) => l.trim().startsWith('kid:'));
    if (!kidLine) throw new Error(`no kid in output: ${io.out}`);
    return kidLine.split(':').slice(1).join(':').trim();
  }

  it('refuses when either passphrase is missing', async () => {
    const rootKid = await makeRoot();
    const io = mkIO();
    const code = await run({
      argv: ['issue-signing', '--alg', 'ed25519', '--root-kid', rootKid, '--store', storePath],
      env: { LICENSING_ROOT_PASSPHRASE: 'rootpw' /* signing missing */ },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
    expect(io.err).toContain('LICENSING_SIGNING_PASSPHRASE');
  });

  it('refuses when --root-kid is missing', async () => {
    await makeRoot();
    const io = mkIO();
    const code = await run({
      argv: ['issue-signing', '--alg', 'ed25519', '--store', storePath],
      env: {
        LICENSING_ROOT_PASSPHRASE: 'rootpw',
        LICENSING_SIGNING_PASSPHRASE: 'signpw',
      },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
    expect(io.err).toContain('--root-kid');
  });

  it('issues a signing key under a valid root and persists both', async () => {
    const rootKid = await makeRoot();
    const io = mkIO();
    const code = await run({
      argv: ['issue-signing', '--alg', 'ed25519', '--root-kid', rootKid, '--store', storePath],
      env: {
        LICENSING_ROOT_PASSPHRASE: 'rootpw',
        LICENSING_SIGNING_PASSPHRASE: 'signpw',
      },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(io.out).toContain('role:       signing');
    expect(io.out).toContain('state:      active');

    const lines = readFileSync(storePath, 'utf8').trim().split('\n').slice(1);
    expect(lines.length).toBe(2); // root + signing
    const roles = lines.map((l) => (JSON.parse(l) as { role: string }).role).sort();
    expect(roles).toEqual(['root', 'signing']);
  });

  it('surfaces wrong root passphrase as exit 1 with KeyDecryptionFailed', async () => {
    const rootKid = await makeRoot('rootpw');
    const io = mkIO();
    const code = await run({
      argv: ['issue-signing', '--alg', 'ed25519', '--root-kid', rootKid, '--store', storePath],
      env: {
        LICENSING_ROOT_PASSPHRASE: 'wrong',
        LICENSING_SIGNING_PASSPHRASE: 'signpw',
      },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1);
    expect(io.err).toContain('KeyDecryptionFailed');
  });
});

describe('licensing-keys rotate', () => {
  async function seedRootAndSigning(): Promise<{ rootKid: string }> {
    const io = mkIO();
    await run({
      argv: ['make-root', '--alg', 'ed25519', '--store', storePath],
      env: { LICENSING_ROOT_PASSPHRASE: 'rootpw' },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    const rootKidLine = io.out.split('\n').find((l) => l.trim().startsWith('kid:'));
    if (!rootKidLine) throw new Error(`no root kid: ${io.out}`);
    const rootKid = rootKidLine.split(':').slice(1).join(':').trim();

    const io2 = mkIO();
    await run({
      argv: ['issue-signing', '--alg', 'ed25519', '--root-kid', rootKid, '--store', storePath],
      env: {
        LICENSING_ROOT_PASSPHRASE: 'rootpw',
        LICENSING_SIGNING_PASSPHRASE: 'signpw',
      },
      stdout: io2.stdout,
      stderr: io2.stderr,
    });
    return { rootKid };
  }

  it('transitions outgoing -> retiring and issues a new active', async () => {
    const { rootKid } = await seedRootAndSigning();
    const io = mkIO();
    const code = await run({
      argv: ['rotate', '--alg', 'ed25519', '--root-kid', rootKid, '--store', storePath],
      env: {
        LICENSING_ROOT_PASSPHRASE: 'rootpw',
        LICENSING_SIGNING_PASSPHRASE: 'signpw2',
      },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(io.out).toContain('retiring:');
    expect(io.out).toContain('active:');

    const records = readFileSync(storePath, 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => JSON.parse(l) as { role: string; state: string });
    const signing = records.filter((r) => r.role === 'signing');
    expect(signing.length).toBe(2);
    const states = signing.map((r) => r.state).sort();
    expect(states).toEqual(['active', 'retiring']);
  });
});

describe('licensing-keys list', () => {
  it('prints "(no keys)" for an empty/missing store', async () => {
    const io = mkIO();
    const code = await run({
      argv: ['list', '--store', storePath],
      env: {},
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    expect(io.out).toContain('(no keys)');
  });

  it('lists populated keys and supports --role filter', async () => {
    // Seed root + signing.
    const makeIO = mkIO();
    await run({
      argv: ['make-root', '--alg', 'ed25519', '--store', storePath],
      env: { LICENSING_ROOT_PASSPHRASE: 'rootpw' },
      stdout: makeIO.stdout,
      stderr: makeIO.stderr,
    });
    const rootKidLine = makeIO.out.split('\n').find((l) => l.trim().startsWith('kid:'));
    const rootKid = rootKidLine?.split(':').slice(1).join(':').trim() ?? '';
    const issueIO = mkIO();
    await run({
      argv: ['issue-signing', '--alg', 'ed25519', '--root-kid', rootKid, '--store', storePath],
      env: {
        LICENSING_ROOT_PASSPHRASE: 'rootpw',
        LICENSING_SIGNING_PASSPHRASE: 'signpw',
      },
      stdout: issueIO.stdout,
      stderr: issueIO.stderr,
    });

    const listAll = mkIO();
    await run({
      argv: ['list', '--store', storePath],
      env: {},
      stdout: listAll.stdout,
      stderr: listAll.stderr,
    });
    expect(listAll.out).toContain('role:       root');
    expect(listAll.out).toContain('role:       signing');

    const listRoots = mkIO();
    await run({
      argv: ['list', '--store', storePath, '--role', 'root'],
      env: {},
      stdout: listRoots.stdout,
      stderr: listRoots.stderr,
    });
    expect(listRoots.out).toContain('role:       root');
    expect(listRoots.out).not.toContain('role:       signing');
  });

  it('never prints private_pem_enc in list output', async () => {
    // Seed a root, then list.
    const ioA = mkIO();
    await run({
      argv: ['make-root', '--alg', 'ed25519', '--store', storePath],
      env: { LICENSING_ROOT_PASSPHRASE: 'rootpw' },
      stdout: ioA.stdout,
      stderr: ioA.stderr,
    });
    const ioB = mkIO();
    await run({
      argv: ['list', '--store', storePath],
      env: {},
      stdout: ioB.stdout,
      stderr: ioB.stderr,
    });
    // formatKey must not leak the encrypted envelope bytes.
    expect(ioB.out).not.toContain('ENCRYPTED PRIVATE KEY');
    expect(ioB.out).not.toContain('private_pem_enc');
  });
});

describe('licensing-keys — end-to-end subprocess smoke', () => {
  it('the bin/licensing-keys.js launcher prints usage with exit 0', async () => {
    // The bin file lives in this same package now.
    const binPath = join(import.meta.dir, '../../bin/licensing-keys.js');
    expect(existsSync(binPath)).toBe(true);

    const proc = Bun.spawn(['bun', binPath, '--help'], {
      env: { ...process.env, NODE_ENV: 'test' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    expect(out).toContain('licensing-keys');
    expect(out).toContain('make-root');
    expect(out).toContain('issue-signing');
    expect(out).toContain('rotate');
  });
});
