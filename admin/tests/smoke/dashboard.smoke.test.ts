import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Page } from 'bunwright';
import { browser } from 'bunwright';
import { configureBrowser } from './browser';
import { startStubServer } from './stub-server';

/**
 * Browser smoke checks for the dashboard.
 *
 * The dashboard was the one shipped route with no automated coverage at
 * all — it is absent from the list-view suite's VIEWS. Its defining
 * property is that four widgets over three endpoints each load, fail, and
 * empty *independently*, and nothing verified that a single upstream
 * failure blanked only its own widget.
 *
 * Assertions read rendered DOM. Widgets are addressed by their accessible
 * handles (`aria-label` / heading ids) rather than CSS classes, so a
 * restyle does not break the suite.
 */

const TEST_TIMEOUT = 60_000;

/** Accessible handle → the endpoint that widget depends on. */
const WIDGETS = [
  {
    name: 'License overview',
    sel: 'css:[aria-label="License overview"]',
    endpoint: '/admin/stats/licenses',
  },
  { name: 'Seat utilisation', sel: 'css:#seats-heading', endpoint: '/admin/stats/licenses' },
  { name: 'Expiring soon', sel: 'css:#expiring-heading', endpoint: '/admin/licenses' },
  { name: 'Recent activations', sel: 'css:#activations-heading', endpoint: '/admin/audit' },
] as const;

let stub: ReturnType<typeof startStubServer>;
let appProc: Bun.Subprocess | null = null;
let appUrl = '';
let page: Page;

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

/** Navigates to the dashboard, retrying past a still-settling session. */
async function gotoDashboard(p: Page): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    await p.navigate(`${appUrl}/`, { waitForLoadState: 'networkidle' });
    try {
      await p.waitForSelector('css:[aria-label="License overview"]', { timeout: 10_000 });
      // Widgets resolve their own fetches after hydration; give the slowest
      // a moment so an assertion does not race a pending skeleton.
      await p.waitForTimeout(800);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Visible error text across the page — empty containers do not count. */
async function visibleAlerts(p: Page): Promise<string[]> {
  return p.evaluate(() =>
    Array.from(document.querySelectorAll('[role=alert]'))
      .map((e) => e.textContent?.trim() ?? '')
      .filter((t) => t.length > 0),
  );
}

/**
 * Body text of the widget owning `headingSel`.
 *
 * `evaluate` takes a zero-arg function, so the selector is injected into
 * the page as a variable rather than passed as an argument.
 */
async function widgetText(p: Page, headingSel: string): Promise<string> {
  await p.evaluate(new Function(`window.__sel = ${JSON.stringify(headingSel)};`) as () => void);
  return p.evaluate(() => {
    const sel = (globalThis as unknown as { __sel: string }).__sel;
    const section = document.querySelector(sel)?.closest('section');
    return section?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

beforeAll(async () => {
  stub = startStubServer();

  const port = 3124;
  appUrl = `http://127.0.0.1:${port}`;
  appProc = Bun.spawn(['node', '.output/server/index.mjs'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      ...process.env,
      NITRO_PORT: String(port),
      PORT: String(port),
      NUXT_UPSTREAM_BASE_URL: stub.baseUrl,
      NUXT_SESSION_PASSWORD: 'smoke-test-session-password-at-least-32-chars',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await waitForServer(appUrl);

  configureBrowser();
  page = await browser.newPage();

  await page.navigate(`${appUrl}/sign-in`, { waitForLoadState: 'load' });
  await page.type('css:#token', 'smoke-token');
  await page.click("css:button[type='submit']");
  await page.waitForURL(/\/(?!sign-in)/, { timeout: 30_000 });
}, 180_000);

afterAll(async () => {
  await browser.close().catch(() => {});
  appProc?.kill();
  stub?.stop();
});

test(
  'every dashboard widget renders with no visible error',
  async () => {
    stub.healAll();
    await gotoDashboard(page);
    for (const w of WIDGETS) {
      expect(await page.exists(w.sel)).toBe(true);
    }
    expect(await visibleAlerts(page)).toEqual([]);
  },
  TEST_TIMEOUT,
);

test(
  'a failing endpoint degrades only its own widget',
  async () => {
    // /admin/audit backs exactly one widget (Recent activations), so the
    // other three must survive it. This is the isolation guarantee the
    // <Suspense>-per-widget layout exists to provide, and nothing checked
    // it before.
    //
    // Asserts on widget BODY text, not on heading presence: headings render
    // from static markup whether or not the fetch succeeded, so a
    // heading-only assertion passes even with every endpoint down — which
    // is exactly the vacuous test this replaces.
    stub.failEndpoint('/admin/audit');
    try {
      await gotoDashboard(page);

      // The broken widget says so, in its own body.
      const activations = await widgetText(page, '#activations-heading');
      expect(activations).toContain('Could not load');

      // The widgets on healthy endpoints did NOT inherit the failure.
      for (const sel of ['#seats-heading', '#expiring-heading']) {
        expect(await widgetText(page, sel)).not.toContain('Could not load');
      }

      // Exactly one failure surfaced — not a page-wide error state.
      expect(await visibleAlerts(page)).toEqual(['Could not load activity feed.']);
    } finally {
      stub.healAll();
    }
  },
  TEST_TIMEOUT,
);

test(
  'the dashboard survives a stats outage without losing the page',
  async () => {
    // /admin/stats/licenses backs TWO widgets. A shared-dependency failure
    // must not take down the route itself — the header and the widgets on
    // other endpoints stay put.
    stub.failEndpoint('/admin/stats/licenses');
    try {
      await page.navigate(`${appUrl}/`, { waitForLoadState: 'networkidle' });
      await page.waitForTimeout(1200);

      // The page still rendered: its heading is present.
      const heading = await page.evaluate(
        () => document.querySelector('h1')?.textContent?.trim() ?? '',
      );
      expect(heading).toContain('Dashboard');

      // The widget on an unaffected endpoint still loaded its DATA — not
      // merely its heading.
      expect(await widgetText(page, '#activations-heading')).not.toContain('Could not load');
    } finally {
      stub.healAll();
    }
  },
  TEST_TIMEOUT,
);
