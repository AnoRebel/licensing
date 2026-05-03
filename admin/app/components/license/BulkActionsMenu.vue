<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';
import { computed, ref } from 'vue';
import { addDays, parseISO } from 'date-fns';
import { toast } from 'vue-sonner';
import ConfirmDestructive from '~/components/ConfirmDestructive.vue';

type License = components['schemas']['License'];

/**
 * Bulk-action menu for the licenses index. Shows a count, a dropdown
 * of actions, and routes each action through a confirmation dialog
 * naming the affected count before any POST goes out.
 *
 * Mixed-status selections are tolerated: each action defines its own
 * `applicable(license)` predicate and we partition the selection
 * client-side. The confirmation copy says "X of Y selected" so the
 * operator knows the action will skip the rest. After the dialog
 * confirms, we fan out parallel POSTs and tally success / failure.
 *
 * Actions:
 *   - Revoke           — applicable when status !== 'revoked'
 *   - Suspend          — applicable when status in [active, grace, expired]
 *   - Unsuspend        — applicable when status === 'suspended'
 *   - Extend expiry    — applicable when status !== 'revoked' AND
 *                        license.expires_at !== null. Adds N days to
 *                        the existing expiry.
 *
 * Each action that fires individual /admin/licenses/{id}/<verb> POSTs
 * relies on the backend to audit-log with `actor_kind: "admin"` and
 * the session's actor_id — the admin handlers already do this for
 * single-row actions, so no per-call body change is needed.
 */

interface Props {
  selected: License[];
}
const props = defineProps<Props>();
const emit = defineEmits<{ 'completed': [] }>();

const { $licensing } = useNuxtApp();

// --- Action definitions -----------------------------------------------
type Verb = 'revoke' | 'suspend' | 'resume';

interface ActionDef {
  id: 'revoke' | 'suspend' | 'unsuspend' | 'extend';
  label: string;
  destructive?: boolean;
  // Predicate filters the selected set; only matching rows get POSTed.
  applicable: (l: License) => boolean;
  // For lifecycle verbs that map directly onto a single endpoint.
  verb?: Verb;
}

const ACTIONS: readonly ActionDef[] = [
  {
    id: 'revoke',
    label: 'Revoke selected…',
    destructive: true,
    applicable: (l) => l.status !== 'revoked',
    verb: 'revoke',
  },
  {
    id: 'suspend',
    label: 'Suspend selected…',
    applicable: (l) => l.status === 'active' || l.status === 'grace' || l.status === 'expired',
    verb: 'suspend',
  },
  {
    id: 'unsuspend',
    label: 'Unsuspend selected…',
    applicable: (l) => l.status === 'suspended',
    verb: 'resume',
  },
  {
    id: 'extend',
    label: 'Extend expiry by N days…',
    applicable: (l) => l.status !== 'revoked' && l.expires_at !== null,
  },
];

// --- Dialog plumbing --------------------------------------------------
const pendingActionId = ref<ActionDef['id'] | null>(null);
const pendingAction = computed<ActionDef | null>(
  () => ACTIONS.find((a) => a.id === pendingActionId.value) ?? null,
);
const applicable = computed<License[]>(() =>
  pendingAction.value ? props.selected.filter(pendingAction.value.applicable) : [],
);

const confirmOpen = ref(false);
const extendOpen = ref(false);
const actionPending = ref(false);

// "Extend expiry" picks up its own value via a small numeric input.
const extendDays = ref(30);

function openAction(id: ActionDef['id']) {
  pendingActionId.value = id;
  if (id === 'extend') {
    extendDays.value = 30;
    extendOpen.value = true;
  } else {
    confirmOpen.value = true;
  }
}

// --- Execution --------------------------------------------------------
async function runLifecycleVerb(verb: Verb) {
  const targets = applicable.value;
  if (targets.length === 0) return;
  actionPending.value = true;
  let succeeded = 0;
  const failures: string[] = [];
  await Promise.all(
    targets.map(async (lic) => {
      try {
        await $licensing(`/admin/licenses/{id}/${verb}` as '/admin/licenses/{id}/revoke', {
          method: 'POST',
          path: { id: lic.id },
        });
        succeeded++;
      } catch (e) {
        failures.push(failureMessage(lic, e));
      }
    }),
  );
  finishAction({ verb, succeeded, failures });
}

async function runExtend() {
  const targets = applicable.value;
  if (targets.length === 0) return;
  const days = Math.max(1, Math.floor(extendDays.value));
  actionPending.value = true;
  let succeeded = 0;
  const failures: string[] = [];
  await Promise.all(
    targets.map(async (lic) => {
      try {
        const current = lic.expires_at;
        if (!current) {
          // Filtered out by the predicate already; defensive guard.
          throw new Error('license has no expires_at');
        }
        const next = addDays(parseISO(current), days).toISOString();
        await $licensing('/admin/licenses/{id}/renew', {
          method: 'POST',
          path: { id: lic.id },
          body: { expires_at: next },
        });
        succeeded++;
      } catch (e) {
        failures.push(failureMessage(lic, e));
      }
    }),
  );
  finishAction({ verb: 'extend', succeeded, failures, days });
}

