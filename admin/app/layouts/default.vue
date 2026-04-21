<script setup lang="ts">
/**
 * Authed shell. Lives only on pages that have passed auth.global.ts.
 * The sign-in page opts out with `definePageMeta({ layout: false })`.
 *
 * Intentionally sparse: a single top strip with the product mark on the
 * left, `operator` email + sign-out on the right. Per .impeccable.md the
 * chrome exists to be ignored — the data is the product.
 */
const { user } = useUserSession();
const signOut = useSignOut();
</script>

<template>
  <div class="min-h-dvh bg-background text-foreground">
    <header
      class="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <div class="mx-auto flex h-12 max-w-6xl items-center justify-between gap-4 px-4">
        <div class="flex items-center gap-6">
          <NuxtLink
            to="/"
            class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground"
          >
            licensing · admin
          </NuxtLink>
          <nav aria-label="Primary" class="hidden items-center gap-4 sm:flex">
            <NuxtLink
              v-for="item in [
                { to: '/licenses', label: 'licenses' },
                { to: '/scopes', label: 'scopes' },
                { to: '/keys', label: 'keys' },
                { to: '/templates', label: 'templates' },
                { to: '/usages', label: 'usages' },
                { to: '/audit', label: 'audit' },
              ]"
              :key="item.to"
              :to="item.to"
              active-class="text-foreground"
              class="font-mono text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground"
            >
              {{ item.label }}
            </NuxtLink>
          </nav>
        </div>
        <div class="flex items-center gap-3">
          <span
            v-if="user?.email"
            class="hidden font-mono text-xs text-muted-foreground sm:inline"
          >
            {{ user.email }}
          </span>
          <ColorModeToggle />
          <button
            type="button"
            class="inline-flex h-8 items-center rounded-md border border-input bg-background px-2.5 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            @click="signOut()"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
    <main class="mx-auto max-w-6xl px-4 py-8">
      <slot />
    </main>
  </div>
</template>
