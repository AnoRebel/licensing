import { cursorPage, sampleAuditEntry, sampleLicense } from './_fixtures/sample';
import { assertNoViolations, expect, test } from './fixtures';

/**
 * Primary flow #1: operator lands on the dashboard, drills into a
 * license, and renews it. Axe scans at each checkpoint plus after the
 * renew dialog opens so focus-management + dialog semantics get
 * exercised under reka-ui's `Dialog` primitive.
 */

test.describe('dashboard → license detail → renew', () => {
  test('is accessible at each step', async ({ authedPage, mockProxy, axeScan }) => {
    await mockProxy([
      {
        url: /\/api\/proxy\/admin\/licenses\?.*status=active/,
        body: cursorPage([sampleLicense]),
      },
      {
        url: /\/api\/proxy\/admin\/audit\?limit=20/,
        body: cursorPage([sampleAuditEntry]),
      },
      {
        url: /\/api\/proxy\/admin\/licenses\?.*limit=/,
        body: cursorPage([sampleLicense]),
      },
      {
        url: new RegExp(`/api/proxy/admin/licenses/${sampleLicense.id}$`),
        body: { data: sampleLicense },
      },
      {
        url: new RegExp(`/api/proxy/admin/licenses/${sampleLicense.id}/usages`),
        body: cursorPage([]),
      },
      {
        url: new RegExp(`/api/proxy/admin/licenses/${sampleLicense.id}/renew`),
        body: { data: { ...sampleLicense, expires_at: '2027-10-19T10:00:00Z' } },
      },
    ]);

    // Dashboard
    await authedPage.goto('/');
    await expect(authedPage.getByRole('heading', { level: 1 })).toBeVisible();
    assertNoViolations(await axeScan(), 'dashboard');

    // Licenses index
    await authedPage.goto('/licenses');
    await expect(authedPage.getByRole('table')).toBeVisible();
    assertNoViolations(await axeScan(), 'licenses index');

    // License detail
    await authedPage.goto(`/licenses/${sampleLicense.id}`);
    await expect(authedPage.getByRole('heading', { level: 1 })).toBeVisible();
    assertNoViolations(await axeScan(), 'license detail');

    // Open renew dialog
    await authedPage.getByRole('button', { name: /^renew$/i }).click();
    await expect(authedPage.getByRole('dialog')).toBeVisible();
    assertNoViolations(await axeScan(), 'renew dialog');
  });
});
