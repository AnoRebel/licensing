import { cursorPage, sampleScope, sampleUsage } from './_fixtures/sample';
import { assertNoViolations, expect, test } from './fixtures';

/**
 * Primary flow #3: open the usages index and revoke one. Revoke uses the
 * ConfirmDestructive (typed-to-confirm) dialog pattern — that component's
 * a11y is the whole point of this spec.
 */

test.describe('usages → revoke', () => {
  test('is accessible at each step', async ({ authedPage, mockProxy, axeScan }) => {
    await mockProxy([
      { url: /\/api\/proxy\/admin\/usages(\?|$)/, body: cursorPage([sampleUsage]) },
      { url: /\/api\/proxy\/admin\/scopes(\?|$)/, body: cursorPage([sampleScope]) },
      {
        url: new RegExp(`/api/proxy/admin/usages/${sampleUsage.id}/revoke`),
        body: { data: { ...sampleUsage, revoked_at: '2026-04-19T10:00:00Z' } },
      },
    ]);

    await authedPage.goto('/usages');
    await expect(authedPage.getByRole('table')).toBeVisible();
    assertNoViolations(await axeScan(), 'usages index');

    const revoke = authedPage.getByRole('button', { name: /revoke/i }).first();
    if (await revoke.isVisible()) {
      await revoke.click();
      await expect(authedPage.getByRole('alertdialog')).toBeVisible();
      assertNoViolations(await axeScan(), 'revoke confirm');
    }
  });
});
