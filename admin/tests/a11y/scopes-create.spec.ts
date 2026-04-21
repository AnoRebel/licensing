import { cursorPage, sampleScope } from './_fixtures/sample';
import { assertNoViolations, expect, test } from './fixtures';

/**
 * Scopes index → New-scope Dialog.
 *
 * The create flow is a Dialog containing a TanStack/Valibot form with
 * immutable-slug messaging. This spec covers the index table plus the
 * open-dialog state so focus-trap + label associations get scanned.
 */

test.describe('scopes → new-scope dialog', () => {
  test('is accessible at each step', async ({ authedPage, mockProxy, axeScan }) => {
    await mockProxy([
      { url: /\/api\/proxy\/admin\/scopes(\?|$)/, body: cursorPage([sampleScope]) },
    ]);

    await authedPage.goto('/scopes');
    await expect(authedPage.getByRole('table')).toBeVisible();
    assertNoViolations(await axeScan(), 'scopes index');

    // Open New scope dialog
    await authedPage.getByRole('button', { name: /new scope/i }).click();
    await expect(authedPage.getByRole('dialog')).toBeVisible();
    assertNoViolations(await axeScan(), 'new scope dialog');
  });
});
