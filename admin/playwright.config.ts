import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright is used here only as an axe-core driver — no E2E assertions
 * live in these specs, they're pure accessibility scans of the five
 * primary admin flows.
 *
 * The dev server is stubbed: `LICENSING_UPSTREAM_BASE_URL` points at a
 * black-hole port so any un-mocked `/api/proxy/*` call fails loudly
 * during a test instead of silently hitting a real backend. Each spec
 * registers `page.route` mocks for the exact payloads it needs, and the
 * `authedPage` fixture pre-seals a session cookie so the middleware
 * lets us into the authed shell without hitting the sign-in flow.
 *
 * One retry on CI covers the rare flake where Nuxt's on-demand compile
 * races a navigation; locally we fail immediately so new failures are
 * obvious.
 */
export default defineConfig({
  testDir: './tests/a11y',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Mirror the production color-scheme default so contrast-sensitive
    // axe rules test the same palette operators actually use.
    colorScheme: 'light',
  },

  projects: [
    {
      name: 'chromium-light',
      use: { ...devices['Desktop Chrome'], colorScheme: 'light' },
    },
    {
      name: 'chromium-dark',
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark' },
    },
  ],

  webServer: {
    // `nuxt dev` with an unreachable upstream. Every test intercepts the
    // proxy routes it cares about; anything that slips through 500s.
    command: 'bun run dev',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NUXT_PORT: '3100',
      HOST: '127.0.0.1',
      // Unreachable on purpose — forces tests to mock explicitly.
      LICENSING_UPSTREAM_BASE_URL: 'http://127.0.0.1:59/__axe_black_hole__',
      // Stable session password so `tests/a11y/fixtures.ts` can seal a
      // cookie that the server will unseal.
      NUXT_SESSION_PASSWORD: 'axe_only_deterministic_password_for_a11y_tests_32bytes',
      // Unlocks server/api/__test__/seal-session.post.ts. Any non-'1'
      // value 404s the endpoint, so this is inert outside CI / axe runs.
      ADMIN_A11Y_TEST_MODE: '1',
    },
  },
});
