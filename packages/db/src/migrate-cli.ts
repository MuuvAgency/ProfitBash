import { databaseDirectUrlSchema, loadEnv } from '@profitbash/shared/env';
import { runMigrations } from './migrate';

const env = loadEnv(databaseDirectUrlSchema);
await runMigrations(env.DATABASE_URL_DIRECT);
console.log('Migrationen eingespielt.');
