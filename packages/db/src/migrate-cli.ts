import { databaseDirectUrlSchema, loadEnv, migrationsDirSchema } from '@profitbash/shared/env';
import { resolveMigrationsFolder, runMigrations } from './migrate';

// Dev: `pnpm db:migrate` (tsx). Prod: gebündelt als `apps/api/dist/migrate.js` (Pre-Deploy-Command).
const env = loadEnv(databaseDirectUrlSchema.extend(migrationsDirSchema.shape));
const migrationsFolder = resolveMigrationsFolder({ migrationsDir: env.MIGRATIONS_DIR });
await runMigrations(env.DATABASE_URL_DIRECT, { migrationsFolder });
console.log(`Migrationen eingespielt (${migrationsFolder}).`);
