<script setup lang="ts">
import { useForm } from '@tanstack/vue-form';
import { SignInSchema } from '~~/shared/schemas/auth';

definePageMeta({
  // Page is reachable pre-auth; auth.global.ts short-circuits for it.
  layout: false,
});

useHead({ title: 'Sign in — Licensing Admin' });

const route = useRoute();
const { fetch: refreshSession } = useUserSession();

const submitError = ref<string | null>(null);

// TanStack Form's `meta.errors` is a loosely-typed array of whatever the
// validator returned — with standard-schema validators it's usually
// `{ message: string }`, but it can also be a raw string or undefined.
// Normalise to a single user-facing line.
function fieldErrors(errors: readonly unknown[]): string {
  return errors
    .map((err) => {
      if (!err) return '';
      if (typeof err === 'string') return err;
      if (typeof err === 'object' && 'message' in err) {
        const m = (err as { message?: unknown }).message;
        return typeof m === 'string' ? m : '';
      }
      return '';
    })
    .filter(Boolean)
    .join(' · ');
}

const form = useForm({
  defaultValues: { token: '' },
  // valibot schema implements Standard Schema — TanStack Form picks up
  // field-by-field issues without any adapter.
  validators: { onChange: SignInSchema },
  onSubmit: async ({ value }) => {
    submitError.value = null;
    try {
      await $fetch('/api/auth/sign-in', {
        method: 'POST',
        body: { token: value.token.trim() },
      });
      // Re-read the session so middleware sees loggedIn=true on navigate.
      await refreshSession();
      const next = typeof route.query.next === 'string' ? route.query.next : '/';
      // Guard against open-redirects by only honouring same-origin paths.
      const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
      await navigateTo(safeNext, { replace: true });
    } catch (err: unknown) {
      const data = (err as { data?: { error?: { message?: string } }; statusMessage?: string })
        ?.data;
      submitError.value =
        data?.error?.message ??
        (err as { statusMessage?: string }).statusMessage ??
        'Sign-in failed. Please try again.';
    }
  },
});
</script>

<template>
  <main
    class="min-h-dvh grid place-items-center bg-background text-foreground px-4 py-12"
  >
    <div class="w-full max-w-sm">
      <header class="mb-8 space-y-2">
        <p class="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          licensing · admin
        </p>
        <h1 class="text-2xl font-semibold tracking-tight">
          Sign in
        </h1>
        <p class="text-sm text-muted-foreground">
          Paste the bearer token provisioned by your licensing issuer. It's sealed
          into an httpOnly cookie — never stored in the browser.
        </p>
      </header>

      <form
        novalidate
        class="space-y-4"
        @submit.prevent.stop="form.handleSubmit()"
      >
        <form.Field name="token">
          <template #default="{ field, state }">
            <div class="space-y-1.5">
              <label
                :for="field.name"
                class="block text-sm font-medium"
              >
                Bearer token
              </label>
              <textarea
                :id="field.name"
                :name="field.name"
                :value="field.state.value"
                rows="3"
                autocomplete="off"
                spellcheck="false"
                autocorrect="off"
                autocapitalize="off"
                :aria-invalid="state.meta.isTouched && !state.meta.isValid ? 'true' : undefined"
                :aria-describedby="state.meta.isTouched && !state.meta.isValid ? `${field.name}-error` : undefined"
                class="block w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm leading-5 shadow-sm outline-none ring-0 transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/30"
                placeholder="eyJ... or lic_..."
                @input="(e: Event) => field.handleChange((e.target as HTMLTextAreaElement).value)"
                @blur="field.handleBlur"
              />
              <p
                v-if="state.meta.isTouched && !state.meta.isValid"
                :id="`${field.name}-error`"
                class="text-xs text-destructive"
                role="alert"
              >
                {{ fieldErrors(state.meta.errors) }}
              </p>
            </div>
          </template>
        </form.Field>

        <p
          v-if="submitError"
          class="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {{ submitError }}
        </p>

        <form.Subscribe>
          <template #default="{ canSubmit, isSubmitting }">
            <button
              type="submit"
              :disabled="!canSubmit"
              class="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50"
            >
              {{ isSubmitting ? 'Signing in…' : 'Sign in' }}
            </button>
          </template>
        </form.Subscribe>
      </form>

      <p class="mt-8 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
        session · 8 hours · sealed cookie
      </p>
    </div>
  </main>
</template>
