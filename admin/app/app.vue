<script setup lang="ts">
// Root shell. Every page renders through `<NuxtLayout>` so layouts can
// gate chrome around authenticated surfaces. The sign-in page opts out
// via `definePageMeta({ layout: false })` so its full-bleed centered form
// isn't wrapped in the admin topbar.
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <Toaster position="top-right" rich-colors close-button />
</template>
