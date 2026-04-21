import { defineConfig } from 'tsdown';

// Dual ESM + CJS with .d.ts for every subpath export. Keep this list in sync
// with the `exports` map in package.json — drift means a consumer subpath
// resolves to a missing file.
export default defineConfig({
  entry: [
    './src/index.ts',
    './src/canonical-json.ts',
    './src/base64url.ts',
    './src/lic1.ts',
    './src/errors.ts',
    './src/encrypted-pkcs8.ts',
    './src/id.ts',
    './src/key-hierarchy.ts',
    './src/crypto/index.ts',
    './src/crypto/ed25519.ts',
    './src/crypto/rsa.ts',
    './src/crypto/hmac.ts',
    './src/client/index.ts',
    './src/http/index.ts',
    './src/http/adapters/hono.ts',
    './src/http/adapters/express.ts',
    './src/http/adapters/fastify.ts',
    './src/http/adapters/node.ts',
    './src/storage/index.ts',
    './src/storage/memory/index.ts',
    './src/storage/postgres/index.ts',
    './src/storage/postgres/migrations.ts',
    './src/storage/sqlite/index.ts',
    './src/storage/sqlite/migrations.ts',
    './src/cli/index.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  // `platform: 'neutral'` keeps tsdown's default extension pairing
  // (`.js` for ESM + `.cjs` for CJS) which matches the `exports` map in
  // package.json. Pinning `node` would flip ESM to `.mjs` and force a
  // rewrite of every subpath export — not worth it. The SDK runs on
  // Node, Bun, and Deno; rolldown treats `node:*` specifiers as external
  // automatically, so the build output is correct even though the build
  // log emits benign `UNRESOLVED_IMPORT` warnings for them.
  platform: 'neutral',
  unbundle: false,
  treeshake: true,
});
