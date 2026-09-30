import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Vite transforms the TSX with esbuild; without this the automatic JSX runtime
  // is not applied and every component fails with "React is not defined".
  esbuild: { jsx: 'automatic' },
  test: {
    // The component suite selects jsdom for itself with a
    // `@vitest-environment` docblock, so the pure-function suites stay
    // DOM-free and fast.
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
  },
})
