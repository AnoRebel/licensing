import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_STATE, FileTokenStore, MemoryTokenStore } from '../../src/client/token-store.ts';

describe('MemoryTokenStore', () => {
  it('starts empty', async () => {
    const store = new MemoryTokenStore();
    expect(await store.read()).toEqual(EMPTY_STATE);
  });

  it('round-trips write/read', async () => {
    const store = new MemoryTokenStore();
    await store.write({ token: 'LIC1.x.y.z', graceStartSec: 1234 });
    expect(await store.read()).toEqual({ token: 'LIC1.x.y.z', graceStartSec: 1234 });
  });

  it('clear resets to empty', async () => {
    const store = new MemoryTokenStore();
    await store.write({ token: 'x', graceStartSec: 1 });
    await store.clear();
    expect(await store.read()).toEqual(EMPTY_STATE);
  });
});

describe('FileTokenStore', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  const mk = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'licensing-client-'));
    dirs.push(dir);
    return join(dir, 'token.json');
  };

  it('rejects empty path', () => {
    expect(() => new FileTokenStore('')).toThrow('non-empty');
  });

  it('read of missing file returns EMPTY_STATE (no throw)', async () => {
    const store = new FileTokenStore(await mk());
    expect(await store.read()).toEqual(EMPTY_STATE);
  });

  it('write creates the parent dir and persists atomically', async () => {
    const path = join(
      await mkdtemp(join(tmpdir(), 'licensing-client-')),
      'nested',
      'sub',
      'token.json',
    );
    dirs.push(path);
    const store = new FileTokenStore(path);
    await store.write({ token: 'tok', graceStartSec: 42 });
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('"token": "tok"');
    expect(raw).toContain('"graceStartSec": 42');
  });

  it('round-trips through the filesystem', async () => {
    const path = await mk();
    const a = new FileTokenStore(path);
    await a.write({ token: 'abc', graceStartSec: null });
    const b = new FileTokenStore(path);
    expect(await b.read()).toEqual({ token: 'abc', graceStartSec: null });
  });

  it('corrupted JSON degrades to EMPTY_STATE rather than throwing', async () => {
    const path = await mk();
    await Bun.write(path, 'not json at all {{{');
    const store = new FileTokenStore(path);
    expect(await store.read()).toEqual(EMPTY_STATE);
  });

  it('clear removes the file and is idempotent', async () => {
    const path = await mk();
    const store = new FileTokenStore(path);
    await store.write({ token: 'x', graceStartSec: null });
    await store.clear();
    expect(await store.read()).toEqual(EMPTY_STATE);
    // Second clear is a no-op, must not throw.
    await store.clear();
  });

  it('unknown top-level fields are ignored (forward-compat)', async () => {
    const path = await mk();
    await Bun.write(
      path,
      JSON.stringify({ token: 'k', graceStartSec: null, futureField: 'ignored' }),
    );
    const store = new FileTokenStore(path);
    expect(await store.read()).toEqual({ token: 'k', graceStartSec: null });
  });
});
