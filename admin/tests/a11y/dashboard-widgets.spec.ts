import { sampleLicenseStats } from './_fixtures/sample';
import { expect, test } from './fixtures';

/**
 * Dashboard widget specs — load, isolation, polling.
 *
 * The dashboard composes four widgets that each own their own
 * useLicensing call:
 *   - LicenseOverviewWidget   → /admin/stats/licenses
 *   - ExpiringSoonWidget      → /admin/licenses?status=active&limit=100
 *   - RecentActivationsWidget → /admin/audit (polled every 60s)
 *   - SeatUtilizationWidget   → /admin/stats/licenses
 *
 * Failure isolation is the contract: a 500 from one endpoint must NOT
 * blank the others. We exercise that by mocking one endpoint to 500
 * and asserting the surviving widgets still render their headings.
 *
 * Polling is exercised by routing /admin/audit, advancing the page's
 * fake clock by 60s, and asserting a second request landed.
 */

const ACTIVE_LICENSES_FIXTURE = {
  data: {
    items: Array.from({ length: 3 }).map((_, i) => {
      // Build expiry timestamps relative to test runtime so they fall
      // inside the 30d window the widget filters on. The
      // ExpiringSoonWidget's date math runs against the page's real
      // clock, which Playwright leaves untouched by default.
      const daysOut = (i + 1) * 5;
      const expiresAt = new Date(Date.now() + daysOut * 24 * 60 * 60 * 1000).toISOString();
      return {
        id: `018df9f1-0000-7000-8000-00000000010${i}`,
        status: 'active' as const,
        template_id: null,
        max_usages: 10,
        active_usages: i + 1,
        expires_at: expiresAt,
        activated_at: '2026-01-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-04-01T00:00:00Z',
        entitlements: {},
        meta: {},
        license_key: `LIC-EXP${i}-EXP${i}-EXP${i}`,
        scope_id: null,
      };
    }),
    next_cursor: null,
  },
};

