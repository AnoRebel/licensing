import { existsSync } from 'node:fs';
import { browser } from 'bunwright';

/**
 * Resolves the Chromium-family browser the smoke checks drive.
 *
 * Deliberately never downloads a browser: contributors already have one, CI
 * images vary, and a silent download turns a 2-second suite into a 200MB
 * one. `BUN_CHROME_PATH` is the documented override; the fallbacks are the
 * usual Linux install locations.
 */
const CANDIDATES = [
  '/usr/bin/helium-browser',
  '/usr/bin/brave',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];

export function resolveBrowserPath(): string {
  const fromEnv = process.env.BUN_CHROME_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(
        `BUN_CHROME_PATH is set to "${fromEnv}" but no file exists there.\n` +
          'Point it at a Chromium-family browser binary, or unset it to fall back to ' +
          `the usual locations (${CANDIDATES.join(', ')}).`,
      );
    }
    return fromEnv;
  }

  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    // Fail loudly and actionably: without this, bunwright's own failure is a
    // spawn error that reads like a broken test rather than a missing
    // dependency.
    throw new Error(
      'No Chromium-family browser found for the smoke checks.\n' +
        'Set BUN_CHROME_PATH to your browser binary, e.g.\n' +
        '  BUN_CHROME_PATH=/usr/bin/brave bun run test:smoke\n' +
        `Looked in: ${CANDIDATES.join(', ')}`,
    );
  }
  return found;
}

/** Configures bunwright once per suite. Headless so CI needs no display. */
export function configureBrowser(): void {
  browser.config({
    backend: { type: 'chrome', path: resolveBrowserPath() },
    headless: true,
    width: 1280,
    height: 900,
    console: true,
  });
}

type Page = Awaited<ReturnType<typeof browser.newPage>>;

/**
 * Signs in through the real form and waits until the app has left /sign-in.
 *
 * Waits for the token field's input listener first. Typing into SSR markup
 * before hydration is lost: the form state stays empty, so submit does
 * nothing. `#__nuxt.__vue_app__` is not enough — it is set when the root
 * mounts, while the page's async setup can still be pending under
 * <Suspense>. Vue keeps an element's bound listeners under `Symbol('_vei')`.
 */
export async function signIn(page: Page, appUrl: string): Promise<void> {
  await page.navigate(`${appUrl}/sign-in`, { waitForLoadState: 'load' });
  const deadline = Date.now() + 30_000;
  while (
    !(await page.evaluate(() => {
      const el = document.querySelector('#token');
      if (!el) return false;
      const key = Object.getOwnPropertySymbols(el).find((k) => k.description === '_vei');
      return Boolean(key && (el as unknown as Record<symbol, { onInput?: unknown }>)[key]?.onInput);
    }))
  ) {
    if (Date.now() > deadline) throw new Error('sign-in form never hydrated');
    await Bun.sleep(100);
  }
  // Even with the listener bound, the typed text is occasionally lost (the
  // field comes back empty and fails validation), so retype and resubmit
  // whenever the field is empty and we have not left /sign-in yet.
  const onSignIn = async () => (await page.evaluate(() => location.pathname)) === '/sign-in';
  const tokenEmpty = () =>
    page.evaluate(() => !(document.querySelector('#token') as HTMLTextAreaElement | null)?.value);
  // Read the pathname in-page: sign-in redirects with a client-side
  // navigation, which bunwright's tracked URL (and so `waitForURL`) misses.
  const left = Date.now() + 30_000;
  let nextSubmit = 0;
  while (await onSignIn()) {
    if (Date.now() >= nextSubmit) {
      if (await tokenEmpty()) await page.type('css:#token', 'smoke-token');
      await page.click("css:button[type='submit']");
      nextSubmit = Date.now() + 5_000;
    }
    if (Date.now() > left) {
      const state = await page.evaluate(() =>
        JSON.stringify({
          token: (document.querySelector('#token') as HTMLTextAreaElement | null)?.value,
          alerts: Array.from(document.querySelectorAll('[role=alert]')).map((e) =>
            e.textContent?.trim(),
          ),
        }),
      );
      throw new Error(`still on /sign-in 30s after submitting the token: ${state}`);
    }
    await Bun.sleep(100);
  }
}

/**
 * Waits until no element on the page is `aria-busy`. Widgets and cards
 * fetch after hydration behind an aria-busy skeleton; a fixed sleep races
 * that and reads the skeleton.
 */
export async function waitForSettled(page: Page, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await page.evaluate(() => document.querySelector('[aria-busy="true"]') !== null)) {
    if (Date.now() > deadline) throw new Error(`page still aria-busy after ${timeoutMs}ms`);
    await Bun.sleep(100);
  }
}
