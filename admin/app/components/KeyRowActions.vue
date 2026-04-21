<script setup lang="ts">
import type { components } from '#open-fetch-schemas/licensing';

type Key = components['schemas']['Key'];

/**
 * Per-row action cell for the signing-keys table. Only active keys can
 * be rotated — a retiring key is already on its way out, and rotating it
 * again would be a no-op (and confusing to the operator).
 *
 * `keyRow` rather than `key` because `key` shadows the Vue `key` prop.
 */
defineProps<{ keyRow: Key }>();
const emit = defineEmits<{ rotate: [] }>();
</script>

<template>
  <div class="flex justify-end">
    <Button
      v-if="keyRow.state === 'active'"
      variant="ghost"
      size="sm"
      class="h-7 px-2 text-xs"
      @click.stop="emit('rotate')"
    >
      Rotate…
    </Button>
  </div>
</template>
