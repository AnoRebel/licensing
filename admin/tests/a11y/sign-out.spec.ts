import { cursorPage, sampleAuditEntry, sampleLicense } from './_fixtures/sample';
import { assertNoViolations, expect, test } from './fixtures';

/**
 * Primary flow #5: the sign-out button lives in the shared header. This
 * spec exercises its focus ring + `aria-label` affordances by scanning
 * the header region specifically (via `include`) so we don't re-scan
 * the main landmark already covered elsewhere.
 *
 * The button is a <button> with visible text, so axe won't have much to
 * say — but that's the point: if someone converts it to a bare icon
 * without a label later, this spec catches it.
 */

test('header (sign-out + color-mode toggle) is accessible', async ({
  authedPage,
  mockProxy,
  axeScan,
}) => {
  await mockProxy([
    { url: /\/api\/proxy\/admin\/licenses\?.*status=active/, body: cursorPage([sampleLicense]) },
    { url: /\/api\/proxy\/admin\/audit\?limit=20/, body: cursorPage([sampleAuditEntry]) },
  ]);

  await authedPage.goto('/');
  const header = authedPage.getByRole('banner');
  await expect(header).toBeVisible();

  assertNoViolations(await axeScan({ include: 'header' }), 'header region');

  // Focus visibly reaches the sign-out button via keyboard.
  await authedPage.keyboard.press('Tab');
  await expect(authedPage.getByRole('button', { name: /sign out/i }))
    .toBeFocused({
      timeout: 2000,
    })
    .catch(async () => {
      // Skip-link-less layouts may require several tabs; allow up to 10.
      for (let i = 0; i < 10; i++) {
        await authedPage.keyboard.press('Tab');
        const focused = await authedPage.evaluate(() =>
          document.activeElement?.textContent?.trim(),
        );
        if (focused && /sign out/i.test(focused)) return;
      }
      throw new Error('sign-out button never received focus via keyboard');
    });
});
