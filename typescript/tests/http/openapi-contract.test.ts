/**
 * OpenAPI contract-conformance suite.
 *
 * Loads `openapi/licensing-admin.yaml`, wires the admin + client handler
 * groups to a `Storage` backend, hits every representative endpoint, and
 * asserts the response body validates against the OpenAPI envelope schema.
 *
 * Backend matrix (mirrors `packages/core/tests/usage-service.test.ts`):
 *   - memory    — always.
 *   - sqlite    — always (in-memory DB).
 *   - postgres  — opt-in via `LICENSING_PG_URL`; isolates each test run in
 *                 its own schema so parallel runs don't clobber each other.
 *                 Local bootstrap:
 *                   docker run -d --name licensing-pg -p 55432:5432 \
 *                     -e POSTGRES_PASSWORD=test -e POSTGRES_DB=licensing_test \
 *                     postgres:18-alpine
 *                   export LICENSING_PG_URL=postgres://postgres:test@localhost:55432/licensing_test
 *
 * The OpenAPI document is the source of truth — any drift between a
 * handler's wire shape and the `…Envelope` schema fails the merge.
 */

import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, it } from 'bun:test';
import {
  createFixedClock,
  createLicense,
  createScope,
  ed25519Backend,
  generateRootKey,
  issueInitialSigningKey,
  type KeyAlg,
  type License,
  type LicenseScope,
  type SignatureBackend,
  type Storage,
} from '@anorebel/licensing';
import { MemoryStorage } from '@anorebel/licensing/storage/memory';
import { PostgresStorage } from '@anorebel/licensing/storage/postgres';
import { applyMigrations as applyPgMigrations } from '@anorebel/licensing/storage/postgres/migrations';
import { SqliteStorage } from '@anorebel/licensing/storage/sqlite';
import { applyMigrations as applySqliteMigrations } from '@anorebel/licensing/storage/sqlite/migrations';
import { Pool } from 'pg';

import { adminRoutes } from '../../src/http/admin-handlers.ts';
import { clientRoutes } from '../../src/http/client-handlers.ts';
import type { AdminHandlerContext, ClientHandlerContext } from '../../src/http/context.ts';
import { createRouter } from '../../src/http/router.ts';
import type { Handler, HandlerRequest, HandlerResponse, JsonValue } from '../../src/http/types.ts';
import { type Schema, type ValidationError, validate } from './openapi-validator.ts';

// ---------- OpenAPI spec ----------

// Bun's built-in YAML parser avoids pulling `js-yaml` in as a test dep.
// The OpenAPI document path is stable relative to the monorepo root.
const SPEC_PATH = new URL('../../../openapi/licensing-admin.yaml', import.meta.url).pathname;
const SPEC_TEXT = await Bun.file(SPEC_PATH).text();
const SPEC = Bun.YAML.parse(SPEC_TEXT) as {
  components: { schemas: Record<string, Schema> };
};

/** Shortcut: fetch an envelope schema by its spec name. */
function s(name: string): Schema {
  const schema = SPEC.components.schemas[name];
  if (schema === undefined) throw new Error(`schema not in spec: ${name}`);
  return schema;
}

/** Assert a body conforms to the named envelope schema. Fails with a
 *  dotted-path report so drift is obvious. */
function expectEnvelope(name: string, body: unknown): void {
  const errors: readonly ValidationError[] = validate(SPEC, s(name), body);
  if (errors.length > 0) {
    const msg = errors.map((e) => `  • ${e.path || '<root>'}: ${e.message}`).join('\n');
    throw new Error(
      `envelope \`${name}\` validation failed:\n${msg}\n  body=${JSON.stringify(body)}`,
    );
  }
}

// ---------- Fixture bootstrap ----------

type Backend = {
  name: string;
  make: () => Promise<{ s: Storage; cleanup: () => Promise<void> }>;
};

const PG_URL = process.env.LICENSING_PG_URL;
const CLOCK = createFixedClock('2026-04-15T00:00:00.000000Z');
const BACKENDS_MAP: ReadonlyMap<KeyAlg, SignatureBackend> = new Map<KeyAlg, SignatureBackend>([
  ['ed25519', ed25519Backend],
]);

let pgMaster: Pool | null = null;
function masterPool(): Pool {
  if (pgMaster === null) pgMaster = new Pool({ connectionString: PG_URL });
  return pgMaster;
}

