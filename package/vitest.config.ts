import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // Exclude auto-generated and declaration files; hand-written source lives
      // in __tests__/ only (Rust code is in crate/src/, not instrumented here).
      exclude: ['index.js', '**/*.d.ts', 'vitest.config.ts', 'node_modules/**'],
    },
  },
})
