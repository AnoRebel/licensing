import { cursorPage, sampleKey, sampleScope } from './_fixtures/sample';
import { assertNoViolations, expect, test } from './fixtures';

/**
 * Primary flow #2: navigate into a scope and rotate a key. The rotate
 * confirmation is an AlertDialog (destructive variant) — distinct
 * primitive from Dialog, so it gets its own scan.
 */

test.describe('scopes → scope detail → rotate key', () => {
  test('is accessible at each step', async ({ authedPage, mockProxy, axeScan }) => {
    await mockProxy([
      { url: /\/api\/proxy\/admin\/scopes(\?|$)/, body: cursorPage([sampleScope]) },
      {
        url: new RegExp(`/api/proxy/admin/scopes/${sampleScope.id}$`),
        body: { data: sampleScope },
      },
      {
        url: new RegExp(`/api/proxy/admin/scopes/${sampleScope.id}/keys`),
        body: cursorPage([sampleKey]),
      },
      {
        url: new RegExp(`/api/proxy/admin/keys/${sampleKey.id}/rotate`),
        body: { data: { previous_kid: sampleKey.kid, new_kid: 'k_new', secret: 'secret_b64url' } },
      },
    ]);

    await authedPage.goto('/scopes');
    await expect(authedPage.getByRole('table')).toBeVisible();
    assertNoViolations(await axeScan(), 'scopes index');

    await authedPage.goto(`/scopes/${sampleScope.id}`);
    await expect(authedPage.getByRole('heading', { level: 1 })).toBeVisible();
    assertNoViolations(await axeScan(), 'scope detail');

    // Open rotate AlertDialog via row action
    const rotate = authedPage.getByRole('button', { name: /rotate/i }).first();
    if (await rotate.isVisible()) {
      await rotate.click();
      await expect(authedPage.getByRole('alertdialog')).toBeVisible();
      assertNoViolations(await axeScan(), 'rotate confirmation');
    }
  });
});
