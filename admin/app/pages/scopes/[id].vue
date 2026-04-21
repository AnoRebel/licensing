<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';
import { computed, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { useForm } from '@tanstack/vue-form';
import * as v from 'valibot';
import ConfirmDestructive from '~/components/ConfirmDestructive.vue';
import { formatAbsolute, formatRelative } from '~/lib/datetime';
import { keyColumns, type KeyTableMeta } from './key-columns';

type Scope = components['schemas']['Scope'];
type Key = components['schemas']['Key'];
type KeyAlg = components['schemas']['KeyAlg'];

/**
 * Scope detail — three stacked concerns:
 *   1. Edit form for mutable fields (`name`; slug is immutable).
 *   2. Destructive Delete (gated by ConfirmDestructive, typed slug).
 *   3. Signing keys scoped to this scope, with:
 *        - a "New key" dialog (alg + role + optional windowing)
 *        - a per-row Rotate (gated by ConfirmDestructive — rotating an
 *          active key immediately changes what the server signs with)
 *        - the rotate response reveals the new (successor) kid in a
 *          banner so operators can cross-check deployments.
 *
 * Shared ConfirmDestructive is reused via an `action` discriminant like
 * the license detail page.
 */

useHead({ title: 'Scope — Licensing Admin' });

const route = useRoute();
const router = useRouter();
const scopeId = computed(() => route.params.id as string);

const { $licensing } = useNuxtApp();

// --- Scope fetch --------------------------------------------------------
const {
  data: scopeData,
  pending: scopePending,
  error: scopeError,
  refresh: refreshScope,
} = await useLicensing('/admin/scopes/{id}', {
  path: { id: scopeId.value },
  key: `admin-scope-${scopeId.value}`,
});

const scope = computed<Scope | undefined>(() => scopeData.value?.data);

// --- Keys for this scope ------------------------------------------------
const keysQuery = computed(() => ({ scope_id: scopeId.value, limit: 50 }));
const {
  data: keysData,
  pending: keysPending,
  error: keysError,
  refresh: refreshKeys,
} = await useLicensing('/admin/keys', {
  query: keysQuery,
  key: `admin-scope-${scopeId.value}-keys`,
  watch: [keysQuery],
});

const keys = computed<Key[]>(() => keysData.value?.data?.items ?? []);

// --- Edit form ----------------------------------------------------------
const EditSchema = v.object({
  name: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty('Required'),
    v.maxLength(128, 'At most 128 characters'),
  ),
});

function validateEditScope(value: { name: string }) {
  const res = v.safeParse(EditSchema, value);
  if (!res.success) return 'Fix the highlighted fields';
  return undefined;
}

const editForm = useForm({
  defaultValues: { name: '' },
  validators: {
    onChange: ({ value }) => validateEditScope(value),
    onSubmit: ({ value }) => validateEditScope(value),
  },
  onSubmit: async ({ value }) => {
    try {
      await $licensing('/admin/scopes/{id}', {
        method: 'PATCH',
        path: { id: scopeId.value },
        body: { name: value.name.trim() },
      });
      toast.success('Scope updated');
      await refreshScope();
    } catch (e) {
      toast.error(errorMessage(e, 'Could not update scope'));
    }
  },
});

// When the underlying scope loads (or refetches), sync the form's default
// so the input reflects server state without clobbering an in-flight edit.
// `state.isSubmitting` is the reactive source of truth while the PATCH
// is in flight.
watch(
  scope,
  (next) => {
    if (next && !editForm.state.isSubmitting) {
      editForm.setFieldValue('name', next.name);
    }
  },
  { immediate: true },
);

// --- Destructive actions ------------------------------------------------
type PendingAction = { kind: 'delete-scope' } | { kind: 'rotate-key'; key: Key } | null;

const action = ref<PendingAction>(null);
const actionPending = ref(false);
const confirmOpen = ref(false);

// Most-recent rotation result — surfaced as a banner so operators have
// visual confirmation of the successor kid.
const lastRotation = ref<{ retiring: Key; active: Key } | null>(null);

