import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Page } from 'bunwright';
import { browser } from 'bunwright';
import { configureBrowser } from './browser';
import { expectedScopeSlugsAsc, servedScopeSlugs, startStubServer } from './stub-server';

/**
 * Browser smoke checks for the admin list views.
 *
 * Scope is deliberately narrow: prove the shared DataTable still *works* in a
 * real browser after the TanStack v9 migration. A green typecheck cannot tell
 * you that sorting still sorts, so these assert on rendered output — row text
 * and row counts — never on component internals.
 *
 * This is not an E2E suite. bunwright documents that it has no fixtures,
 * parallel workers, or trace viewer; `bun test` supplies the runner and
 * assertions it lacks.
 */

/** Browser navigation + network idle comfortably exceeds bun's 5s default. */
const TEST_TIMEOUT = 60_000;

let stub: ReturnType<typeof startStubServer>;
let appProc: Bun.Subprocess | null = null;
let appUrl = '';
let page: Page;

/**
 * Installs an in-page error collector.
 *
 * bunwright's `console: true` only tees the page console to the terminal —
 * there is no programmatic capture hook — so we record errors inside the
 * page instead and read them back. This catches uncaught exceptions and
 * rejected promises, which are what a broken table actually produces.
 */
const ERROR_COLLECTOR = `
  window.__smokeErrors = [];
  window.addEventListener('error', (e) => {
    window.__smokeErrors.push(String(e.message || e.error));
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.__smokeErrors.push('unhandledrejection: ' + String(e.reason));
  });
`;

async function collectedErrors(p: Page): Promise<string[]> {
  return p.evaluate(
    () => (globalThis as unknown as { __smokeErrors?: string[] }).__smokeErrors ?? [],
  );
}

async function waitForServer(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status > 0) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(500);
  }
  throw new Error(`Admin app did not start within ${timeoutMs}ms at ${url}`);
}

