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
