import { databaseDirectUrlSchema, loadEnv } from '@profitbash/shared';
import { runMigrations } from './migrate';

const env = loadEnv(databaseDirectUrlSchema);
await runMigrations(env.DATABASE_URL_DIRECT);
console.log('Migrationen eingespielt.');