function finishAction(result: {
  verb: Verb | 'extend';
  succeeded: number;
  failures: string[];
  days?: number;
}) {
  actionPending.value = false;
  confirmOpen.value = false;
  extendOpen.value = false;
  pendingActionId.value = null;
  if (result.succeeded > 0) {
    const what =
      result.verb === 'extend'
        ? `extended ${result.succeeded} licenses by ${result.days}d`
        : `${result.verb}d ${result.succeeded} licenses`;
    toast.success(what);
  }
  if (result.failures.length > 0) {
    toast.error(`${result.failures.length} failures: ${result.failures.slice(0, 3).join(', ')}`);
  }
  emit('completed');
}

interface FetchErrorLike {
  data?: { error?: { message?: string }; message?: string };
  message?: string;
}
function failureMessage(lic: License, err: unknown): string {
  const e = err as FetchErrorLike;
  const msg = e?.data?.error?.message ?? e?.data?.message ?? e?.message;
  return `${lic.license_key.slice(0, 12)}: ${typeof msg === 'string' ? msg : 'failed'}`;
}

function onConfirm() {
  if (!pendingAction.value) return;
  if (pendingAction.value.verb) runLifecycleVerb(pendingAction.value.verb);
}

// --- Confirmation copy -------------------------------------------------
const confirmCopy = computed(() => {
  if (!pendingAction.value) return null;
  const total = props.selected.length;
  const apply = applicable.value.length;
  const skipped = total - apply;
  const verbLabel: Record<Verb, string> = {
    revoke: 'Revoke',
    suspend: 'Suspend',
    resume: 'Unsuspend',
  };
  const label = pendingAction.value.verb ? verbLabel[pendingAction.value.verb] : 'Action';
  const description =
    skipped > 0
      ? `${apply} of ${total} selected licenses will be ${label.toLowerCase()}d. ${skipped} are not eligible and will be skipped.`
      : `All ${apply} selected licenses will be ${label.toLowerCase()}d.`;
  return {
    title: `${label} ${apply} license${apply === 1 ? '' : 's'}`,
    description,
    actionLabel: `${label} ${apply} license${apply === 1 ? '' : 's'}`,
    confirmPhrase: `${label.toLowerCase()} ${apply}`,
  };
});
</script>

<template>
  <div class="flex items-center gap-2">
    <p
      class="font-mono text-xs text-muted-foreground tabular-nums"
      role="status"
      aria-live="polite"
    >
      {{ selected.length }} selected
    </p>
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="outline" size="sm" :disabled="selected.length === 0">
          Bulk actions
          <span aria-hidden="true" class="ml-1 text-muted-foreground">⌄</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-56">
        <DropdownMenuItem
          v-for="action in ACTIONS"
          :key="action.id"
          :class="action.destructive ? 'text-destructive focus:text-destructive' : undefined"
          @select="openAction(action.id)"
        >
          {{ action.label }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <!--
      Lifecycle confirmations (revoke / suspend / unsuspend). The
      confirm phrase is `"<verb> <count>"` so the operator's keystrokes
      reflect both the action AND the scale — pasting a stale phrase
      from a previous selection won't unlock the wrong batch.
    -->
    <ConfirmDestructive
      v-if="pendingAction && pendingAction.id !== 'extend' && confirmCopy"
      v-model:open="confirmOpen"
      :title="confirmCopy.title"
      :description="confirmCopy.description"
      :confirm-phrase="confirmCopy.confirmPhrase"
      :action-label="confirmCopy.actionLabel"
      :pending="actionPending"
      @confirm="onConfirm"
    />

    <!--
      Extend-by-N dialog. Numeric input is bounded [1, 365] — anything
      outside that is overwhelmingly likely to be a typo (we'd rather
      reject than silently apply a multi-year extension).
    -->
    <Dialog v-model:open="extendOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Extend expiry by N days ({{ applicable.length }} of {{ selected.length }})
          </DialogTitle>
          <DialogDescription>
            Each eligible license's <code>expires_at</code> is shifted forward by the chosen
            number of days. Licenses without an <code>expires_at</code> or already revoked
            are skipped.
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-2">
          <Label for="extend-days" class="text-xs font-normal text-muted-foreground">
            Days
          </Label>
          <Input
            id="extend-days"
            v-model="extendDays"
            type="number"
            inputmode="numeric"
            min="1"
            max="365"
            class="font-mono"
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            :disabled="actionPending"
            @click="extendOpen = false"
          >
            Cancel
          </Button>
          <Button
            type="button"
            :disabled="actionPending || extendDays < 1 || extendDays > 365"
            @click="runExtend"
          >
            {{ actionPending ? 'Working…' : `Extend ${applicable.length}` }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
