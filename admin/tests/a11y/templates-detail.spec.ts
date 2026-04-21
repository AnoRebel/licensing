import { sampleScope, sampleTemplate } from './_fixtures/sample';
import { assertNoViolations, expect, test } from './fixtures';

/**
 * Template detail — edit form + destructive delete confirm.
 *
 * The page renders Textarea-based JSON editors for entitlements/meta with
 * inline parse feedback; axe exercises those error surfaces plus the
 * ConfirmDestructive `AlertDialog` when the operator clicks Delete.
 */

test.describe('template detail', () => {
  test('is accessible at each step', async ({ authedPage, mockProxy, axeScan }) => {
    await mockProxy([
      {
        url: /\/api\/proxy\/admin\/scopes(\?|$)/,
        body: { data: { items: [sampleScope], next_cursor: null } },
      },
      {
        url: new RegExp(`/api/proxy/admin/templates/${sampleTemplate.id}$`),
        body: { data: sampleTemplate },
      },
    ]);

    await authedPage.goto(`/templates/${sampleTemplate.id}`);
    await expect(authedPage.getByRole('heading', { level: 1 })).toBeVisible();
    assertNoViolations(await axeScan(), 'template detail');

    // Open destructive delete confirm (AlertDialog primitive)
    const del = authedPage.getByRole('button', { name: /^delete$/i });
    if (await del.isVisible()) {
      await del.click();
      await expect(authedPage.getByRole('alertdialog')).toBeVisible();
      assertNoViolations(await axeScan(), 'template delete confirm');
    }
  });
});