const AUDIT_FIXTURE = {
  data: {
    items: [
      {
        id: '018df9f1-0000-7000-8000-000000000200',
        license_id: '018df9f1-0000-7000-8000-000000000101',
        scope_id: null,
        actor: 'admin',
        event: 'license.created',
        prior_state: null,
        new_state: { id: '018df9f1-0000-7000-8000-000000000101' },
        // Recent enough to land in the 24h sparkline.
        occurred_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
      {
        id: '018df9f1-0000-7000-8000-000000000201',
        license_id: '018df9f1-0000-7000-8000-000000000102',
        scope_id: null,
        actor: 'admin',
        event: 'license.activated',
        prior_state: null,
        new_state: null,
        occurred_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
    ],
    next_cursor: null,
  },
};

test.describe('dashboard', () => {
  test('renders all four widgets on load', async ({ authedPage, mockProxy }) => {
    await mockProxy([
      { url: /\/api\/proxy\/admin\/stats\/licenses(\?|$)/, body: sampleLicenseStats },
      { url: /\/api\/proxy\/admin\/licenses\?.*status=active/, body: ACTIVE_LICENSES_FIXTURE },
      { url: /\/api\/proxy\/admin\/audit(\?|$)/, body: AUDIT_FIXTURE },
    ]);

    await authedPage.goto('/');

    // Page heading
    await expect(authedPage.getByRole('heading', { level: 1, name: /dashboard/i })).toBeVisible();

    // Each widget renders its own H2 — these double as failure-isolation
    // anchors for the per-endpoint mocks below.
    await expect(
      authedPage.getByRole('heading', { level: 2, name: /expiring within 30d/i }),
    ).toBeVisible();
    await expect(
      authedPage.getByRole('heading', { level: 2, name: /recent activations/i }),
    ).toBeVisible();
    await expect(
      authedPage.getByRole('heading', { level: 2, name: /seat utilisation/i }),
    ).toBeVisible();

    // License overview tiles — total + active + pending + expiring.
    // The donut + legend render below them; the counts come from the
    // sampleLicenseStats fixture (total = 35).
    await expect(authedPage.getByText('total licenses')).toBeVisible();
    await expect(authedPage.getByText(/35/)).toBeVisible();
  });

  test('a failed stats endpoint isolates failure to overview widget', async ({
    authedPage,
    mockProxy,
  }) => {
    // Stats explicitly returns 500. The expiring + audit endpoints
    // succeed normally — failure isolation means those widgets MUST
    // still render their data.
    await mockProxy([
      {
        url: /\/api\/proxy\/admin\/stats\/licenses(\?|$)/,
        body: { error: { code: 'InternalError', message: 'boom' }, success: false },
        status: 500,
      },
      { url: /\/api\/proxy\/admin\/licenses\?.*status=active/, body: ACTIVE_LICENSES_FIXTURE },
      { url: /\/api\/proxy\/admin\/audit(\?|$)/, body: AUDIT_FIXTURE },
    ]);

    await authedPage.goto('/');

    // Overview shows error state on at least one tile (it shares a
    // single error across the four count tiles).
    await expect(
      authedPage.locator('[role="alert"]').filter({ hasText: /could not load license stats/i }),
    ).toBeVisible();

    // Expiring + Recent Activations widgets still render their headings
    // and content — proves the 500 was contained.
    await expect(
      authedPage.getByRole('heading', { level: 2, name: /expiring within 30d/i }),
    ).toBeVisible();
    await expect(
      authedPage.getByRole('heading', { level: 2, name: /recent activations/i }),
    ).toBeVisible();
    // Confirm the audit feed actually rendered an entry (not a skeleton).
    await expect(authedPage.getByText(/license\.created/i).first()).toBeVisible();
  });

  test('a failed audit endpoint does not blank the other widgets', async ({
    authedPage,
    mockProxy,
  }) => {
    await mockProxy([
      { url: /\/api\/proxy\/admin\/stats\/licenses(\?|$)/, body: sampleLicenseStats },
      { url: /\/api\/proxy\/admin\/licenses\?.*status=active/, body: ACTIVE_LICENSES_FIXTURE },
      {
        url: /\/api\/proxy\/admin\/audit(\?|$)/,
        body: { error: { code: 'InternalError', message: 'boom' }, success: false },
        status: 500,
      },
    ]);

    await authedPage.goto('/');

    // Recent Activations renders an error state (the widget owns its
    // own error message, distinct from the other widgets).
    await expect(
      authedPage.locator('[role="alert"]').filter({ hasText: /could not load activity feed/i }),
    ).toBeVisible();

    // Overview + Expiring + Seats all still render successfully.
    await expect(authedPage.getByText('total licenses')).toBeVisible();
    await expect(
      authedPage.getByRole('heading', { level: 2, name: /expiring within 30d/i }),
    ).toBeVisible();
    await expect(
      authedPage.getByRole('heading', { level: 2, name: /seat utilisation/i }),
    ).toBeVisible();
  });

  test('recent-activations widget polls the audit endpoint every 60s', async ({
    authedPage,
    mockProxy,
    page,
  }) => {
    let auditHits = 0;
    await page.route(/\/api\/proxy\/admin\/audit(\?|$)/, (route) => {
      auditHits++;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(AUDIT_FIXTURE),
      });
    });
    await mockProxy([
      { url: /\/api\/proxy\/admin\/stats\/licenses(\?|$)/, body: sampleLicenseStats },
      { url: /\/api\/proxy\/admin\/licenses\?.*status=active/, body: ACTIVE_LICENSES_FIXTURE },
    ]);

    await authedPage.goto('/');
    await expect(
      authedPage.getByRole('heading', { level: 2, name: /recent activations/i }),
    ).toBeVisible();

    // First fetch on mount should land within a couple of seconds.
    await expect.poll(() => auditHits, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
    const initialHits = auditHits;

    // Advance the page's clock past the 60s polling interval and
    // expect a second fetch. We use Playwright's evaluate hook with
    // setInterval-friendly fake timers: the dashboard's setInterval
    // callback fires when the underlying browser clock advances.
    await authedPage.clock.install();
    await authedPage.clock.fastForward(65_000);
    await expect.poll(() => auditHits, { timeout: 10_000 }).toBeGreaterThan(initialHits);
  });
});
