import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const migrationsSource = fileURLToPath(new URL('../../packages/db/drizzle', import.meta.url));
const migrationsTarget = fileURLToPath(new URL('./dist/drizzle', import.meta.url));

export default defineConfig({
  // Produktions-Einstiegspunkte (nur `node`, kein tsx):
  //   dist/index.js   Server (API + Web)
  //   dist/migrate.js Migrationen (Railway Pre-Deploy-Command)
  //   dist/seed.js    Seed (einmalig)
  //   dist/rotate-keys.js Schlüsselrotation (docs/deploy.md)
  entry: {
    index: 'src/index.ts',
    migrate: '../../packages/db/src/migrate-cli.ts',
    seed: 'src/seed-cli.ts',
    'rotate-keys': '../../packages/db/src/rotate-keys-cli.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
  // Workspace-Pakete liefern TypeScript-Quellcode und werden deshalb mitgebündelt.
  noExternal: [/^@profitbash\//],
  // Nach dem Bündeln zeigt `import.meta.url` auf dist/, deshalb liegen die Migrationen daneben
  // (siehe `resolveMigrationsFolder`).
  onSuccess: async () => {
    await cp(migrationsSource, migrationsTarget, { recursive: true });
  },
});
