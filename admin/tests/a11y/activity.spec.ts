import { sampleAuditEntry } from './_fixtures/sample';
import { expect, test } from './fixtures';

/**
 * Activity page specs — the chip-row event filter must drive the URL +
 * the upstream query. The DataTable handles its own pagination + free
 * text search via the toolbar; we only need to verify the chip layer
 * here.
 */

const AUDIT_ROUTE = /\/api\/proxy\/admin\/audit(\?|$)/;

const CREATED = {
  ...sampleAuditEntry,
  id: '018df9f1-0000-7000-8000-000000000d01',
  event: 'license.created',
};
const SUSPENDED = {
  ...sampleAuditEntry,
  id: '018df9f1-0000-7000-8000-000000000d02',
  event: 'license.suspended',
};

test.describe('activity page', () => {
  test('clicking a chip filters the event query', async ({ authedPage, mockProxy, page }) => {
    const queries: string[] = [];
    await page.route(AUDIT_ROUTE, (route) => {
      queries.push(new URL(route.request().url()).search);
      // Return only the matching event when the upstream query asks
      // for one — mirrors the real backend semantics.
      const url = new URL(route.request().url());
      const ev = url.searchParams.get('event');
      const items =
        ev === 'license.created'
          ? [CREATED]
          : ev === 'license.suspended'
            ? [SUSPENDED]
            : [CREATED, SUSPENDED];
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { items, next_cursor: null } }),
      });
    });
    await mockProxy([]);

    await authedPage.goto('/activity');
    await expect(authedPage.getByRole('heading', { level: 1, name: /activity/i })).toBeVisible();

    // Initial load: "all" chip is pressed, both events render.
    await expect(authedPage.getByRole('button', { name: /^all$/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(authedPage.getByText('license.created')).toBeVisible();
    await expect(authedPage.getByText('license.suspended')).toBeVisible();

    // Click the "suspended" chip — it should toggle aria-pressed and
    // narrow the upstream call to event=license.suspended.
    await authedPage.getByRole('button', { name: /^suspended$/i }).click();
    await expect(authedPage.getByRole('button', { name: /^suspended$/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect.poll(() => queries.some((q) => q.includes('event=license.suspended'))).toBe(true);
    await expect(authedPage.getByText('license.suspended')).toBeVisible();
  });
});
