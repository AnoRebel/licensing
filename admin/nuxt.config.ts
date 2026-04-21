import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';

// Resolve the repo-root openapi spec once so nuxt-open-fetch can regenerate
// typed composables whenever the yaml changes — no committed artefact, so
// no staleness check needed.
const OPENAPI_SPEC = fileURLToPath(new URL('../openapi/licensing-admin.yaml', import.meta.url));

// In production the session password MUST come from the environment.
// The dev placeholder below is only used when NODE_ENV != 'production';
// a Nitro plugin (server/plugins/require-session-password.ts) fails the
// server boot if the real secret is missing or too short. Keeping the
// check in a plugin means `nuxt prepare` / `nuxt build` still work in CI
// without the runtime secret — only `node .output/server/index.mjs`
// (the actual prod boot) needs it.
const sessionPassword = process.env.NUXT_SESSION_PASSWORD ?? 'dev_only_replace_in_prod_00000000';

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
    // must come from NUXT_SESSION_PASSWORD (>= 32 chars, server-only). We
    // throw at boot if it's missing in production (see above); the dev
    // placeholder is only used when NODE_ENV != 'production'.
    session: {
      password: sessionPassword,
      maxAge: 60 * 60 * 8, // 8h admin session; re-auth per working day.
      // Cookie attributes are a defence-in-depth pair with the proxy's
      // Origin/Sec-Fetch-Site check (server/api/proxy/[...].ts). SameSite
      // strict defeats cross-site form posts outright — the browser refuses
      // to attach the session cookie to a top-level navigation from another
      // origin, let alone a fetch. httpOnly keeps the cookie out of reach of
      // any XSS that slips past CSP. secure is dropped in dev only (http on
      // localhost); production builds must run behind TLS.
      cookie: {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
      },
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
