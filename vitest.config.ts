import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests only. Integration tests live under test/integration/ and run
    // via vitest.integration.config.ts (which spawns anvil in globalSetup).
    exclude: ['**/node_modules/**', '**/dist/**', 'test/integration/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/bin.ts'],
      reporter: ['text', 'lcov', 'html'],
    },
  },
});
