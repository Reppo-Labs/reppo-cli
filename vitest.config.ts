import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // command-error-paths.test.ts spawns `npx tsx src/bin.ts` per case;
    // tsx cold-start can exceed 5s on cold caches (CI macOS runners
    // especially). Bump per-test timeout so the spawn-based pre-flight
    // tests don't flake while keeping unit-test fast feedback.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/bin.ts'],
      reporter: ['text', 'lcov', 'html'],
    },
  },
});
