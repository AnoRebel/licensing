<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';
import { computed, ref } from 'vue';
import { toast } from 'vue-sonner';
import { useForm } from '@tanstack/vue-form';
import * as v from 'valibot';
import LicenseStatusBadge from '~/components/LicenseStatusBadge.vue';
import ConfirmDestructive from '~/components/ConfirmDestructive.vue';
import LicenseAuditTimeline from '~/components/license/LicenseAuditTimeline.vue';
import OwnerCard from '~/components/license/OwnerCard.vue';
import TemplateCard from '~/components/license/TemplateCard.vue';
import { formatAbsolute, formatRelative } from '~/lib/datetime';
import { usageColumns, type UsageTableMeta } from './usage-columns';

type License = components['schemas']['License'];
type Usage = components['schemas']['Usage'];

/**
 * License detail — the operator's single pane of glass for one license:
 *   - Header: key (copyable), status badge, lifecycle action buttons.
 *   - Metadata grid: all immutable + near-immutable fields, UTC timestamps.
 *   - Embedded usages table with per-row revoke.
 *
 * Lifecycle model:
 *   - suspend / resume / revoke take no body.
 *   - renew needs `expires_at` (and optional `grace_until`) — shown in a
 *     small inline form gated by a Dialog, not ConfirmDestructive (renew
 *     is not destructive, just a state transition).
 *   - revoke is terminal, so it's gated by ConfirmDestructive: operator
 *     must type the license key to unlock the button.
 *   - Per-row usage revoke is also gated by ConfirmDestructive (same
 *     rationale — a revoked usage cannot be un-revoked).
 *
 * One ConfirmDestructive instance is reused for both "revoke license" and
 * "revoke usage" flows; the `action` ref discriminates which mutation to
 * fire on confirm.
 */

useHead({ title: 'License — Licensing Admin' });

const route = useRoute();
const licenseId = computed(() => route.params.id as string);

const { $licensing } = useNuxtApp();

// --- License fetch ------------------------------------------------------
const {
  data: licenseData,
  pending: licensePending,
  error: licenseError,
  refresh: refreshLicense,
} = await useLicensing('/admin/licenses/{id}', {
  path: { id: licenseId.value },
  key: `admin-license-${licenseId.value}`,
});

const license = computed<License | undefined>(() => licenseData.value?.data);

// --- Usages fetch (one page; license details rarely need pagination in this view) ---
const usagesQuery = computed(() => ({ license_id: licenseId.value, limit: 50 }));
const {
  data: usagesData,
  pending: usagesPending,
  error: usagesError,
  refresh: refreshUsages,
} = await useLicensing('/admin/usages', {
  query: usagesQuery,
  key: `admin-license-${licenseId.value}-usages`,
  watch: [usagesQuery],
});

const usages = computed<Usage[]>(() => usagesData.value?.data?.items ?? []);

// --- Action state -------------------------------------------------------
type PendingAction =
  | { kind: 'suspend' }
  | { kind: 'resume' }
  | { kind: 'revoke-license' }
  | { kind: 'revoke-usage'; usage: Usage }
  | null;

const action = ref<PendingAction>(null);
const actionPending = ref(false);
const confirmOpen = ref(false);
const renewOpen = ref(false);

const canSuspend = computed(
  () => license.value && ['active', 'grace', 'expired'].includes(license.value.status),
);
const canResume = computed(() => license.value?.status === 'suspended');
const canRevoke = computed(() => license.value && license.value.status !== 'revoked');
const canRenew = computed(() => license.value && license.value.status !== 'revoked');

function openConfirmRevokeLicense() {
  if (!license.value) return;
  action.value = { kind: 'revoke-license' };
  confirmOpen.value = true;
}

function openConfirmRevokeUsage(usage: Usage) {
  action.value = { kind: 'revoke-usage', usage };
  confirmOpen.value = true;
}

async function runSuspend() {
  if (!license.value) return;
  actionPending.value = true;
  try {
    await $licensing('/admin/licenses/{id}/suspend', {
      method: 'POST',
      path: { id: licenseId.value },
    });
    toast.success('License suspended');
    await refreshLicense();
  } catch (e) {
    toast.error(errorMessage(e, 'Could not suspend license'));
  } finally {
    actionPending.value = false;
  }
}

