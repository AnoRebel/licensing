import { sampleLicense, sampleScope, sampleTemplate } from './_fixtures/sample';
import { expect, test } from './fixtures';

/**
 * Licenses index — bulk-actions specs.
 *
 * Covers the spec's behavioural requirements for §13:
 *   1. Selecting rows shows the bulk-actions trigger and surfaces the
 *      affected count.
 *   2. Bulk revoke fans out POSTs to each selected row's
 *      /admin/licenses/{id}/revoke endpoint, with the count appearing
 *      in the confirmation copy.
 *   3. Mixed-status selection — choosing a row that's already revoked
 *      alongside a healthy row partitions the set so only the healthy
 *      row is POSTed; the dialog narrates "X of Y will be acted on".
 */

const ACTIVE = {
  ...sampleLicense,
  id: '018df9f1-0000-7000-8000-000000000c01',
  status: 'active' as const,
  license_key: 'LIC-AAAA-AAAA-AAAA',
};
const ALSO_ACTIVE = {
  ...sampleLicense,
  id: '018df9f1-0000-7000-8000-000000000c02',
  status: 'active' as const,
  license_key: 'LIC-BBBB-BBBB-BBBB',
};
const ALREADY_REVOKED = {
  ...sampleLicense,
  id: '018df9f1-0000-7000-8000-000000000c03',
  status: 'revoked' as const,
  license_key: 'LIC-CCCC-CCCC-CCCC',
};

const LIST_ROUTE = /\/api\/proxy\/admin\/licenses(\?|$)/;
const SCOPES_ROUTE = /\/api\/proxy\/admin\/scopes(\?|$)/;
const TEMPLATES_ROUTE = /\/api\/proxy\/admin\/templates(\?|$)/;
const REVOKE_ROUTE = /\/api\/proxy\/admin\/licenses\/([^/]+)\/revoke$/;

function listFixture(items: (typeof sampleLicense)[]) {
  return { data: { items, next_cursor: null as string | null } };
}

test.describe('licenses index — bulk actions', () => {
  test('bulk revoke fans out POSTs for the selected rows', async ({
    authedPage,
    mockProxy,
    page,
  }) => {
    const revoked: string[] = [];
    await page.route(REVOKE_ROUTE, (route) => {
      const m = route
        .request()
        .url()
        .match(/\/admin\/licenses\/([^/]+)\/revoke/);
      if (m && m[1]) revoked.push(m[1]);
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { ok: true } }),
      });
    });
    await mockProxy([
      { url: SCOPES_ROUTE, body: { data: { items: [sampleScope], next_cursor: null } } },
      { url: TEMPLATES_ROUTE, body: { data: { items: [sampleTemplate], next_cursor: null } } },
      { url: LIST_ROUTE, body: listFixture([ACTIVE, ALSO_ACTIVE]) },
    ]);

    await authedPage.goto('/licenses');
    await expect(authedPage.getByRole('heading', { level: 1, name: /licenses/i })).toBeVisible();

    // Select all via the header checkbox. shadcn-vue's Checkbox renders
    // as `role="checkbox"`; the header one carries the "Select all"
    // aria-label we set in DataTable.
    await authedPage.getByRole('checkbox', { name: /select all rows/i }).click();

    // Bulk-actions trigger appears with the live count.
    await expect(authedPage.getByText(/2 selected/i)).toBeVisible();
    await authedPage.getByRole('button', { name: /bulk actions/i }).click();
    await authedPage.getByRole('menuitem', { name: /revoke selected/i }).click();

    // Confirmation dialog. Title shows "Revoke 2 licenses"; we type the
    // matching phrase ("revoke 2") to unlock the destructive button.
    const dialog = authedPage.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/revoke 2 licenses/i)).toBeVisible();
    await dialog.getByLabel(/to confirm, type/i).fill('revoke 2');
    await dialog.getByRole('button', { name: /^revoke 2 licenses$/i }).click();

    await expect.poll(() => revoked.length, { timeout: 5_000 }).toBe(2);
    expect(revoked.sort()).toEqual([ACTIVE.id, ALSO_ACTIVE.id].sort());
  });

  test('mixed-status selection skips ineligible rows in the confirm copy', async ({
    authedPage,
    mockProxy,
    page,
  }) => {
    const revoked: string[] = [];
    await page.route(REVOKE_ROUTE, (route) => {
      const m = route
        .request()
        .url()
        .match(/\/admin\/licenses\/([^/]+)\/revoke/);
      if (m && m[1]) revoked.push(m[1]);
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { ok: true } }),
      });
    });
    await mockProxy([
      { url: SCOPES_ROUTE, body: { data: { items: [sampleScope], next_cursor: null } } },
      { url: TEMPLATES_ROUTE, body: { data: { items: [sampleTemplate], next_cursor: null } } },
      { url: LIST_ROUTE, body: listFixture([ACTIVE, ALREADY_REVOKED]) },
    ]);

    await authedPage.goto('/licenses');
    await authedPage.getByRole('checkbox', { name: /select all rows/i }).click();
    await authedPage.getByRole('button', { name: /bulk actions/i }).click();
    await authedPage.getByRole('menuitem', { name: /revoke selected/i }).click();

    const dialog = authedPage.getByRole('alertdialog');
    // "1 of 2 selected licenses will be revoked. 1 are not eligible..."
    await expect(dialog.getByText(/1 of 2 selected/i)).toBeVisible();
    await dialog.getByLabel(/to confirm, type/i).fill('revoke 1');
    await dialog.getByRole('button', { name: /^revoke 1 license$/i }).click();

    // Only the active row got POSTed.
    await expect.poll(() => revoked.length, { timeout: 5_000 }).toBe(1);
    expect(revoked).toEqual([ACTIVE.id]);
  });
});
