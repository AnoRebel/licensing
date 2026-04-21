import withNuxt from './.nuxt/eslint.config.mjs';

// @nuxt/eslint generates the full flat config from the project graph — we
// just forward it. Biome handles formatting repo-wide; ESLint is here for
// the Vue/Nuxt-specific lint rules Biome doesn't own.
export default withNuxt(
  // shadcn-vue primitives re-expose optional `class` / `variant` / `size`
  // props that are genuinely `undefined` by default and spread through
  // reka-ui / tailwind-variants. Forcing a default value would defeat the
  // pass-through. Scope the override narrowly to the generated primitives —
  // application components still have to declare defaults.
  {
    files: ['app/components/ui/**/*.vue'],
    rules: {
      'vue/require-default-prop': 'off',
    },
  },
);
