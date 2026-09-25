import { randomBytes } from 'node:crypto';
import { databaseTestUrlSchema, loadEnv, postgresUrlSchema } from '@profitbash/shared/env';
import postgres from 'postgres';
import { createDb, type Db } from './client';
import { runMigrations } from './migrate';

/**
 * Test-Datenbanken: Die globale Test-Einrichtung baut aus `DATABASE_URL_TEST` eine frisch migrierte
 * Template-Datenbank. Jede Testdatei klont sie (`CREATE DATABASE … TEMPLATE`) und arbeitet isoliert.
 * Dadurch laufen Testdateien parallel, ohne sich gegenseitig Daten zu überschreiben.
 */

/**
 * Schutz vor Datenverlust: Die Test-Einrichtung löscht Datenbanken. Deshalb nur Namen mit
 * `_test`-Endung zulassen, und nie dieselbe Datenbank wie `DATABASE_URL` / `DATABASE_URL_DIRECT`.
 */
export function assertSafeTestDatabase(
  testUrl: string,
  otherUrls: Array<string | undefined>,
): { template: string } {
  const url = new URL(testUrl);
  const template = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z0-9_]+_test$/.test(template)) {
    throw new Error(
      `DATABASE_URL_TEST muss auf eine Datenbank mit der Endung "_test" zeigen (gefunden: "${template}"). ` +
        'Die Test-Einrichtung löscht diese Datenbank.',
    );
  }
  for (const other of otherUrls) {
    if (!other) continue;
    const o = new URL(other);
    const sameServer = o.hostname === url.hostname && (o.port || '5432') === (url.port || '5432');
    if (sameServer && decodeURIComponent(o.pathname.slice(1)) === template) {
      throw new Error(
        'DATABASE_URL_TEST darf nicht dieselbe Datenbank wie DATABASE_URL(_DIRECT) sein.',
      );
    }
  }
  return { template };
}

function testDatabaseUrls() {
  const env = loadEnv(
    databaseTestUrlSchema.extend({
      DATABASE_URL: postgresUrlSchema.optional(),
      DATABASE_URL_DIRECT: postgresUrlSchema.optional(),
    }),
  );
  const url = new URL(env.DATABASE_URL_TEST);
  const { template } = assertSafeTestDatabase(env.DATABASE_URL_TEST, [
    env.DATABASE_URL,
    env.DATABASE_URL_DIRECT,
  ]);
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  return { url, template, maintenance: maintenance.toString() };
}

async function withMaintenanceConnection<T>(
  maintenanceUrl: string,
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(maintenanceUrl, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/** Globale Test-Einrichtung: räumt alte Klone auf und baut die Template-DB neu. */
export async function prepareTestTemplate(): Promise<void> {
  const { url, template, maintenance } = testDatabaseUrls();
  await withMaintenanceConnection(maintenance, async (sql) => {
    const leftovers = await sql<{ datname: string }[]>`
      select datname from pg_database where datname ~ ${`^${template}_[0-9a-f]{12}$`}`;
    for (const { datname } of leftovers) {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
    await sql.unsafe(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE "${template}"`);
  });
  await runMigrations(url.toString());
}

export interface TestDatabase {
  url: string;
  db: Db;
  /** Schließt die Verbindungen und löscht die Klon-Datenbank. */
  close(): Promise<void>;
}

/** Legt eine isolierte, migrierte Datenbank für eine Testdatei an. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const { url, template, maintenance } = testDatabaseUrls();
  const name = `${template}_${randomBytes(6).toString('hex')}`;
  await withMaintenanceConnection(maintenance, (sql) =>
    sql.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`),
  );

  const dbUrl = new URL(url);
  dbUrl.pathname = `/${name}`;
  const { db, close } = createDb(dbUrl.toString(), { max: 5 });

  return {
    url: dbUrl.toString(),
    db,
    close: async () => {
      await close();
      await withMaintenanceConnection(maintenance, (sql) =>
        sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
      );
    },
  };
}
