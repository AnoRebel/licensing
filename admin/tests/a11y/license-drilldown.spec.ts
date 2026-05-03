import { sampleAuditEntry, sampleLicense, sampleScope, sampleTemplate } from './_fixtures/sample';
import { expect, test } from './fixtures';

/**
 * License detail drill-down specs — owner card, template card, audit
 * timeline. The four scenarios cover the spec's matrix:
 *   - owner-resolved   (consumer's /owners/{type}/{id} returns data)
 *   - owner-missing    (consumer has no resolver — empty state)
 *   - template-set     (license.template_id resolves to a template)
 *   - template-missing (license.template_id is null — ad-hoc state)
 *   - mixed audit log  (multiple events on different days)
 *
 * Each test mocks the upstream proxy responses through the `mockProxy`
 * fixture; the catch-all 599 in fixtures.ts will fail the test if any
 * route is missed.
 */

const LICENSE_ROUTE = new RegExp(`/api/proxy/admin/licenses/${sampleLicense.id}$`);
const USAGES_ROUTE = /\/api\/proxy\/admin\/usages(\?|$)/;
const AUDIT_ROUTE = /\/api\/proxy\/admin\/audit(\?|$)/;
const SCOPES_ROUTE = /\/api\/proxy\/admin\/scopes(\?|$)/;
const TEMPLATE_ROUTE = new RegExp(`/api/proxy/admin/templates/${sampleTemplate.id}$`);
const OWNER_ROUTE = new RegExp(
  `/api/proxy/owners/${sampleLicense.licensable_type}/${sampleLicense.licensable_id}$`,
);

const NOW_ISO = new Date('2026-04-19T10:00:00Z').toISOString();
const YESTERDAY_ISO = new Date('2026-04-18T11:00:00Z').toISOString();

function auditPage(events: (typeof sampleAuditEntry)[]) {
  return { data: { items: events, next_cursor: null } };
}

