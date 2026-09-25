import { randomBytes } from 'node:crypto';
import { databaseTestUrlSchema, loadEnv } from '@profitbash/shared';
import postgres from 'postgres';
import { createDb, type Db } from './client';
import { runMigrations } from './migrate';

/**
 * Test-Datenbanken: Die globale Test-Einrichtung baut aus `DATABASE_URL_TEST` eine frisch migrierte
 * Template-Datenbank. Jede Testdatei klont sie (`CREATE DATABASE … TEMPLATE`) und arbeitet isoliert.
 * Dadurch laufen Testdateien parallel, ohne sich gegenseitig Daten zu überschreiben.
 */

function testDatabaseUrls() {
  const { DATABASE_URL_TEST } = loadEnv(databaseTestUrlSchema);
  const url = new URL(DATABASE_URL_TEST);
  const template = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z0-9_]+$/.test(template)) {
    throw new Error('DATABASE_URL_TEST muss einen einfachen Datenbanknamen enthalten ([a-z0-9_]).');
  }
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
      select datname from pg_database where datname like ${`${template}\\_%`}`;
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