async function runResume() {
  if (!license.value) return;
  actionPending.value = true;
  try {
    await $licensing('/admin/licenses/{id}/resume', {
      method: 'POST',
      path: { id: licenseId.value },
    });
    toast.success('License resumed');
    await refreshLicense();
  } catch (e) {
    toast.error(errorMessage(e, 'Could not resume license'));
  } finally {
    actionPending.value = false;
  }
}

async function onConfirm() {
  if (!action.value) return;
  actionPending.value = true;
  try {
    if (action.value.kind === 'revoke-license') {
      await $licensing('/admin/licenses/{id}/revoke', {
        method: 'POST',
        path: { id: licenseId.value },
      });
      toast.success('License revoked');
      await refreshLicense();
    } else if (action.value.kind === 'revoke-usage') {
      const usageId = action.value.usage.id;
      await $licensing('/admin/usages/{id}/revoke', {
        method: 'POST',
        path: { id: usageId },
      });
      toast.success('Usage revoked');
      await Promise.all([refreshLicense(), refreshUsages()]);
    }
    confirmOpen.value = false;
    action.value = null;
  } catch (e) {
    toast.error(errorMessage(e, 'Action failed'));
  } finally {
    actionPending.value = false;
  }
}

// --- Renew form (valibot + @tanstack/vue-form) --------------------------
//
// The API accepts full ISO-8601; the native <input type="datetime-local">
// emits local-zone strings without a Z. We attach the operator's current
// zone offset before submit so the server stores a true instant, not a
// floating wall-clock.
const RenewSchema = v.object({
  expires_at: v.pipe(
    v.string(),
    v.nonEmpty('Required'),
    v.isoDateTime('Must be a valid date-time'),
  ),
  grace_until: v.optional(
    v.union([v.literal(''), v.pipe(v.string(), v.isoDateTime('Must be a valid date-time'))]),
  ),
});

function toIsoWithLocalZone(local: string): string {
  // `new Date(local)` interprets a "YYYY-MM-DDTHH:mm" string in the
  // browser's local zone, and toISOString() re-emits it as UTC with Z.
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return local;
  return d.toISOString();
}

// `onChange` + `onSubmit` both run valibot so `canSubmit` reflects
// validity live — the submit button reacts as the operator types, not
// only after a first submit attempt.
function validateRenew(value: { expires_at: string; grace_until: string }) {
  const res = v.safeParse(RenewSchema, {
    expires_at: value.expires_at ? toIsoWithLocalZone(value.expires_at) : '',
    grace_until: value.grace_until ? toIsoWithLocalZone(value.grace_until) : '',
  });
  if (!res.success) return 'Invalid date-time';
  return undefined;
}

const renewForm = useForm({
  defaultValues: {
    expires_at: '',
    grace_until: '',
  },
  validators: {
    onChange: ({ value }) => validateRenew(value),
    onSubmit: ({ value }) => validateRenew(value),
  },
  onSubmit: async ({ value }) => {
    try {
      await $licensing('/admin/licenses/{id}/renew', {
        method: 'POST',
        path: { id: licenseId.value },
        body: {
          expires_at: toIsoWithLocalZone(value.expires_at),
          grace_until: value.grace_until ? toIsoWithLocalZone(value.grace_until) : undefined,
        },
      });
      toast.success('License renewed');
      renewOpen.value = false;
      renewForm.reset();
      await refreshLicense();
    } catch (e) {
      toast.error(errorMessage(e, 'Could not renew license'));
    }
  },
});

