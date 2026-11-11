/**
 * npm (package.json) and JSR (jsr.json) publish the same package, so every
 * subpath must exist in both. `./lic2` once shipped to npm only.
 */
import { expect, test } from 'bun:test';
import jsr from '../../jsr.json';
import pkg from '../../package.json';

test('jsr.json exports every package.json subpath, pointing at the same source', () => {
  const npm = Object.fromEntries(
    Object.entries(pkg.exports as Record<string, string | { types: string }>)
      .filter(([k]) => k !== './package.json')
      .map(([k, v]) => [k, typeof v === 'string' ? v : v.types]),
  );
  expect(jsr.exports).toEqual(npm);
});
