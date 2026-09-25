import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*'],
    passWithNoTests: true,
    // Baut einmal pro Testlauf die migrierte Template-DB (siehe packages/db/src/testing.ts).
    globalSetup: ['./packages/db/src/test-global-setup.ts'],
  },
});