test.describe('license detail — drill-down sections', () => {
  test('renders the owner card when the consumer resolver returns data', async ({
    authedPage,
    mockProxy,
  }) => {
    await mockProxy([
      { url: LICENSE_ROUTE, body: { data: sampleLicense } },
      { url: USAGES_ROUTE, body: { data: { items: [], next_cursor: null } } },
      { url: SCOPES_ROUTE, body: { data: { items: [sampleScope], next_cursor: null } } },
      { url: AUDIT_ROUTE, body: auditPage([]) },
      {
        url: OWNER_ROUTE,
        body: {
          data: {
            name: 'Ada Lovelace',
            email: '[email protected]',
          },
        },
      },
    ]);

    await authedPage.goto(`/licenses/${sampleLicense.id}`);
    const ownerCard = authedPage.getByRole('region', { name: /^owner$/i });
    await expect(ownerCard).toBeVisible();
    await expect(ownerCard.getByText('Ada Lovelace')).toBeVisible();
    await expect(ownerCard.getByText('[email protected]')).toBeVisible();
  });

  test('renders a graceful empty state when the owner resolver returns 404', async ({
    authedPage,
    mockProxy,
  }) => {
    await mockProxy([
      { url: LICENSE_ROUTE, body: { data: sampleLicense } },
      { url: USAGES_ROUTE, body: { data: { items: [], next_cursor: null } } },
      { url: SCOPES_ROUTE, body: { data: { items: [sampleScope], next_cursor: null } } },
      { url: AUDIT_ROUTE, body: auditPage([]) },
      {
        url: OWNER_ROUTE,
        body: { error: { code: 'NotFound', message: 'no resolver' }, success: false },
        status: 404,
      },
    ]);

    await authedPage.goto(`/licenses/${sampleLicense.id}`);
    const ownerCard = authedPage.getByRole('region', { name: /^owner$/i });
    await expect(ownerCard).toBeVisible();
    // Falls back to the canonical licensable_type:licensable_id pair
    // and surfaces the "implement /owners/..." instructional copy.
    await expect(
      ownerCard.getByText(`${sampleLicense.licensable_type}:${sampleLicense.licensable_id}`),
    ).toBeVisible();
    await expect(ownerCard.getByText(/owner resolver isn't wired/i)).toBeVisible();
  });

  test('renders the template card with details when template_id is set', async ({
    authedPage,
    mockProxy,
  }) => {
    await mockProxy([
      {
        url: LICENSE_ROUTE,
        body: { data: { ...sampleLicense, template_id: sampleTemplate.id } },
      },
      { url: USAGES_ROUTE, body: { data: { items: [], next_cursor: null } } },
      { url: SCOPES_ROUTE, body: { data: { items: [sampleScope], next_cursor: null } } },
      { url: AUDIT_ROUTE, body: auditPage([]) },
      { url: TEMPLATE_ROUTE, body: { data: sampleTemplate } },
      { url: OWNER_ROUTE, status: 404, body: { error: { code: 'NotFound' }, success: false } },
    ]);

    await authedPage.goto(`/licenses/${sampleLicense.id}`);
    const templateCard = authedPage.getByRole('region', { name: /^template$/i });
    await expect(templateCard).toBeVisible();
    await expect(templateCard.getByText(sampleTemplate.name)).toBeVisible();
    // Drill-through link to the full template page.
    await expect(templateCard.getByRole('link', { name: /view/i })).toHaveAttribute(
      'href',
      `/templates/${sampleTemplate.id}`,
    );
  });

  test('renders the ad-hoc state when template_id is null', async ({ authedPage, mockProxy }) => {
    await mockProxy([
      { url: LICENSE_ROUTE, body: { data: { ...sampleLicense, template_id: null } } },
      { url: USAGES_ROUTE, body: { data: { items: [], next_cursor: null } } },
      { url: SCOPES_ROUTE, body: { data: { items: [sampleScope], next_cursor: null } } },
      { url: AUDIT_ROUTE, body: auditPage([]) },
      { url: OWNER_ROUTE, status: 404, body: { error: { code: 'NotFound' }, success: false } },
    ]);

    await authedPage.goto(`/licenses/${sampleLicense.id}`);
    const templateCard = authedPage.getByRole('region', { name: /^template$/i });
    await expect(templateCard).toBeVisible();
    await expect(templateCard.getByText(/ad-hoc license/i)).toBeVisible();
  });

  test('groups audit entries by day in the timeline', async ({ authedPage, mockProxy }) => {
    const today = {
      ...sampleAuditEntry,
      id: '018df9f1-0000-7000-8000-0000000003a1',
      event: 'license.suspended',
      occurred_at: NOW_ISO,
    };
    const yesterday = {
      ...sampleAuditEntry,
      id: '018df9f1-0000-7000-8000-0000000003a2',
      event: 'license.created',
      occurred_at: YESTERDAY_ISO,
    };
    await mockProxy([
      { url: LICENSE_ROUTE, body: { data: sampleLicense } },
      { url: USAGES_ROUTE, body: { data: { items: [], next_cursor: null } } },
      { url: SCOPES_ROUTE, body: { data: { items: [sampleScope], next_cursor: null } } },
      { url: AUDIT_ROUTE, body: auditPage([today, yesterday]) },
      { url: OWNER_ROUTE, status: 404, body: { error: { code: 'NotFound' }, success: false } },
    ]);

    await authedPage.goto(`/licenses/${sampleLicense.id}`);

    // Both events render their event names + actors.
    await expect(authedPage.getByText('license.suspended')).toBeVisible();
    await expect(authedPage.getByText('license.created')).toBeVisible();

    // The day headers come from a date-fns format — assert the two
    // distinct headers appear without pinning the exact locale string.
    // We grep for the year (2026) which must show up at least twice if
    // grouping worked correctly.
    const yearHeaders = authedPage.locator('p').filter({ hasText: /2026/ });
    await expect(yearHeaders).toHaveCount(2);
  });
});
