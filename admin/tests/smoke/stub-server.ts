import { listResponseFor, objectResponseFor } from './openapi-fixtures';

/**
 * Stub of the licensing admin API, with every payload generated from
 * `openapi/licensing-admin.yaml` (see `openapi-fixtures.ts`).
 *
 * Why a stub at all: both ports ship as *libraries* — there is no server
 * binary in this repo to run — so "use the real backend" would mean
 * inventing one just to support a smoke test. More importantly, the checks
 * assert that sorting *changed* row order and that a facet filter *reduced*
 * the row count; those need a fixed dataset, which live data cannot give.
 *
 * Why generated rather than hand-written: a hand-written stub is a second
 * copy of the contract that drifts silently. Generating from the spec means
 * a newly-required property shows up here automatically.
 *
 * Only the upstream is swapped. The smoke run still exercises the real Nuxt
 * app, the real `/api/proxy/*` layer and session cookie, and the real
 * generated client — the same boundary the Go tests swap when they use
 * in-memory storage instead of Postgres. Contract drift against a real
 * backend is covered by the `openapi-contract` and `interop` CI jobs.
 */

/** Row counts per endpoint. Small, but >1 so ordering is observable. */
const ROWS = 3;

const LIST_PATHS = [
  '/admin/scopes',
  '/admin/licenses',
  '/admin/templates',
  '/admin/usages',
  '/admin/audit',
  '/admin/keys',
] as const;

/**
 * Expected slug order after sorting the scopes column ascending. Derived
 * from the generated payload rather than hardcoded, so it cannot disagree
 * with what the stub actually serves.
 */
export function expectedScopeSlugsAsc(): string[] {
  const res = listResponseFor('/admin/scopes', ROWS) as {
    data: { items: Array<{ slug: string }> };
  };
  return res.data.items.map((i) => i.slug).sort();
}

/** The slug order as served — deliberately compared against the sorted one. */
export function servedScopeSlugs(): string[] {
  const res = listResponseFor('/admin/scopes', ROWS) as {
    data: { items: Array<{ slug: string }> };
  };
  return res.data.items.map((i) => i.slug);
}

/** Distinct license statuses in the served page, for facet assertions. */
export function servedLicenseStatuses(): string[] {
  const res = listResponseFor('/admin/licenses', ROWS) as {
    data: { items: Array<{ status: string }> };
  };
  return res.data.items.map((i) => i.status);
}

export function startStubServer() {
  /**
   * Endpoint suffixes forced to 500, mutable at runtime.
   *
   * The dashboard composes four widgets over three endpoints, and each is
   * supposed to fail independently. Proving that needs one endpoint broken
   * while the others stay healthy — so failure is a property of the running
   * stub, not a separate server the test has to stand up.
   */
  const failing = new Set<string>();

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);

      for (const suffix of failing) {
        if (pathname.endsWith(suffix)) {
          return Response.json(
            { success: false, error: { code: 'Internal', message: 'simulated upstream failure' } },
            { status: 500 },
          );
        }
      }

      // Any bearer is accepted: this stub makes the UI deterministic, it is
      // not a place to re-test auth (which has its own coverage upstream).
      for (const p of LIST_PATHS) {
        if (pathname.endsWith(p)) return Response.json(listResponseFor(p, ROWS));
      }

      if (pathname.endsWith('/admin/stats/licenses')) {
        return Response.json(objectResponseFor('/admin/stats/licenses'));
      }

      return Response.json(
        { success: false, error: { code: 'NotFound', message: `no stub for ${pathname}` } },
        { status: 404 },
      );
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/api/licensing/v1`,
    /** Force every request whose path ends with `suffix` to 500. */
    failEndpoint: (suffix: string) => failing.add(suffix),
    /** Clear all forced failures. */
    healAll: () => failing.clear(),
    stop: () => server.stop(true),
  };
}
