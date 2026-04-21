import { cursorPage, sampleAuditEntry, sampleScope } from './_fixtures/sample';
import { assertNoViolations, expect, test } from './fixtures';

/**
 * Primary flow #4: audit log viewer + state-diff dialog. The state-diff
 * dialog pretty-prints JSON in <pre> blocks — axe often flags those for
 * scrollable-region keyboard access if they overflow without tabindex,
 * so this is a useful scan target.
 */

test.describe('audit viewer → state diff dialog', () => {
  test('is accessible at each step', async ({ authedPage, mockProxy, axeScan }) => {
    await mockProxy([
      { url: /\/api\/proxy\/admin\/audit(\?|$)/, body: cursorPage([sampleAuditEntry]) },
      { url: /\/api\/proxy\/admin\/scopes(\?|$)/, body: cursorPage([sampleScope]) },
    ]);

    await authedPage.goto('/audit');
    await expect(authedPage.getByRole('heading', { level: 1 })).toBeVisible();
    assertNoViolations(await axeScan(), 'audit index');

    const view = authedPage.getByRole('button', { name: /^view$/i }).first();
    if (await view.isVisible()) {
      await view.click();
      await expect(authedPage.getByRole('dialog')).toBeVisible();
      assertNoViolations(await axeScan(), 'audit state-diff dialog');
    }
  });
});
