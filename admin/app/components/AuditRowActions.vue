<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';

type AuditEntry = components['schemas']['AuditEntry'];

/**
 * Per-row action cell for the audit log viewer. A single "View" button
 * opens the shared state-diff dialog on the parent page; confirmation
 * and dialog state live at that level so the prior/new state payload
 * and copy-to-clipboard affordance share one implementation.
 *
 * The button is only meaningful when at least one of prior_state /
 * new_state is present — otherwise the row has no additional payload
 * to surface.
 */
defineProps<{ entry: AuditEntry }>();
const emit = defineEmits<{ view: [] }>();
</script>

<template>
  <div class="flex justify-end">
    <Button
      v-if="entry.prior_state || entry.new_state"
      variant="ghost"
      size="sm"
      class="h-7 px-2 text-xs"
      @click.stop="emit('view')"
    >
      View
    </Button>
  </div>
</template>