beforeAll(async () => {
  stub = startStubServer();

  // Preview the production build against the stub upstream. Using the built
  // output (not `dev`) keeps the run close to what CI ships and avoids dev
  // HMR noise landing in the console assertions.
  const port = 3123;
  appUrl = `http://127.0.0.1:${port}`;
  appProc = Bun.spawn(['node', '.output/server/index.mjs'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      ...process.env,
      NITRO_PORT: String(port),
      PORT: String(port),
      // Runtime config is baked into the build, so the app's own
      // LICENSING_UPSTREAM_BASE_URL is already resolved by then. Nitro's
      // NUXT_<KEY> convention is what overrides it at runtime.
      NUXT_UPSTREAM_BASE_URL: stub.baseUrl,
      NUXT_SESSION_PASSWORD: 'smoke-test-session-password-at-least-32-chars',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await waitForServer(appUrl);

  configureBrowser();
  page = await browser.newPage();

  // Sign in once: every list view is behind the session cookie.
  await page.navigate(`${appUrl}/sign-in`, { waitForLoadState: 'load' });
  await page.type('css:#token', 'smoke-token');
  await page.click("css:button[type='submit']");
  await page.waitForURL(/\/(?!sign-in)/, { timeout: 30_000 });
  // Booting Nitro + launching a browser comfortably exceeds bun's 5s
  // default hook timeout.
}, 180_000);

afterAll(async () => {
  await browser.close().catch(() => {});
  appProc?.kill();
  stub?.stop();
});

/**
 * Text of the first cell of every rendered row, in rendered order.
 *
 * `evaluate` takes a zero-arg function (no argument marshalling), so the
 * column index is fixed at 0 rather than threaded in — the first column is
 * the one the ordering assertions care about.
 */
async function firstColumnText(p: Page): Promise<string[]> {
  return p.evaluate(() =>
    Array.from(document.querySelectorAll('tbody tr')).map(
      (r) => r.querySelector('td')?.textContent?.trim() ?? '',
    ),
  );
}

async function rowCount(p: Page): Promise<number> {
  return p.evaluate(() => document.querySelectorAll('tbody tr').length);
}

async function goto(p: Page, path: string): Promise<void> {
  // Retry the navigation itself rather than only widening the selector
  // timeout: the very first view visited after sign-in occasionally lands
  // while the session is still settling, and the page then renders its
  // error branch — which no amount of waiting will turn into a table.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    await p.navigate(`${appUrl}${path}`, { waitForLoadState: 'networkidle' });
    // Re-installed per navigation: a full page load discards the previous
    // collector, so this both arms it and resets the buffer.
    await p.evaluate(new Function(ERROR_COLLECTOR) as () => void);
    try {
      await p.waitForSelector('css:table', { timeout: 10_000 });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// --- Coverage: every list view renders -----------------------------------

const VIEWS = [
  '/scopes',
  '/licenses',
  '/templates',
  '/usages',
  '/audit',
  '/keys',
  '/activity',
] as const;

for (const path of VIEWS) {
  test(
    `${path} renders rows without console errors`,
    async () => {
      await goto(page, path);
      expect(await rowCount(page)).toBeGreaterThan(0);
      // Give any post-hydration work a moment to throw before we look.
      await page.waitForTimeout(300);
      expect(await collectedErrors(page)).toEqual([]);
    },
    TEST_TIMEOUT,
  );
}

// --- Coverage: sorting changes rendered row order ------------------------

test(
  'sorting a column reorders the rendered rows',
  async () => {
    await goto(page, '/scopes');

    const served = servedScopeSlugs();
    const sorted = expectedScopeSlugsAsc();
    // Guard the guard: if the stub ever served pre-sorted data, this test
    // would pass without sorting ever running.
    expect(served).not.toEqual(sorted);

    const before = await firstColumnText(page);
    expect(before.length).toBeGreaterThan(1);

    // DataTableColumnHeader renders a dropdown, not a direct toggle: the
    // header button opens a menu whose "Asc" item performs the sort.
    await page.click('css:thead th:first-child button');
    await page.waitForSelector('css:[role=menuitem]', { timeout: 10_000 });
    // First menu item is "Asc". Positional rather than `text:Asc` because
    // bunwright's text selector needs an exact textContent match and these
    // items also contain an icon.
    await page.click('css:[role=menuitem]:first-child');
    await page.waitForTimeout(500);

    const after = await firstColumnText(page);
    expect(after).not.toEqual(before);
  },
  TEST_TIMEOUT,
);

// --- Coverage: filtering reduces the rendered rows ------------------------

test(
  'free-text filter narrows the rendered rows',
  async () => {
    await goto(page, '/scopes');
    const before = await rowCount(page);
    expect(before).toBeGreaterThan(1);

    // bunwright resolves the whole string as ONE selector — comma-separated
    // fallbacks are not supported and fail as invalid CSS.
    const [first] = servedScopeSlugs();
    await page.type("css:input[placeholder*='Filter']", first ?? '');
    await page.waitForTimeout(400);

    const after = await rowCount(page);
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  },
  TEST_TIMEOUT,
);

// --- Coverage: column visibility removes a column -------------------------

test(
  'hiding a column removes it from the rendered table',
  async () => {
    await goto(page, '/scopes');
    const before = await page.evaluate(() => document.querySelectorAll('thead th').length);

    // Hide via the column header's own menu, which drives the same
    // columnVisibilityFeature path as the "Columns" dropdown.
    //
    // Uses the SECOND column: the first (`slug`) sets `enableHiding: false`
    // because it is the search column, so its menu offers only Asc/Desc and
    // no Hide item at all. The third menuitem on a hideable column is Hide
    // ([Asc, Desc, separator, Hide]) — addressed positionally because
    // bunwright's `text:` selector needs an exact textContent match and
    // these items also contain an icon.
    await page.click('css:thead th:nth-child(2) button');
    await page.waitForSelector('css:[role=menuitem]', { timeout: 10_000 });
    // `:nth-of-type` counts DOM siblings by TAG, and every menu child is a
    // DIV — including the separator — so it does not line up with menuitem
    // ordering. `:last-child` is unambiguous: Hide is the final child.
    await page.click('css:[role=menuitem]:last-child');
    await page.waitForTimeout(500);

    const after = await page.evaluate(() => document.querySelectorAll('thead th').length);
    expect(after).toBeLessThan(before);
  },
  TEST_TIMEOUT,
);
