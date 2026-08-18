import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Page } from 'bunwright';
import { browser } from 'bunwright';
import { configureBrowser } from './browser';
import { startStubServer } from './stub-server';

/**
 * Browser smoke checks for the activity filter chips and the licenses
 * bulk-action menu.
 *
 * Both are stateful in ways a render check cannot see: chips write to the
 * URL and mark themselves pressed, and the bulk menu only exists once rows
 * are selected. `/activity` was in the list-view suite for the render pass
 * only, and bulk actions had no coverage at all.
 */

const TEST_TIMEOUT = 60_000;

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

async function goto(p: Page, path: string, ready: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    await p.navigate(`${appUrl}${path}`, { waitForLoadState: 'networkidle' });
    try {
      await p.waitForSelector(ready, { timeout: 10_000 });
      await p.waitForTimeout(600);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

beforeAll(async () => {
  stub = startStubServer();
  const port = 3126;
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
  'activity chips render with exactly one pressed by default',
  async () => {
    await goto(page, '/activity', 'css:[aria-label="Event filter"]');
    const pressed = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[aria-label="Event filter"] button'))
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.textContent?.trim() ?? ''),
    );
    // "all" is the default; anything else means the URL and the chip state
    // disagree on first load.
    expect(pressed).toEqual(['all']);
  },
  TEST_TIMEOUT,
);

test(
  'selecting a chip moves the pressed state and writes the URL',
  async () => {
    await goto(page, '/activity', 'css:[aria-label="Event filter"]');
    // Click the second chip (the first non-"all" filter).
    await page.click('css:[aria-label="Event filter"] button:nth-of-type(2)');
    await page.waitForTimeout(700);

    const after = await page.evaluate(() => ({
      pressed: Array.from(document.querySelectorAll('[aria-label="Event filter"] button'))
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.textContent?.trim() ?? ''),
      search: location.search,
    }));

    // Exactly one chip stays pressed, and it is no longer "all".
    expect(after.pressed).toHaveLength(1);
    expect(after.pressed[0]).not.toBe('all');
    // The filter is reflected in the URL so the view is shareable.
    expect(after.search).toContain('event=');
  },
  TEST_TIMEOUT,
);

test(
  'the bulk menu appears only once rows are selected',
  async () => {
    await goto(page, '/licenses', 'css:table');

    const bulkVisible = async () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('button')).some((b) =>
          /bulk/i.test(b.textContent ?? ''),
        ),
      );

    // Nothing selected — the menu must not be offered.
    expect(await bulkVisible()).toBe(false);

    // Select the first row via its checkbox column.
    await page.click('css:tbody tr:first-child [role=checkbox]');
    await page.waitForTimeout(600);

    expect(await bulkVisible()).toBe(true);
  },
  TEST_TIMEOUT,
);

test(
  'the bulk confirmation names how many rows it will affect',
  async () => {
    await goto(page, '/licenses', 'css:table');
    await page.click('css:tbody tr:first-child [role=checkbox]');
    await page.waitForTimeout(600);

    // Open the BULK menu specifically. The page has several
    // aria-haspopup=menu buttons (column headers, view options), so a
    // positional selector picks the wrong one.
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) =>
        /bulk actions/i.test(x.textContent ?? ''),
      );
      (b as HTMLButtonElement | undefined)?.click();
    });
    await page.waitForSelector('css:[role=menuitem]', { timeout: 10_000 });
    await page.click('css:[role=menuitem]:first-child');
    await page.waitForTimeout(900);

    // The dialog must state the affected count rather than a bare "are you
    // sure" — a bulk action that does not say how much it touches is the
    // one worth being scared of.
    // The destructive confirm is an alertdialog, not a dialog.
    const dialog = await page.evaluate(
      () =>
        document.querySelector('[role=alertdialog]')?.textContent?.replace(/\s+/g, ' ').trim() ??
        '',
    );
    expect(dialog).toContain('1 license');
    // A type-to-confirm phrase that embeds the count, so the operator
    // cannot muscle-memory their way through a larger blast radius than
    // they intended.
    expect(dialog).toMatch(/type revoke 1/i);
  },
  TEST_TIMEOUT,
);