function openConfirmDelete() {
  if (!scope.value) return;
  action.value = { kind: 'delete-scope' };
  confirmOpen.value = true;
}

function openConfirmRotate(key: Key) {
  action.value = { kind: 'rotate-key', key };
  confirmOpen.value = true;
}

async function onConfirm() {
  if (!action.value) return;
  actionPending.value = true;
  try {
    if (action.value.kind === 'delete-scope') {
      await $licensing('/admin/scopes/{id}', {
        method: 'DELETE',
        path: { id: scopeId.value },
      });
      toast.success('Scope deleted');
      confirmOpen.value = false;
      action.value = null;
      router.push('/scopes');
      return;
    }
    if (action.value.kind === 'rotate-key') {
      const keyId = action.value.key.id;
      const res = await $licensing('/admin/keys/{id}/rotate', {
        method: 'POST',
        path: { id: keyId },
      });
      const pair = res?.data;
      if (pair) lastRotation.value = pair;
      toast.success('Key rotated');
      await refreshKeys();
    }
    confirmOpen.value = false;
    action.value = null;
  } catch (e) {
    toast.error(errorMessage(e, 'Action failed'));
  } finally {
    actionPending.value = false;
  }
}

const confirmConfig = computed(() => {
  if (!action.value) return null;
  if (action.value.kind === 'delete-scope' && scope.value) {
    return {
      title: 'Delete scope',
      description:
        'Hard-deletes the scope. Fails with 409 if any licenses or templates still reference it — revoke or reassign those first. Audit rows are preserved.',
      confirmPhrase: scope.value.slug,
      actionLabel: 'Delete scope',
    };
  }
  if (action.value.kind === 'rotate-key') {
    return {
      title: 'Rotate signing key',
      description:
        'Provisions a successor key and marks this one `retiring`. Existing tokens keep verifying against the retiring key until it expires; new tokens are signed with the successor from this moment forward.',
      confirmPhrase: action.value.key.kid,
      actionLabel: 'Rotate key',
    };
  }
  return null;
});

// --- Create key dialog --------------------------------------------------
const createKeyOpen = ref(false);

const KeyAlgValues: KeyAlg[] = ['ed25519', 'rs256-pss', 'hs256'];
const KidRe = /^[a-z0-9][a-z0-9._-]*$/i;

const CreateKeySchema = v.object({
  kid: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty('Required'),
    v.regex(KidRe, 'Letters, digits, dot, hyphen, underscore; must start with alnum'),
    v.maxLength(64, 'At most 64 characters'),
  ),
  alg: v.picklist(['ed25519', 'rs256-pss', 'hs256']),
  role: v.picklist(['signing', 'root']),
});

function validateCreateKey(value: { kid: string; alg: KeyAlg; role: 'signing' | 'root' }) {
  const res = v.safeParse(CreateKeySchema, value);
  if (!res.success) return 'Fix the highlighted fields';
  return undefined;
}

const createKeyForm = useForm({
  defaultValues: {
    kid: '',
    alg: 'ed25519' as KeyAlg,
    role: 'signing' as 'signing' | 'root',
  },
  validators: {
    onChange: ({ value }) => validateCreateKey(value),
    onSubmit: ({ value }) => validateCreateKey(value),
  },
  onSubmit: async ({ value }) => {
    try {
      await $licensing('/admin/keys', {
        method: 'POST',
        body: {
          scope_id: scopeId.value,
          kid: value.kid.trim(),
          alg: value.alg,
          role: value.role,
        },
      });
      toast.success('Signing key created');
      createKeyOpen.value = false;
      createKeyForm.reset();
      await refreshKeys();
    } catch (e) {
      toast.error(errorMessage(e, 'Could not create key'));
    }
  },
});

// --- Helpers -----------------------------------------------------------
interface FetchErrorLike {
  status?: number;
  data?: { error?: { code?: string; message?: string }; message?: string };
  message?: string;
}
function errorMessage(err: unknown, fallback: string): string {
  const e = err as FetchErrorLike;
  const msg = e?.data?.error?.message ?? e?.data?.message ?? e?.message;
  return typeof msg === 'string' && msg ? msg : fallback;
}

