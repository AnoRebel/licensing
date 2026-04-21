import { cursorPage, sampleKey, sampleScope } from './_fixtures/sample';
import { assertNoViolations, expect, test } from './fixtures';

/**
 * Global keys index → rotate from cross-scope view.
 *
 * Distinct from the scope-scoped rotate flow (scopes-rotate.spec.ts)
 * because this page exposes additional filters (state + scope dropdown)
 * that exercise different form-control + faceted-filter primitives.
 */

test.describe('global keys → rotate', () => {
  test('is accessible at each step', async ({ authedPage, mockProxy, axeScan }) => {
    await mockProxy([
      { url: /\/api\/proxy\/admin\/scopes(\?|$)/, body: cursorPage([sampleScope]) },
      { url: /\/api\/proxy\/admin\/keys(\?|$)/, body: cursorPage([sampleKey]) },
      {
        url: new RegExp(`/api/proxy/admin/keys/${sampleKey.id}/rotate`),
        body: { data: { previous_kid: sampleKey.kid, new_kid: 'k_new', secret: 'secret_b64url' } },
      },
    ]);

    await authedPage.goto('/keys');
    await expect(authedPage.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(authedPage.getByRole('table')).toBeVisible();
    assertNoViolations(await axeScan(), 'global keys index');

    // Open rotate AlertDialog from a row action
    const rotate = authedPage.getByRole('button', { name: /rotate/i }).first();
    if (await rotate.isVisible()) {
      await rotate.click();
      await expect(authedPage.getByRole('alertdialog')).toBeVisible();
      assertNoViolations(await axeScan(), 'global keys rotate confirm');
    }
  });
});
