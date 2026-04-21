import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';

/**
 * Shared Playwright fixtures for the accessibility suite.
 *
 * `authedPage` seals a known admin session via the test-only endpoint at
 * `/api/__test__/seal-session` (gated on ADMIN_A11Y_TEST_MODE=1, set in
 * playwright.config.ts) so specs never touch the sign-in flow. The
 * nuxt-auth-utils cookie is sealed server-side with the config's
 * NUXT_SESSION_PASSWORD, which means we never duplicate iron-webcrypto
 * key derivation in test code.
 *
 * `mockProxy` registers a default 404 for any un-routed upstream call so
 * a missing mock fails loudly rather than triggering the black-hole
 * upstream (see webServer.env.LICENSING_UPSTREAM_BASE_URL).
 *
 * `axeScan` runs axe with the WCAG 2.2 AA tag set and returns the
 * violations array. The `include` / `exclude` options are plumbed
 * through so specs can scope scans when a third-party widget reliably
 * reports a known-ignored rule.
 */

type AxeOptions = {
  include?: string | string[];
  exclude?: string | string[];
  disableRules?: string[];
};

type Fixtures = {
  authedPage: Page;
  mockProxy: (patterns: Array<{ url: RegExp; body: unknown; status?: number }>) => Promise<void>;
  axeScan: (options?: AxeOptions) => Promise<Awaited<ReturnType<AxeBuilder['analyze']>>>;
};

export const test = base.extend<Fixtures>({
  authedPage: async ({ page, baseURL }, use) => {
    // Seal first, then navigate. POST without a prior page load so the
    // request carries no stale cookie.
    const sealed = await page.request.post(`${baseURL}/api/__test__/seal-session`);
    expect(sealed.ok(), 'test session seal endpoint must succeed').toBeTruthy();
    await use(page);
  },

  mockProxy: async ({ page }, use) => {
    async function register(patterns: Array<{ url: RegExp; body: unknown; status?: number }>) {
      for (const p of patterns) {
        await page.route(p.url, (route) => {
          route.fulfill({
            status: p.status ?? 200,
            contentType: 'application/json',
            body: JSON.stringify(p.body),
          });
        });
      }
      // Catch-all: any un-mocked proxy call is a test bug — surface it.
      await page.route('**/api/proxy/**', (route) => {
        const url = route.request().url();
        route.fulfill({
          status: 599,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'UnmockedProxyCall',
              message: `axe spec did not mock ${route.request().method()} ${url}`,
            },
          }),
        });
      });
    }
    await use(register);
  },

  axeScan: async ({ page }, use) => {
    async function scan(options: AxeOptions = {}) {
      let builder = new AxeBuilder({ page }).withTags([
        'wcag2a',
        'wcag2aa',
        'wcag21a',
        'wcag21aa',
        'wcag22aa',
      ]);
      if (options.include) {
        const includes = Array.isArray(options.include) ? options.include : [options.include];
        for (const sel of includes) builder = builder.include(sel);
      }
      if (options.exclude) {
        const excludes = Array.isArray(options.exclude) ? options.exclude : [options.exclude];
        for (const sel of excludes) builder = builder.exclude(sel);
      }
      if (options.disableRules?.length) {
        builder = builder.disableRules(options.disableRules);
      }
      return builder.analyze();
    }
    await use(scan);
  },
});

export { expect };

/**
 * Fail the test with a pretty dump of the violation list so CI logs
 * point to the actual rule + node rather than a bare "1 violation".
 */
export function assertNoViolations(
  results: Awaited<ReturnType<AxeBuilder['analyze']>>,
  label: string,
) {
  if (results.violations.length === 0) return;
  const pretty = results.violations
    .map((v) => {
      const targets = v.nodes
        .map((n) => `    ${Array.isArray(n.target) ? n.target.join(' ') : String(n.target)}`)
        .join('\n');
      return `  [${v.impact ?? '?'}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${targets}`;
    })
    .join('\n\n');
  throw new Error(`axe violations on ${label}:\n${pretty}`);
}