async function makePgStorage(): Promise<{ s: Storage; cleanup: () => Promise<void> }> {
  const master = masterPool();
  const schema = `t_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  await master.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: PG_URL, max: 4 });
  pool.on('connect', (c) => {
    c.query(`SET search_path TO "${schema}"`).catch(() => undefined);
  });
  await applyPgMigrations(pool);
  const storage = new PostgresStorage(pool, { clock: CLOCK });
  return {
    s: storage,
    cleanup: async () => {
      await pool.end();
      await master.query(`DROP SCHEMA "${schema}" CASCADE`);
    },
  };
}

const BACKENDS: readonly Backend[] = [
  {
    name: 'memory',
    make: async () => ({ s: new MemoryStorage({ clock: CLOCK }), cleanup: async () => undefined }),
  },
  {
    name: 'sqlite',
    make: async () => {
      const db = new Database(':memory:');
      applySqliteMigrations(db);
      const storage = new SqliteStorage(db, { clock: CLOCK, skipWalPragma: true });
      return { s: storage, cleanup: async () => db.close() };
    },
  },
  ...(PG_URL !== undefined ? [{ name: 'postgres', make: makePgStorage } satisfies Backend] : []),
];

/** Seed a full scope+root+signing+license graph so list/get/lifecycle
 *  endpoints all have something real to return. Capturing the returned
 *  key rows avoids a follow-up `listKeys` query. */
async function seed(
  storage: Storage,
): Promise<{ scope: LicenseScope; license: License; signingKid: string }> {
  const scope = await createScope(storage, CLOCK, { slug: 'acme', name: 'Acme Corp' });
  const root = await generateRootKey(storage, CLOCK, BACKENDS_MAP, {
    scope_id: scope.id,
    alg: 'ed25519',
    passphrase: 'root-pw',
  });
  const signing = await issueInitialSigningKey(storage, CLOCK, BACKENDS_MAP, {
    scope_id: scope.id,
    alg: 'ed25519',
    rootKid: root.kid,
    rootPassphrase: 'root-pw',
    signingPassphrase: 'sign-pw',
  });
  const license = await createLicense(storage, CLOCK, {
    scope_id: scope.id,
    template_id: null,
    licensable_type: 'User',
    licensable_id: 'u-1',
    max_usages: 3,
  });
  return { scope, license, signingKid: signing.kid };
}

function mkAdminCtx(storage: Storage): AdminHandlerContext {
  return {
    storage,
    clock: CLOCK,
    backends: BACKENDS_MAP,
    version: '0.1.0',
    rootPassphrase: 'root-pw',
    signingPassphrase: 'sign-pw',
  };
}

function mkClientCtx(storage: Storage): ClientHandlerContext {
  return {
    storage,
    clock: CLOCK,
    backends: BACKENDS_MAP,
    version: '0.1.0',
    signingPassphrase: 'sign-pw',
    defaultAlg: 'ed25519',
    tokenTtlSec: 3600,
  };
}

/** Minimal `HandlerRequest` builder — leaves path, query, headers, body up
 *  to the caller. Matches the shape adapters produce. */
function req(
  method: HandlerRequest['method'],
  path: string,
  opts: {
    query?: Readonly<Record<string, string>>;
    headers?: Readonly<Record<string, string>>;
    body?: JsonValue;
  } = {},
): HandlerRequest {
  return {
    method,
    path,
    query: opts.query ?? {},
    headers: opts.headers ?? {},
    body: opts.body,
    remoteAddr: '127.0.0.1',
  };
}

async function call(handler: Handler, r: HandlerRequest): Promise<HandlerResponse> {
  return handler(r);
}

// ---------- Matrix ----------

for (const backend of BACKENDS) {
  describe(`openapi contract — ${backend.name} backend`, () => {
    // ---------- Client endpoints ----------

    it('GET /health → HealthEnvelope', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        const router = createRouter(clientRoutes(mkClientCtx(storage), '/api/licensing/v1'));
        const res = await call(router, req('GET', '/api/licensing/v1/health'));
        expect(res.status).toBe(200);
        expectEnvelope('HealthEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    it('GET /health → 503 + HealthEnvelope when storage probe fails', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        // Wrap storage so listAudit fails — flips /health into the 503
        // status=error branch. Schema still validates because the enum
        // permits both ok and error.
        const failing = new Proxy(storage, {
          get(target, prop, receiver) {
            if (prop === 'listAudit') {
              return async () => {
                throw new Error('simulated db failure');
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const router = createRouter(
          clientRoutes(mkClientCtx(failing as Storage), '/api/licensing/v1'),
        );
        const res = await call(router, req('GET', '/api/licensing/v1/health'));
        expect(res.status).toBe(503);
        expectEnvelope('HealthEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    it('POST /activate invalid key → ErrorEnvelope (404)', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        const router = createRouter(clientRoutes(mkClientCtx(storage), '/api/licensing/v1'));
        const res = await call(
          router,
          req('POST', '/api/licensing/v1/activate', {
            body: { license_key: 'LIC-NOPE-NOPE-NOPE', fingerprint: 'a'.repeat(64) },
          }),
        );
        expect(res.status).toBe(404);
        expectEnvelope('ErrorEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    it('POST /activate happy path → TokenEnvelope', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        const { license } = await seed(storage);
        const router = createRouter(clientRoutes(mkClientCtx(storage), '/api/licensing/v1'));
        const res = await call(
          router,
          req('POST', '/api/licensing/v1/activate', {
            body: { license_key: license.license_key, fingerprint: 'b'.repeat(64) },
          }),
        );
        expect(res.status).toBe(200);
        expectEnvelope('TokenEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    // ---------- Admin — licenses ----------

    it('GET /admin/licenses → LicenseListEnvelope', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        await seed(storage);
        const router = createRouter(adminRoutes(mkAdminCtx(storage), '/api/licensing/v1'));
        const res = await call(router, req('GET', '/api/licensing/v1/admin/licenses'));
        expect(res.status).toBe(200);
        expectEnvelope('LicenseListEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    it('GET /admin/licenses/:id → LicenseEnvelope', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        const { license } = await seed(storage);
        const router = createRouter(adminRoutes(mkAdminCtx(storage), '/api/licensing/v1'));
        const res = await call(
          router,
          req('GET', `/api/licensing/v1/admin/licenses/${license.id}`),
        );
        expect(res.status).toBe(200);
        expectEnvelope('LicenseEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    it('GET /admin/licenses/:id missing → ErrorEnvelope (404)', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        const router = createRouter(adminRoutes(mkAdminCtx(storage), '/api/licensing/v1'));
        const res = await call(
          router,
          req('GET', '/api/licensing/v1/admin/licenses/01900000-0000-7000-8000-000000000000'),
        );
        expect(res.status).toBe(404);
        expectEnvelope('ErrorEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    it('POST /admin/licenses → LicenseEnvelope (201)', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        const { scope } = await seed(storage);
        const router = createRouter(adminRoutes(mkAdminCtx(storage), '/api/licensing/v1'));
        const res = await call(
          router,
          req('POST', '/api/licensing/v1/admin/licenses', {
            body: {
              scope_id: scope.id,
              licensable_type: 'Team',
              licensable_id: 't-42',
              max_usages: 5,
            },
          }),
        );
        expect(res.status).toBe(201);
        expectEnvelope('LicenseEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    it('POST /admin/licenses/:id/suspend → LicenseEnvelope', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        const { license } = await seed(storage);
        // createLicense → pending; suspend requires an active license so
        // activate it first (registerUsage flips pending→active).
        const { registerUsage } = await import('@anorebel/licensing');
        await registerUsage(storage, CLOCK, {
          license_id: license.id,
          fingerprint: 'c'.repeat(64),
        });
        const router = createRouter(adminRoutes(mkAdminCtx(storage), '/api/licensing/v1'));
        const res = await call(
          router,
          req('POST', `/api/licensing/v1/admin/licenses/${license.id}/suspend`),
        );
        expect(res.status).toBe(200);
        expectEnvelope('LicenseEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    // ---------- Admin — scopes ----------

    it('GET /admin/scopes → ScopeListEnvelope', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        await seed(storage);
        const router = createRouter(adminRoutes(mkAdminCtx(storage), '/api/licensing/v1'));
        const res = await call(router, req('GET', '/api/licensing/v1/admin/scopes'));
        expect(res.status).toBe(200);
        expectEnvelope('ScopeListEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    it('POST /admin/scopes → ScopeEnvelope (201)', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        const router = createRouter(adminRoutes(mkAdminCtx(storage), '/api/licensing/v1'));
        const res = await call(
          router,
          req('POST', '/api/licensing/v1/admin/scopes', {
            body: { slug: 'widget-co', name: 'Widget Co' },
          }),
        );
        expect(res.status).toBe(201);
        expectEnvelope('ScopeEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    it('GET /admin/scopes/:id → ScopeEnvelope', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        const { scope } = await seed(storage);
        const router = createRouter(adminRoutes(mkAdminCtx(storage), '/api/licensing/v1'));
        const res = await call(router, req('GET', `/api/licensing/v1/admin/scopes/${scope.id}`));
        expect(res.status).toBe(200);
        expectEnvelope('ScopeEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    // ---------- Admin — templates ----------

    it('GET /admin/templates → TemplateListEnvelope', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        await seed(storage);
        const router = createRouter(adminRoutes(mkAdminCtx(storage), '/api/licensing/v1'));
        const res = await call(router, req('GET', '/api/licensing/v1/admin/templates'));
        expect(res.status).toBe(200);
        expectEnvelope('TemplateListEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    it('POST /admin/templates → TemplateEnvelope (201)', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        const { scope } = await seed(storage);
        const router = createRouter(adminRoutes(mkAdminCtx(storage), '/api/licensing/v1'));
        const res = await call(
          router,
          req('POST', '/api/licensing/v1/admin/templates', {
            body: {
              scope_id: scope.id,
              name: 'Pro Plan',
              max_usages: 10,
              trial_duration_sec: 0,
              grace_duration_sec: 86400,
              entitlements: { features: ['a', 'b'] },
            },
          }),
        );
        expect(res.status).toBe(201);
        expectEnvelope('TemplateEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    // ---------- Admin — usages ----------

    it('GET /admin/usages → UsageListEnvelope', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        const { license } = await seed(storage);
        const { registerUsage } = await import('@anorebel/licensing');
        await registerUsage(storage, CLOCK, {
          license_id: license.id,
          fingerprint: 'd'.repeat(64),
        });
        const router = createRouter(adminRoutes(mkAdminCtx(storage), '/api/licensing/v1'));
        const res = await call(router, req('GET', '/api/licensing/v1/admin/usages'));
        expect(res.status).toBe(200);
        expectEnvelope('UsageListEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    // ---------- Admin — keys ----------

    it('GET /admin/keys → KeyListEnvelope (private_pem_enc stripped)', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        await seed(storage);
        const router = createRouter(adminRoutes(mkAdminCtx(storage), '/api/licensing/v1'));
        const res = await call(router, req('GET', '/api/licensing/v1/admin/keys'));
        expect(res.status).toBe(200);
        expectEnvelope('KeyListEnvelope', res.body);
        // Explicit guard: no item may leak the encrypted private key.
        const items = (res.body as { data: { items: Array<Record<string, unknown>> } }).data.items;
        for (const item of items) {
          expect(Object.hasOwn(item, 'private_pem_enc')).toBe(false);
        }
      } finally {
        await cleanup();
      }
    });

    it('POST /admin/keys/:id/rotate → RotateKeyEnvelope', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        const { signingKid } = await seed(storage);
        const signing = await storage.getKeyByKid(signingKid);
        if (signing === null) throw new Error('signing key seed failed');
        const router = createRouter(adminRoutes(mkAdminCtx(storage), '/api/licensing/v1'));
        const res = await call(
          router,
          req('POST', `/api/licensing/v1/admin/keys/${signing.id}/rotate`),
        );
        expect(res.status).toBe(200);
        expectEnvelope('RotateKeyEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    // ---------- Admin — audit ----------

    it('GET /admin/audit → AuditListEnvelope', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        await seed(storage);
        const router = createRouter(adminRoutes(mkAdminCtx(storage), '/api/licensing/v1'));
        const res = await call(router, req('GET', '/api/licensing/v1/admin/audit'));
        expect(res.status).toBe(200);
        expectEnvelope('AuditListEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    // ---------- Router-level negative paths ----------

    it('unknown path → ErrorEnvelope (404)', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        const router = createRouter(adminRoutes(mkAdminCtx(storage), '/api/licensing/v1'));
        const res = await call(router, req('GET', '/api/licensing/v1/admin/nope'));
        expect(res.status).toBe(404);
        expectEnvelope('ErrorEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });

    it('wrong method → ErrorEnvelope (405)', async () => {
      const { s: storage, cleanup } = await backend.make();
      try {
        const router = createRouter(adminRoutes(mkAdminCtx(storage), '/api/licensing/v1'));
        const res = await call(router, req('DELETE', '/api/licensing/v1/admin/audit'));
        expect(res.status).toBe(405);
        expectEnvelope('ErrorEnvelope', res.body);
      } finally {
        await cleanup();
      }
    });
  });
}

afterAll(async () => {
  if (pgMaster !== null) {
    await pgMaster.end();
    pgMaster = null;
  }
});
