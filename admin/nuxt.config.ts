import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';

// Resolve the repo-root openapi spec once so nuxt-open-fetch can regenerate
// typed composables whenever the yaml changes — no committed artefact, so
// no staleness check needed.
const OPENAPI_SPEC = fileURLToPath(new URL('../openapi/licensing-admin.yaml', import.meta.url));

export default defineNuxtConfig({
  // Cut against 2026-04 — pins Nitro/Nuxt feature defaults so CI behaviour is
  // reproducible regardless of when `bun install` runs.
  compatibilityDate: '2026-04-18',

  future: {
    // Opt into Nuxt v5 defaults early (Vite Environment API etc.). See
    // https://nuxt.com/docs/4.x/guide/going-further/features
    compatibilityVersion: 5,
  },

  devtools: { enabled: true },

  modules: [
    '@nuxt/eslint',
    '@nuxt/fonts',
    '@nuxtjs/color-mode',
    '@vueuse/motion/nuxt',
    '@vueuse/nuxt',
    'nuxt-auth-utils',
    'nuxt-open-fetch',
    'shadcn-nuxt',
  ],

  // @nuxt/fonts downloads + self-hosts. Cabinet Grotesk (sans, via
  // Fontshare) + JetBrains Mono (numerics, via Google Fonts) — the blessed
  // technical-UI pair from design-taste-frontend. Inter is explicitly
  // banned by .impeccable.md.
  fonts: {
    families: [
      { name: 'Cabinet Grotesk', provider: 'fontshare', weights: [400, 500, 700, 800] },
      { name: 'JetBrains Mono', provider: 'google', weights: [400, 500, 600] },
    ],
  },

  // shadcn-vue needs `.dark` / `.light` on <html> (Tailwind v4's
  // @custom-variant dark hooks `.dark`). classSuffix:'' strips the default
  // '-mode' suffix so the classnames line up.
  colorMode: {
    classSuffix: '',
    preference: 'system',
    fallback: 'light',
    storageKey: 'licensing-admin-color-mode',
  },

  // `~~` is the root alias; `~` points at `app/` under Nuxt 4's new layout.
  // Tailwind entrypoint lives at admin/assets/css/tailwind.css (shared
  // between app + server), hence the double-tilde.
  css: ['~~/assets/css/tailwind.css'],

  vite: {
    plugins: [tailwindcss()],
  },

  shadcn: {
    // Empty prefix — component imports read as `<Button>` not `<UiButton>`.
    prefix: '',
    componentDir: './app/components/ui',
  },

  openFetch: {
    // One generated client per upstream. Pointed at the committed yaml so
    // the types always track whatever the Go + TS handlers claim to expose.
    clients: {
      licensing: {
        schema: OPENAPI_SPEC,
      },
    },
  },

  runtimeConfig: {
    // Server-only: upstream API base + bearer token proxy target. The
    // browser never sees either — all licensing traffic goes through
    // /api/proxy/* (server/api/proxy/[...].ts, landing at 13.3) which
    // reads session.secure.apiToken from the sealed cookie and forwards.
    upstreamBaseUrl:
      process.env.LICENSING_UPSTREAM_BASE_URL ?? 'http://127.0.0.1:8787/api/licensing/v1',
    // nuxt-auth-utils session config. `password` is REQUIRED — in prod it
    // must come from NUXT_SESSION_PASSWORD (>= 32 chars, server-only).
    // The placeholder below is dev-only; nuxt-auth-utils will refuse to
    // boot without an override in production. Never commit a real secret.
    session: {
      password: process.env.NUXT_SESSION_PASSWORD ?? 'dev_only_replace_in_prod_00000000',
      maxAge: 60 * 60 * 8, // 8h admin session; re-auth per working day.
    },
    public: {
      openFetch: {
        licensing: {
          // Points the generated `useLicensing()` composable at our
          // server-side proxy. The upstream URL stays private.
          baseURL: '/api/proxy',
        },
      },
    },
  },

  typescript: {
    strict: true,
    typeCheck: false,
  },

  app: {
    head: {
      title: 'Licensing Admin',
      htmlAttrs: { lang: 'en' },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Licensing administration console' },
      ],
    },
  },
});
