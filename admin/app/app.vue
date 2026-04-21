<script setup lang="ts">
import { useVueSonner } from 'vue-sonner';

// Root shell. Every page renders through `<NuxtLayout>` so layouts can
// gate chrome around authenticated surfaces. The sign-in page opts out
// via `definePageMeta({ layout: false })` so its full-bleed centered form
// isn't wrapped in the admin topbar.

// ---- B18: per-type toast live-region mirror --------------------------------
//
// vue-sonner renders every toast inside a single <section aria-live="polite">.
// That's fine for "License suspended" / "Key rotated" (success), but it
// understates destructive failures — an error during `revoke` or
// `rotate-root` should interrupt the user's current SR utterance, not queue
// behind it. WCAG 4.1.3 Status Messages requires us to choose the assertion
// level that matches the content's urgency.
//
// vue-sonner doesn't expose a per-type aria-live override, so we add a
// parallel hidden live region that mirrors error + warning toasts with
// aria-live="assertive" (role=alert) while leaving the main sonner region
// polite. Success / info / loading / default stay in the polite section.
//
// The mirror only carries text for screen readers — visually it is
// `sr-only`, so sighted users still see the real sonner toast.
const { activeToasts } = useVueSonner();
const assertiveMessage = ref('');
const politeMessage = ref('');

// Latest assertive (error/warning) and polite (success/info) messages are
// stored independently. Clearing after a tick lets the same message
// re-announce if it fires twice in a row.
watch(
  () => activeToasts.value,
  (toasts) => {
    if (!toasts.length) return;
    const latest = toasts[toasts.length - 1];
    if (!latest || 'dismiss' in latest) return;

    const raw = typeof latest.title === 'string' ? latest.title : '';
    if (!raw) return;

    if (latest.type === 'error' || latest.type === 'warning') {
      assertiveMessage.value = '';
      nextTick(() => {
        assertiveMessage.value = raw;
      });
    } else if (latest.type === 'success' || latest.type === 'info') {
      politeMessage.value = '';
      nextTick(() => {
        politeMessage.value = raw;
      });
    }
  },
  { deep: true },
);
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <Toaster position="top-right" rich-colors close-button />
  <!-- B18 mirror regions. Visually hidden, read by screen readers. -->
  <div
    class="sr-only"
    role="alert"
    aria-live="assertive"
    aria-atomic="true"
  >
    {{ assertiveMessage }}
  </div>
  <div
    class="sr-only"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    {{ politeMessage }}
  </div>
</template>