async function copySlug() {
  if (!scope.value) return;
  try {
    await navigator.clipboard.writeText(scope.value.slug);
    toast.success('Slug copied');
  } catch {
    toast.error('Could not copy — try selecting manually');
  }
}

const scopeErrorMessage = computed(() =>
  scopeError.value ? 'Could not load scope. Check the upstream API.' : null,
);

const keyTableMeta = computed<KeyTableMeta>(() => ({
  onRotate: (key: Key) => openConfirmRotate(key),
}));
</script>

<template>
  <div class="space-y-8">
    <NuxtLink
      to="/scopes"
      class="inline-flex items-center gap-1 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-foreground"
    >
      ← back to scopes
    </NuxtLink>

    <p v-if="scopeErrorMessage" role="alert" class="text-sm text-destructive">
      {{ scopeErrorMessage }}
    </p>

    <section v-else-if="scopePending && !scope" aria-busy="true" class="space-y-4">
      <Skeleton class="h-8 w-72" />
      <Skeleton class="h-32 w-full" />
    </section>

    <template v-else-if="scope">
      <header class="space-y-4">
        <div class="space-y-2">
          <p class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
            scope
          </p>
          <div class="flex flex-wrap items-center gap-3">
            <code
              class="rounded-sm border border-border bg-muted/30 px-2 py-1 font-mono text-sm"
              :title="scope.slug"
            >
              {{ scope.slug }}
            </code>
            <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="copySlug">
              Copy
            </Button>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            class="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            :disabled="actionPending"
            @click="openConfirmDelete"
          >
            Delete…
          </Button>
          <Button variant="ghost" size="sm" :disabled="scopePending" @click="refreshScope()">
            Refresh
          </Button>
        </div>
      </header>

      <!-- Edit form -->
      <section
        aria-label="Scope metadata"
        class="rounded-md border border-border bg-card p-4"
      >
        <form class="space-y-4" @submit.prevent.stop="editForm.handleSubmit()">
          <editForm.Field name="name">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  Name
                </Label>
                <Input
                  :id="field.name"
                  :model-value="state.value"
                  required
                  @update:model-value="(v: string | number) => field.handleChange(String(v))"
                  @blur="field.handleBlur"
                />
                <p v-if="state.meta.errors.length" class="text-xs text-destructive">
                  {{ state.meta.errors.join(', ') }}
                </p>
              </div>
            </template>
          </editForm.Field>

          <div class="grid grid-cols-1 gap-x-8 gap-y-2 font-mono text-xs sm:grid-cols-2">
            <div class="space-y-1">
              <p class="uppercase tracking-wide text-muted-foreground">id</p>
              <p class="break-all">{{ scope.id }}</p>
            </div>
            <div class="space-y-1">
              <p class="uppercase tracking-wide text-muted-foreground">slug</p>
              <p>{{ scope.slug }}</p>
            </div>
            <div class="space-y-1">
              <p class="uppercase tracking-wide text-muted-foreground">created</p>
              <time :datetime="scope.created_at" :title="formatAbsolute(scope.created_at)">
                {{ formatRelative(scope.created_at) }}
              </time>
            </div>
            <div class="space-y-1">
              <p class="uppercase tracking-wide text-muted-foreground">updated</p>
              <time :datetime="scope.updated_at" :title="formatAbsolute(scope.updated_at)">
                {{ formatRelative(scope.updated_at) }}
              </time>
            </div>
          </div>

          <div class="flex justify-end">
            <editForm.Subscribe>
              <template #default="{ canSubmit, isSubmitting }">
                <Button type="submit" size="sm" :disabled="!canSubmit || isSubmitting">
                  {{ isSubmitting ? 'Saving…' : 'Save changes' }}
                </Button>
              </template>
            </editForm.Subscribe>
          </div>
        </form>
      </section>

      <!-- Rotation banner -->
      <section
        v-if="lastRotation"
        role="status"
        class="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-xs"
      >
        <p class="font-mono uppercase tracking-wide text-amber-600 dark:text-amber-400">
          rotation complete
        </p>
        <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <p class="text-muted-foreground">retiring kid</p>
            <code class="font-mono">{{ lastRotation.retiring.kid }}</code>
          </div>
          <div>
            <p class="text-muted-foreground">new active kid</p>
            <code class="font-mono">{{ lastRotation.active.kid }}</code>
          </div>
        </div>
        <div class="mt-3 flex justify-end">
          <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="lastRotation = null">
            Dismiss
          </Button>
        </div>
      </section>

      <!-- Signing keys -->
      <section class="space-y-4" aria-label="Signing keys">
        <div class="flex items-baseline justify-between">
          <h2 class="text-sm font-semibold tracking-tight">
            Signing keys
            <span class="ml-2 font-mono text-xs font-normal text-muted-foreground">
              {{ keys.length }}
            </span>
          </h2>
          <div class="flex items-center gap-2">
            <Button variant="ghost" size="sm" :disabled="keysPending" @click="refreshKeys()">
              Refresh
            </Button>
            <Button size="sm" @click="createKeyOpen = true">New key</Button>
          </div>
        </div>

        <p v-if="keysError" role="alert" class="text-sm text-destructive">
          Could not load keys.
        </p>

        <DataTable
          v-else
          :columns="keyColumns"
          :data="keys"
          :loading="keysPending"
          :toolbar="false"
          :meta="keyTableMeta"
          empty-message="No signing keys for this scope yet."
        />
      </section>
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

    <!-- New key dialog -->
    <Dialog v-model:open="createKeyOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New signing key</DialogTitle>
          <DialogDescription>
            Provisions a new signing key bound to this scope. The server generates the
            keypair and stores the private half in the KMS — only the public PEM is
            returned to clients. <code>kid</code> is the identifier that appears in LIC1
            token headers; keep it short and stable.
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent.stop="createKeyForm.handleSubmit()">
          <createKeyForm.Field name="kid">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  kid
                </Label>
                <Input
                  :id="field.name"
                  :model-value="state.value"
                  class="font-mono"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="acme-prod-2026-04"
                  required
                  @update:model-value="(v: string | number) => field.handleChange(String(v))"
                  @blur="field.handleBlur"
                />
                <p v-if="state.meta.errors.length" class="text-xs text-destructive">
                  {{ state.meta.errors.join(', ') }}
                </p>
              </div>
            </template>
          </createKeyForm.Field>

          <createKeyForm.Field name="alg">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  Algorithm
                </Label>
                <select
                  :id="field.name"
                  :value="state.value"
                  class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  @change="(e) => field.handleChange((e.target as HTMLSelectElement).value as KeyAlg)"
                >
                  <option v-for="a in KeyAlgValues" :key="a" :value="a">{{ a }}</option>
                </select>
              </div>
            </template>
          </createKeyForm.Field>

          <createKeyForm.Field name="role">
            <template #default="{ field, state }">
              <div class="space-y-1.5">
                <Label :for="field.name" class="text-xs font-normal text-muted-foreground">
                  Role
                </Label>
                <select
                  :id="field.name"
                  :value="state.value"
                  class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  @change="(e) => field.handleChange((e.target as HTMLSelectElement).value as 'signing' | 'root')"
                >
                  <option value="signing">signing</option>
                  <option value="root">root</option>
                </select>
                <p class="text-xs text-muted-foreground">
                  <code>signing</code> keys issue license tokens.
                  <code>root</code> keys sign the signing-key manifest — rarely rotated.
                </p>
              </div>
            </template>
          </createKeyForm.Field>

          <DialogFooter>
            <createKeyForm.Subscribe>
              <template #default="{ canSubmit, isSubmitting }">
                <Button
                  type="button"
                  variant="ghost"
                  :disabled="isSubmitting"
                  @click="createKeyOpen = false"
                >
                  Cancel
                </Button>
                <Button type="submit" :disabled="!canSubmit || isSubmitting">
                  {{ isSubmitting ? 'Working…' : 'Create key' }}
                </Button>
              </template>
            </createKeyForm.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
