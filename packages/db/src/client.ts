import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export interface CreateDbOptions {
  /** Maximale Anzahl Verbindungen im Pool. */
  max?: number;
}

/**
 * Erstellt eine Drizzle-Instanz über postgres.js. Die Verbindung wird erst bei der ersten Query aufgebaut.
 * pg-boss und Migrationen nutzen die direkte URL (`DATABASE_URL_DIRECT`), nie einen Transaction-Pooler.
 */
export function createDb(url: string, options: CreateDbOptions = {}) {
  const client = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
    // Immer UTC, unabhängig von der Server-Zeitzone. Die better-auth-Tabellen nutzen `timestamp`
    // ohne Zeitzone; mit UTC-Sessions sind DB-Defaults (now()) und App-Werte konsistent.
    connection: { TimeZone: 'UTC' },
  });
  const db = drizzle({ client, schema });
  return { db, client, close: () => client.end() };
}

export type Db = ReturnType<typeof createDb>['db'];