function openRenew() {
  if (!license.value) return;
  // Pre-fill from current `expires_at` so the operator nudges forward
  // rather than retyping. datetime-local expects "YYYY-MM-DDTHH:mm".
  const current = license.value.expires_at;
  if (current) {
    const d = new Date(current);
    if (!Number.isNaN(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0');
      renewForm.setFieldValue(
        'expires_at',
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
      );
    }
  }
  renewOpen.value = true;
}

// --- Helpers -----------------------------------------------------------
interface FetchErrorLike {
  status?: number;
  statusCode?: number;
  data?: { error?: { code?: string; message?: string } } | { message?: string };
  message?: string;
}

function errorMessage(err: unknown, fallback: string): string {
  const e = err as FetchErrorLike;
  // Our admin API returns `{ error: { code, message } }` via the shared
  // envelope — surface the server-provided message when present, else
  // fall back to a safe generic string (never leak stack traces).
  const data = e?.data as { error?: { message?: string }; message?: string } | undefined;
  const msg = data?.error?.message ?? data?.message ?? e?.message;
  return msg && typeof msg === 'string' ? msg : fallback;
}

async function copyKey() {
  if (!license.value) return;
  try {
    await navigator.clipboard.writeText(license.value.license_key);
    toast.success('License key copied');
  } catch {
    toast.error('Could not copy — try selecting manually');
  }
}

const licenseErrorMessage = computed(() =>
  licenseError.value ? 'Could not load license. Check the upstream API.' : null,
);

const confirmConfig = computed(() => {
  if (!action.value) return null;
  if (action.value.kind === 'revoke-license' && license.value) {
    return {
      title: 'Revoke license',
      description:
        'This is terminal. The license moves to `revoked` — activation, refresh, and token issuance will all fail forever. No undo.',
      confirmPhrase: license.value.license_key,
      actionLabel: 'Revoke license',
    };
  }
  if (action.value.kind === 'revoke-usage') {
    return {
      title: 'Revoke usage',
      description:
        "Revokes this fingerprint. The client's offline token keeps working until its `exp`, but no new tokens are issued. No undo.",
      confirmPhrase: action.value.usage.fingerprint.slice(0, 12),
      actionLabel: 'Revoke usage',
    };
  }
  return null;
});

// --- Usages table meta --------------------------------------------------
const usageTableMeta = computed<UsageTableMeta>(() => ({
  onRevoke: (usage: Usage) => openConfirmRevokeUsage(usage),
}));
</script>

<template>
  <div class="space-y-8">
    <NuxtLink
      to="/licenses"
      class="inline-flex items-center gap-1 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-foreground"
    >
      ← back to licenses
    </NuxtLink>

    <p v-if="licenseErrorMessage" role="alert" class="text-sm text-destructive">
      {{ licenseErrorMessage }}
    </p>

    <section v-else-if="licensePending && !license" aria-busy="true" class="space-y-4">
      <Skeleton class="h-8 w-72" />
      <Skeleton class="h-32 w-full" />
    </section>

    <template v-else-if="license">
      <!-- Header: key + status + lifecycle actions -->
      <header class="space-y-4">
        <div class="space-y-2">
          <p class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
            license
          </p>
          <div class="flex flex-wrap items-center gap-3">
            <code
              class="rounded-sm border border-border bg-muted/30 px-2 py-1 font-mono text-sm"
              :title="license.license_key"
            >
              {{ license.license_key }}
            </code>
            <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="copyKey">
              Copy
            </Button>
            <LicenseStatusBadge :status="license.status" />
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <Button
            v-if="canSuspend"
            variant="outline"
            size="sm"
            :disabled="actionPending"
            @click="runSuspend"
          >
            Suspend
          </Button>
          <Button
            v-if="canResume"
            variant="outline"
            size="sm"
            :disabled="actionPending"
            @click="runResume"
          >
            Resume
          </Button>
          <Button
            v-if="canRenew"
            variant="outline"
            size="sm"
            :disabled="actionPending"
            @click="openRenew"
          >
            Renew…
          </Button>
          <Button
            v-if="canRevoke"
            variant="outline"
            size="sm"
            class="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            :disabled="actionPending"
            @click="openConfirmRevokeLicense"
          >
            Revoke…
          </Button>
          <Button variant="ghost" size="sm" :disabled="licensePending" @click="refreshLicense()">
            Refresh
          </Button>
        </div>
      </header>

      <!--
        Two-column layout below the header: main pane on the left
        (metadata, usages, audit), drill-down rail on the right
        (owner, template). The rail collapses to a stacked block on
        narrow viewports so nothing gets squeezed.
      -->
      <div class="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div class="min-w-0 space-y-6">
      <!-- Metadata grid -->
      <section
        aria-label="License metadata"
        class="grid grid-cols-1 gap-x-8 gap-y-4 rounded-md border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        <dl class="contents font-mono text-xs">
          <div class="space-y-1">
            <dt class="uppercase tracking-wide text-muted-foreground">id</dt>
            <dd class="break-all">{{ license.id }}</dd>
          </div>
          <div class="space-y-1">
            <dt class="uppercase tracking-wide text-muted-foreground">assignee</dt>
            <dd>{{ license.licensable_type }}:{{ license.licensable_id }}</dd>
          </div>
          <div class="space-y-1">
            <dt class="uppercase tracking-wide text-muted-foreground">seats</dt>
            <dd>{{ license.active_usages ?? 0 }} / {{ license.max_usages }}</dd>
          </div>
          <div class="space-y-1">
            <dt class="uppercase tracking-wide text-muted-foreground">scope</dt>
            <dd>{{ license.scope_id ?? '—' }}</dd>
          </div>
          <div class="space-y-1">
            <dt class="uppercase tracking-wide text-muted-foreground">template</dt>
            <dd>{{ license.template_id ?? '—' }}</dd>
          </div>
          <div class="space-y-1">
            <dt class="uppercase tracking-wide text-muted-foreground">activated</dt>
            <dd>
              <time v-if="license.activated_at" :datetime="license.activated_at" :title="formatAbsolute(license.activated_at)">
                {{ formatRelative(license.activated_at) }}
              </time>
              <span v-else class="text-muted-foreground">—</span>
            </dd>
          </div>
          <div class="space-y-1">
            <dt class="uppercase tracking-wide text-muted-foreground">expires</dt>
            <dd>
              <time v-if="license.expires_at" :datetime="license.expires_at" :title="formatAbsolute(license.expires_at)">
                {{ formatRelative(license.expires_at) }}
              </time>
              <span v-else class="text-muted-foreground">never</span>
            </dd>
          </div>
          <div class="space-y-1">
            <dt class="uppercase tracking-wide text-muted-foreground">grace until</dt>
            <dd>
              <time v-if="license.grace_until" :datetime="license.grace_until" :title="formatAbsolute(license.grace_until)">
                {{ formatRelative(license.grace_until) }}
              </time>
              <span v-else class="text-muted-foreground">—</span>
            </dd>
          </div>
          <div class="space-y-1">
            <dt class="uppercase tracking-wide text-muted-foreground">created</dt>
            <dd>
              <time :datetime="license.created_at" :title="formatAbsolute(license.created_at)">
                {{ formatRelative(license.created_at) }}
              </time>
            </dd>
          </div>
          <div class="space-y-1">
            <dt class="uppercase tracking-wide text-muted-foreground">updated</dt>
            <dd>
              <time :datetime="license.updated_at" :title="formatAbsolute(license.updated_at)">
                {{ formatRelative(license.updated_at) }}
              </time>
            </dd>
          </div>
        </dl>
      </section>

      <!-- Usages -->
      <section class="space-y-4" aria-label="Usages">
        <div class="flex items-baseline justify-between">
          <h2 class="text-sm font-semibold tracking-tight">
            Usages
            <span class="ml-2 font-mono text-xs font-normal text-muted-foreground">
              {{ usages.length }}
            </span>
          </h2>
          <Button variant="ghost" size="sm" :disabled="usagesPending" @click="refreshUsages()">
            Refresh
          </Button>
        </div>

        <p v-if="usagesError" role="alert" class="text-sm text-destructive">
          Could not load usages.
        </p>

        <DataTable
          v-else
          :columns="usageColumns"
          :data="usages"
          :loading="usagesPending"
          :toolbar="false"
          :meta="usageTableMeta"
          empty-message="No usages recorded for this license."
        />
      </section>

      <!-- Audit timeline scoped to this license -->
      <Suspense>
        <LicenseAuditTimeline :license-id="license.id" />
        <template #fallback>
          <div
            class="rounded-md border border-border bg-card p-4"
            aria-busy="true"
            aria-label="Audit log loading"
          >
            <div class="space-y-2">
              <div class="h-4 w-1/3 animate-pulse rounded bg-muted" />
              <div class="h-4 w-full animate-pulse rounded bg-muted" />
              <div class="h-4 w-full animate-pulse rounded bg-muted" />
            </div>
          </div>
        </template>
      </Suspense>
        </div>

        <!--
          Drill-down rail: owner + template cards. Each card owns its
          own fetch (under <Suspense> so a slow resolver doesn't gate
          the rest of the page). The rail stacks above the main column
          on narrow viewports because of the grid auto-flow.
        -->
        <aside class="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <Suspense>
            <OwnerCard
              :licensable-type="license.licensable_type"
              :licensable-id="license.licensable_id"
            />
            <template #fallback>
              <div
                class="rounded-md border border-border bg-card p-4"
                aria-busy="true"
                aria-label="Owner loading"
              >
                <div class="h-4 w-1/2 animate-pulse rounded bg-muted" />
              </div>
            </template>
          </Suspense>

          <Suspense>
            <TemplateCard :template-id="license.template_id" />
            <template #fallback>
              <div
                class="rounded-md border border-border bg-card p-4"
                aria-busy="true"
                aria-label="Template loading"
              >
                <div class="h-4 w-1/2 animate-pulse rounded bg-muted" />
              </div>
            </template>
          </Suspense>
        </aside>
      </div>
    </template>

    <!-- Shared destructive confirmation -->
    <ConfirmDestructive
      v-if="confirmConfig"
      v-model:open="confirmOpen"
      :title="confirmConfig.title"
      :description="confirmConfig.description"
      :confirm-phrase="confirmConfig.confirmPhrase"
      :action-label="confirmConfig.actionLabel"
      :pending="actionPending"
      @confirm="onConfirm"
    />

    <!-- Renew dialog -->
    <Dialog v-model:open="renewOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Renew license</DialogTitle>
          <DialogDescription>
            Extend the license's expiry. If the license is in <code>grace</code> or
            <code>expired</code>, it returns to <code>active</code> when the new window is in
            the future.
          </DialogDescription>
        </DialogHeader>

        <form
          class="space-y-4"
          @submit.prevent.stop="renewForm.handleSubmit()"
        >
          <renewForm.Field name="expires_at">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  New expires_at
                </Label>
                <Input
                  :id="field.name"
                  type="datetime-local"
                  :model-value="state.value"
                  class="font-mono"
                  required
                  :aria-invalid="state.meta.isTouched && !state.meta.isValid ? 'true' : undefined"
                  :aria-describedby="state.meta.isTouched && !state.meta.isValid ? `${field.name}-error` : undefined"
                  @update:model-value="(v: string | number) => field.handleChange(String(v))"
                  @blur="field.handleBlur"
                />
                <p
                  v-if="state.meta.isTouched && !state.meta.isValid"
                  :id="`${field.name}-error`"
                  class="text-xs text-destructive"
                  role="alert"
                >
                  {{ fieldErrors(state.meta.errors) }}
                </p>
              </div>
            </template>
          </renewForm.Field>

          <renewForm.Field name="grace_until">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  Grace until (optional)
                </Label>
                <Input
                  :id="field.name"
                  type="datetime-local"
                  :model-value="state.value"
                  class="font-mono"
                  :aria-invalid="state.meta.isTouched && !state.meta.isValid ? 'true' : undefined"
                  :aria-describedby="state.meta.isTouched && !state.meta.isValid ? `${field.name}-error` : undefined"
                  @update:model-value="(v: string | number) => field.handleChange(String(v))"
                  @blur="field.handleBlur"
                />
                <p
                  v-if="state.meta.isTouched && !state.meta.isValid"
                  :id="`${field.name}-error`"
                  class="text-xs text-destructive"
                  role="alert"
                >
                  {{ fieldErrors(state.meta.errors) }}
                </p>
              </div>
            </template>
          </renewForm.Field>

          <DialogFooter>
            <renewForm.Subscribe>
              <template #default="{ canSubmit, isSubmitting }">
                <Button
                  type="button"
                  variant="ghost"
                  :disabled="isSubmitting"
                  @click="renewOpen = false"
                >
                  Cancel
                </Button>
                <Button type="submit" :disabled="!canSubmit || isSubmitting">
                  {{ isSubmitting ? 'Working…' : 'Renew' }}
                </Button>
              </template>
            </renewForm.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
