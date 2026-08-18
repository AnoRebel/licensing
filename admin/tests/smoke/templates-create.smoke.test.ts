import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Page } from 'bunwright';
import { browser } from 'bunwright';
import { configureBrowser } from './browser';
import { listResponseFor } from './openapi-fixtures';
import { startStubServer } from './stub-server';

/**
 * Browser smoke checks for the templates create dialog and the
 * issue-from-template prefill.
 *
 * `/templates` previously got only the generic renders-rows pass. The
 * dialog is where the interesting behaviour lives: a parent picker that
 * feeds template inheritance, a server-side cycle rejection the UI has to
 * surface rather than swallow, and a prefill summary that has to show the
 * defaults an operator is accepting.
 */

const TEST_TIMEOUT = 60_000;

let stub: ReturnType<typeof startStubServer>;
let appProc: Bun.Subprocess | null = null;
let appUrl = '';
let page: Page;

const templateId = (
  listResponseFor('/admin/templates', 3) as { data: { items: Array<{ id: string }> } }
).data.items[0]?.id as string;

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
      await p.waitForTimeout(700);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Clicks the first button whose text matches. */
async function clickByText(p: Page, pattern: string): Promise<void> {
  await p.evaluate(new Function(`window.__pat = ${JSON.stringify(pattern)};`) as () => void);
  await p.evaluate(() => {
    const pat = new RegExp((globalThis as unknown as { __pat: string }).__pat, 'i');
    const b = Array.from(document.querySelectorAll('button')).find((x) =>
      pat.test(x.textContent ?? ''),
    );
    (b as HTMLButtonElement | undefined)?.click();
  });
}

beforeAll(async () => {
  stub = startStubServer();
  const port = 3127;
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
  'the create dialog opens with a parent picker',
  async () => {
    await goto(page, '/templates', 'css:table');
    await clickByText(page, 'New template');
    await page.waitForSelector('css:[role=dialog]', { timeout: 10_000 });
    await page.waitForTimeout(500);

    const dialog = await page.evaluate(
      () => document.querySelector('[role=dialog]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    );
    // The parent field is what makes template inheritance reachable at all.
    expect(dialog).toMatch(/parent/i);
    // And the numeric policy defaults the template will carry.
    expect(dialog).toMatch(/max_usages/i);
  },
  TEST_TIMEOUT,
);

test(
  'a server-side cycle rejection surfaces to the operator',
  async () => {
    // A template cannot be its own ancestor; the check is server-side, so
    // the UI's only job is to show the upstream message rather than
    // swallow it into a generic failure.
    await goto(page, '/templates', 'css:table');
    stub.rejectNextPost('TemplateCycle', 'Template parent would create a cycle');

    await clickByText(page, 'New template');
    await page.waitForSelector('css:[role=dialog]', { timeout: 10_000 });

    // scope_id is a required UUID, so a name alone is rejected by client
    // validation and never reaches the server. Fill the scope select first
    // — otherwise this would assert the client guard, not the 409 path.
    await page.evaluate(() => {
      const sel = document.querySelector('[role=dialog] select') as HTMLSelectElement | null;
      if (sel && sel.options.length > 1) {
        sel.selectedIndex = 1;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    // Addressed by placeholder: the Input renders without an explicit
    // type attribute, so `input[type='text']` matches nothing.
    await page.type("css:[role=dialog] input[placeholder='Pro Yearly']", 'Cycle Test');
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('[role=dialog] button')).find(
        (x) => (x.textContent ?? '').trim() === 'Create template',
      );
      (b as HTMLButtonElement | undefined)?.click();
    });
    await page.waitForTimeout(1800);

    // Assert on the toast, not document.body: the SSR payload inlines
    // source comments (one says "submit lifecycle"), so a whole-body
    // /cycle/i match passes even with no rejection queued — verified by
    // removing the 409 and watching this still pass.
    const toast = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-sonner-toast], [role=status], [role=alert]'))
        .map((e) => e.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        .join(' | '),
    );
    expect(toast).toMatch(/cycle/i);
  },
  TEST_TIMEOUT,
);

test(
  'issue-from-template shows the defaults being accepted',
  async () => {
    await goto(page, `/templates/${templateId}`, 'css:h1');
    await clickByText(page, 'Issue license');
    await page.waitForSelector('css:[role=dialog] dl', { timeout: 10_000 });
    await page.waitForTimeout(400);

    const summary = await page.evaluate(
      () =>
        document.querySelector('[role=dialog] dl')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    );
    // Values, not prose: the operator sees what copies onto the license.
    for (const field of [
      'max_usages',
      'trial_duration_sec',
      'grace_duration_sec',
      'entitlements',
    ]) {
      expect(summary).toContain(field);
    }
    // At least one real number is rendered, not just labels.
    expect(summary).toMatch(/\d/);
  },
  TEST_TIMEOUT,
);
