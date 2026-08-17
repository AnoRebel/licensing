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

  // Cabinet Grotesk is self-hosted under `public/fonts/` so the build
  // never needs to reach Fontshare — CI runners hit transient TLS / DNS
  // flakes against `cdn.fontshare.com` that fail `nuxt build` with the
  // unhelpful `[nuxt:fonts:font-family-injection] fetch failed`.
  //
  // The `local` provider scans Nitro's publicAssets directories and
  // matches filenames of the form `<family-slug>-<weight>.<ext>`. The
  // four files at `public/fonts/cabinet-grotesk-{400,500,700,800}.woff2`
  // resolve to `font-family: 'Cabinet Grotesk'` at the corresponding
  // numeric weights — no manifest needed.
  //
  // JetBrains Mono is self-hosted for the same reason. Google rotated the
  // v24 asset hashes and now serves the family as a single variable font,
  // so the previously pinned per-weight URLs return 404 and fail the build
  // outright.
  //
  // The checked-in files are the `latin` subset of that variable font
  // (wght axis 400-800). The three files are byte-identical: the `local`
  // provider derives weight from the *filename*, and only emits @font-face
  // rules for weights it can match, so a single `-400` file would silently
  // drop 500/600 to the Courier New fallback. One file per shipped weight
  // is what makes all three resolve. 96KB total on disk.
  //
  // Inter is explicitly banned by .impeccable.md.
  fonts: {
    families: [
      { name: 'Cabinet Grotesk', provider: 'local', weights: [400, 500, 700, 800] },
      { name: 'JetBrains Mono', provider: 'local', weights: [400, 500, 600] },
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
        // `baseURL` MUST live here, not in `runtimeConfig.public.openFetch`:
        // the module overwrites that key wholesale from `clients` at build
        // time, so anything set there is silently dropped. Without it the
        // client has no base, and during SSR `/admin/scopes` is resolved as
        // a Vue Router path ("No match found for location") instead of an
        // HTTP call — every list view then server-renders its error state.
        baseURL: '/api/proxy',
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
    // NOTE: `public.openFetch` is deliberately absent. nuxt-open-fetch
    // rebuilds that key from `openFetch.clients` during module setup, so
    // declaring it here has no effect — the client `baseURL` lives in the
    // `openFetch.clients.licensing` block above.
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
