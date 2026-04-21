<script setup lang="ts">
import { ref, watch } from 'vue';

/**
 * Typed-to-confirm guard for destructive ops (revoke, delete, rotate).
 *
 * Why:
 *   - Revoke is terminal. Delete is permanent. Rotate changes the active
 *     signing key. Operators should feel the keystrokes before the call
 *     goes out — a one-click "OK" is too cheap for actions this costly.
 *   - The confirm phrase is echoed from the subject (e.g., the license
 *     key or scope slug), so muscle-memory "yes yes yes" doesn't fire.
 *
 * UX:
 *   - Primary action is always labeled with a concrete verb (Revoke,
 *     Delete, Rotate) — never "Confirm".
 *   - The input auto-focuses on open, the primary button stays disabled
 *     until the phrase matches exactly (case-sensitive), and Escape or
 *     the Cancel button closes without firing.
 */
const props = defineProps<{
  open: boolean;
  title: string;
  description: string;
  /** The literal string the operator must type to unlock the action. */
  confirmPhrase: string;
  /** Button label for the destructive action (e.g., "Revoke license"). */
  actionLabel: string;
  /** Fires while the action is in-flight — used to disable the button. */
  pending?: boolean;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  confirm: [];
}>();

const typed = ref('');

// Reset the input each time the dialog opens — stale text from a prior
// cancel shouldn't pre-unlock the next open.
watch(
  () => props.open,
  (next) => {
    if (next) typed.value = '';
  },
);

function onOpenChange(next: boolean) {
  if (!next && props.pending) return; // don't allow close mid-flight
  emit('update:open', next);
}

function onConfirm() {
  if (typed.value !== props.confirmPhrase) return;
  emit('confirm');
}
</script>

<template>
  <AlertDialog :open="open" @update:open="onOpenChange">
    <AlertDialogContent class="sm:max-w-md">
      <AlertDialogHeader>
        <AlertDialogTitle>{{ title }}</AlertDialogTitle>
        <AlertDialogDescription>{{ description }}</AlertDialogDescription>
      </AlertDialogHeader>

      <div class="space-y-2">
        <Label for="confirm-phrase" class="text-xs font-normal text-muted-foreground">
          To confirm, type
          <span class="font-mono text-foreground">{{ confirmPhrase }}</span>
        </Label>
        <Input
          id="confirm-phrase"
          v-model="typed"
          autofocus
          autocomplete="off"
          spellcheck="false"
          autocapitalize="off"
          class="font-mono"
        />
      </div>

      <AlertDialogFooter>
        <AlertDialogCancel :disabled="pending">Cancel</AlertDialogCancel>
        <Button
          variant="destructive"
          :disabled="typed !== confirmPhrase || pending"
          @click="onConfirm"
        >
          {{ pending ? 'Working…' : actionLabel }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
