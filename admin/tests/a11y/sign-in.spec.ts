import AxeBuilder from '@axe-core/playwright';
import { test as base, expect } from '@playwright/test';
import { assertNoViolations } from './fixtures';

/**
 * Sign-in is the only unauthenticated surface we scan; it opts out of
 * the default layout, so we don't piggyback on the authedPage fixture.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

base('/sign-in is accessible (light)', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  assertNoViolations(results, 'sign-in (light)');
});
