import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Page } from 'bunwright';
import { browser } from 'bunwright';
import { configureBrowser } from './browser';
import { listResponseFor } from './openapi-fixtures';
import { startStubServer } from './stub-server';

/**
 * Browser smoke checks for the license drill-down sections.
 *
 * The owner and template cards are defined by how they DEGRADE: an
 * unconfigured owner resolver, an ad-hoc license with no template, and a
 * failing upstream all have to produce a readable notice rather than an
 * error page or a blank panel. Nothing asserted any of that.
 *
 * Assertions read section body text, not heading presence — headings render
 * from static markup whether or not the fetch resolved.
 */

const TEST_TIMEOUT = 60_000;

let stub: ReturnType<typeof startStubServer>;
let appProc: Bun.Subprocess | null = null;
let appUrl = '';
let page: Page;

const licenseId = (
  listResponseFor('/admin/licenses', 3) as { data: { items: Array<{ id: string }> } }
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

/** Body text of the section owning `headingSel`. */
async function sectionText(p: Page, headingSel: string): Promise<string> {
  await p.evaluate(new Function(`window.__sel = ${JSON.stringify(headingSel)};`) as () => void);
  return p.evaluate(() => {
    const sel = (globalThis as unknown as { __sel: string }).__sel;
    const section = document.querySelector(sel)?.closest('section');
    return section?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  });
}

async function gotoLicense(p: Page): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    await p.navigate(`${appUrl}/licenses/${licenseId}`, { waitForLoadState: 'networkidle' });
    try {
      await p.waitForSelector('css:#owner-card-heading', { timeout: 10_000 });
      await p.waitForTimeout(800);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

beforeAll(async () => {
  stub = startStubServer();
  const port = 3125;
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
  'owner card degrades to a notice when no resolver is configured',
  async () => {
    // The default state for most deployments: the consumer never wired up
    // GET /owners/{type}/{id}. That must read as "not configured", not as
    // a failure and not as a blank panel.
    stub.resolveOwners(false);
    await gotoLicense(page);
    const owner = await sectionText(page, '#owner-card-heading');
    expect(owner.length).toBeGreaterThan(0);
    expect(owner).toMatch(/owners\/|not configured|configure/i);
  },
  TEST_TIMEOUT,
);

test(
  'owner card shows the resolved owner once the resolver answers',
  async () => {
    stub.resolveOwners(true);
    try {
      await gotoLicense(page);
      const owner = await sectionText(page, '#owner-card-heading');
      // The stub names owners "Owner <id>", so the resolved name proves the
      // response was rendered rather than a placeholder.
      expect(owner).toContain('Owner ');
    } finally {
      stub.resolveOwners(false);
    }
  },
  TEST_TIMEOUT,
);

test(
  'template card names the ad-hoc case when the license has no template',
  async () => {
    // The generated fixture leaves template_id unset, so this is the
    // "no template" branch — it must say so rather than render an empty card.
    await gotoLicense(page);
    const tpl = await sectionText(page, '#template-card-heading');
    expect(tpl.length).toBeGreaterThan(0);
    expect(tpl).toMatch(/ad-hoc|no template/i);
  },
  TEST_TIMEOUT,
);

test(
  'audit timeline renders entries for the license',
  async () => {
    await gotoLicense(page);
    const timeline = await sectionText(page, '#audit-timeline-heading');
    expect(timeline.length).toBeGreaterThan(0);
    expect(timeline).not.toMatch(/could not load/i);
  },
  TEST_TIMEOUT,
);

test(
  'a failing audit endpoint degrades only the timeline',
  async () => {
    stub.failEndpoint('/admin/audit');
    try {
      await gotoLicense(page);
      // The owner and template cards do not read from /admin/audit, so
      // they must survive its failure — the isolation guarantee.
      expect(await sectionText(page, '#owner-card-heading')).not.toMatch(/could not load/i);
      expect(await sectionText(page, '#template-card-heading')).not.toMatch(/could not load/i);
    } finally {
      stub.healAll();
    }
  },
  TEST_TIMEOUT,
);
