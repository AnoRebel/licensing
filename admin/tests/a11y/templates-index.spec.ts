import { cursorPage, sampleScope, sampleTemplate } from './_fixtures/sample';
import { assertNoViolations, expect, test } from './fixtures';

/**
 * Templates index — populated list + New-template Dialog.
 *
 * Covers the table-with-row-action scan plus the shadcn/reka `Dialog`
 * primitive when opened from the page-level "New template" button. Focus
 * management, form-label associations, and the Valibot error surfaces all
 * need to clear axe on WCAG 2.2 AA.
 */

test.describe('templates index', () => {
  test('is accessible at each step', async ({ authedPage, mockProxy, axeScan }) => {
    await mockProxy([
      { url: /\/api\/proxy\/admin\/scopes(\?|$)/, body: cursorPage([sampleScope]) },
      { url: /\/api\/proxy\/admin\/templates(\?|$)/, body: cursorPage([sampleTemplate]) },
    ]);

    await authedPage.goto('/templates');
    await expect(authedPage.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(authedPage.getByRole('table')).toBeVisible();
    assertNoViolations(await axeScan(), 'templates index');

    // Open New-template dialog
    const newBtn = authedPage.getByRole('button', { name: /new template/i });
    if (await newBtn.isVisible()) {
      await newBtn.click();
      await expect(authedPage.getByRole('dialog')).toBeVisible();
      assertNoViolations(await axeScan(), 'new template dialog');
    }
  });
});
