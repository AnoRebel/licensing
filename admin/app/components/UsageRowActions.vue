<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';

type Usage = components['schemas']['Usage'];

/**
 * Per-row action cell for the embedded usages table. Only renders a
 * "Revoke" button for active usages — already-revoked rows show nothing
 * because revoking again is a no-op at the API layer and would just be
 * noise in the UI.
 *
 * Confirmation is NOT handled here — the parent page owns the shared
 * ConfirmDestructive dialog (one instance, many triggers) so that the
 * dialog's state, typed phrase, and pending flag live alongside the
 * mutation call site.
 */
defineProps<{ usage: Usage }>();
const emit = defineEmits<{ revoke: [] }>();
</script>

<template>
  <div class="flex justify-end">
    <Button
      v-if="usage.status === 'active'"
      variant="ghost"
      size="sm"
      class="h-7 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
      @click.stop="emit('revoke')"
    >
      Revoke
    </Button>
  </div>
</template>
