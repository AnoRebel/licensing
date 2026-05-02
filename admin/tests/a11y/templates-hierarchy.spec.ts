import {
  sampleScope,
  sampleTemplate,
  sampleTemplateChild,
  sampleTemplateParent,
} from './_fixtures/sample';
import { expect, test } from './fixtures';

/**
 * Templates hierarchy — the parent picker + hierarchy preview + the
 * "Issue license from template" flow that lands the license create POST.
 *
 * These are *behavioural* specs (state + intercepted requests), unlike
 * the axe-only suite alongside them. They share the seal-session +
 * mockProxy fixtures so they pick up the same authed origin.
 *
 * Parent-picker exclusion: the detail page hides `self + descendants`
 * from the picker so the obvious cycle paths never appear. The server
 * still rejects cycles with 409 `TemplateCycle` regardless — that path
 * is covered by the cross-port admin-handler tests, not here.
 */

test.describe('templates create — parent picker', () => {
  test('passes parent_id and trial_cooldown_sec on POST /admin/templates', async ({
    authedPage,
    mockProxy,
    page,
  }) => {
    await mockProxy([
      {
        url: /\/api\/proxy\/admin\/scopes(\?|$)/,
        body: { data: { items: [sampleScope], next_cursor: null } },
      },
      {
        // Two-template list seeds the parent combobox with one option
        // (sampleTemplate). The "all" key is loaded with limit=200.
        url: /\/api\/proxy\/admin\/templates(\?|$)/,
        body: { data: { items: [sampleTemplate, sampleTemplateParent], next_cursor: null } },
      },
    ]);

    // Capture the create-template POST body.
    let captured: Record<string, unknown> | null = null;
    await page.route(/\/api\/proxy\/admin\/templates$/, (route) => {
      if (route.request().method() === 'POST') {
        captured = JSON.parse(route.request().postData() ?? '{}');
        route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              ...sampleTemplate,
              id: '018df9f1-0000-7000-8000-000000000099',
              name: (captured as { name?: string })?.name ?? 'New',
              parent_id: (captured as { parent_id?: string | null })?.parent_id ?? null,
              trial_cooldown_sec:
                (captured as { trial_cooldown_sec?: number | null })?.trial_cooldown_sec ?? null,
            },
          }),
        });
        return;
      }
      // Let the GET pass through to the mockProxy register.
      route.fallback();
    });

    await authedPage.goto('/templates');
    await authedPage.getByRole('button', { name: /new template/i }).click();
    const dialog = authedPage.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Fill the standard fields.
    await dialog.locator('select#scope_id').selectOption(sampleScope.id);
    await dialog.getByLabel('Name').fill('Pro Trial');

    // Open the parent combobox + select the parent option. The
    // CommandList isn't a listbox role — pick by visible text instead.
    await dialog.getByRole('combobox', { name: /parent template/i }).click();
    await authedPage.getByRole('option', { name: sampleTemplateParent.name }).click();

    // trial_cooldown_sec
    await dialog.getByLabel(/trial_cooldown_sec/i).fill('86400');

    // Submit.
    await dialog.getByRole('button', { name: /create template/i }).click();

    await expect.poll(() => captured).not.toBeNull();
    expect((captured as { parent_id: string }).parent_id).toBe(sampleTemplateParent.id);
    expect((captured as { trial_cooldown_sec: number }).trial_cooldown_sec).toBe(86400);
  });
});

