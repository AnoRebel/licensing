<script setup lang="ts">
import type { NuxtError } from '#app';

defineProps<{ error: NuxtError }>();

// Swallow any deep app error up to the root. Specific 401 → sign-in routing
// is installed via a global fetch-error hook.
const handleRetry = () => reloadNuxtApp({ force: true });
</script>

<template>
  <main class="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 p-8 text-center">
    <h1 class="text-3xl font-semibold tracking-tight">Something went wrong</h1>
    <p class="text-muted-foreground">{{ error.statusCode }} — {{ error.message }}</p>
    <button
      type="button"
      class="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
      @click="handleRetry"
    >
      Reload
    </button>
  </main>
</template>