test.describe('templates detail — hierarchy preview + Issue-from-template', () => {
  test('renders parent breadcrumb + child list and POSTs license with template_id', async ({
    authedPage,
    mockProxy,
    page,
  }) => {
    await mockProxy([
      {
        url: /\/api\/proxy\/admin\/scopes(\?|$)/,
        body: { data: { items: [sampleScope], next_cursor: null } },
      },
      {
        url: /\/api\/proxy\/admin\/templates\?(?!.*\/).*/,
        // List with limit=200 used by the parent picker + hierarchy preview.
        body: {
          data: {
            items: [sampleTemplate, sampleTemplateParent, sampleTemplateChild],
            next_cursor: null,
          },
        },
      },
      {
        url: new RegExp(`/api/proxy/admin/templates/${sampleTemplate.id}$`),
        body: {
          // Re-parent sampleTemplate under sampleTemplateParent so the
          // ancestor breadcrumb has something to render and
          // sampleTemplateChild appears in `children` (its parent_id is
          // sampleTemplate.id by construction).
          data: { ...sampleTemplate, parent_id: sampleTemplateParent.id },
        },
      },
    ]);

    let licenseBody: Record<string, unknown> | null = null;
    await page.route(/\/api\/proxy\/admin\/licenses$/, (route) => {
      if (route.request().method() === 'POST') {
        licenseBody = JSON.parse(route.request().postData() ?? '{}');
        route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              id: '018df9f1-0000-7000-8000-000000000099',
              status: 'pending',
              template_id: sampleTemplate.id,
              max_usages: sampleTemplate.max_usages,
              created_at: '2026-04-19T10:00:00Z',
              updated_at: '2026-04-19T10:00:00Z',
            },
          }),
        });
        return;
      }
      route.fallback();
    });

    await authedPage.goto(`/templates/${sampleTemplate.id}`);
    await expect(authedPage.getByRole('heading', { level: 1 })).toBeVisible();

    // Hierarchy preview
    const hierarchy = authedPage.getByRole('region', { name: /template hierarchy/i });
    await expect(hierarchy).toBeVisible();
    await expect(hierarchy.getByText(sampleTemplateParent.name)).toBeVisible();
    await expect(hierarchy.getByText(sampleTemplateChild.name)).toBeVisible();

    // Issue-from-template
    await authedPage.getByRole('button', { name: /issue license/i }).click();
    const issueDialog = authedPage.getByRole('dialog', { name: /issue license/i });
    await expect(issueDialog).toBeVisible();

    await issueDialog.getByLabel(/licensable_type/i).fill('User');
    await issueDialog.getByLabel(/licensable_id/i).fill('user-42');
    await issueDialog.getByRole('button', { name: /^issue license$/i }).click();

    await expect.poll(() => licenseBody).not.toBeNull();
    expect((licenseBody as { template_id: string }).template_id).toBe(sampleTemplate.id);
    expect((licenseBody as { licensable_type: string }).licensable_type).toBe('User');
    expect((licenseBody as { licensable_id: string }).licensable_id).toBe('user-42');
  });

  test('surfaces 409 TemplateCycle from a re-parent attempt', async ({
    authedPage,
    mockProxy,
    page,
  }) => {
    // Storage rejects the re-parent with TemplateCycle; UI should toast
    // an error rather than silently swallow + redirect. We never even
    // fire the request from the picker (self+descendants are filtered)
    // but a paste-in-the-form or stale-state PATCH still goes out, so
    // we trigger it via direct PATCH to confirm the error path is wired.
    await mockProxy([
      {
        url: /\/api\/proxy\/admin\/scopes(\?|$)/,
        body: { data: { items: [sampleScope], next_cursor: null } },
      },
      {
        url: /\/api\/proxy\/admin\/templates\?(?!.*\/).*/,
        body: {
          data: { items: [sampleTemplate, sampleTemplateChild], next_cursor: null },
        },
      },
      {
        url: new RegExp(`/api/proxy/admin/templates/${sampleTemplate.id}$`),
        body: { data: sampleTemplate },
      },
    ]);

    let patched = false;
    await page.route(new RegExp(`/api/proxy/admin/templates/${sampleTemplate.id}$`), (route) => {
      if (route.request().method() === 'PATCH') {
        patched = true;
        route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'TemplateCycle',
              message: 'template parent chain forms a cycle through this template',
            },
            success: false,
          }),
        });
        return;
      }
      route.fallback();
    });

    await authedPage.goto(`/templates/${sampleTemplate.id}`);
    await expect(authedPage.getByRole('heading', { level: 1 })).toBeVisible();

    // Click Save without changes to the parent — the form sends a PATCH
    // including parent_id (currently null), so we emulate the server
    // returning the 409 anyway. Confirms the toast pipeline surfaces it.
    await authedPage.getByRole('button', { name: /save changes/i }).click();
    await expect(authedPage.getByText(/cycle/i)).toBeVisible();
    expect(patched).toBe(true);
  });
});
