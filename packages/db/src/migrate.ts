import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

export interface ResolveMigrationsFolderOptions {
  /** Aus `MIGRATIONS_DIR`. Hat Vorrang vor den Standardorten. */
  migrationsDir?: string | undefined;
  /** Basis für ein relatives `migrationsDir`. Standard: `process.cwd()`. */
  cwd?: string;
  /** URL des Moduls, von dem aus gesucht wird. Standard: dieses Modul (bzw. das Bundle). */
  moduleUrl?: string;
}

function isMigrationsFolder(path: string): boolean {
  return existsSync(join(path, 'meta', '_journal.json'));
}

/**
 * Findet den Ordner mit den drizzle-Migrationen.
 *
 * Reihenfolge: `MIGRATIONS_DIR`, dann `drizzle/` neben dem Modul (Bundle: tsup kopiert den Ordner
 * neben `dist/migrate.js`), dann `../drizzle` (Quellcode: `packages/db/drizzle`). Nach dem Bündeln
 * zeigt `import.meta.url` auf das Bundle, deshalb reicht ein fester relativer Pfad nicht.
 */
export function resolveMigrationsFolder(options: ResolveMigrationsFolderOptions = {}): string {
  const { migrationsDir, cwd = process.cwd(), moduleUrl = import.meta.url } = options;

  if (migrationsDir) {
    const configured = resolve(cwd, migrationsDir);
    if (!isMigrationsFolder(configured)) {
      throw new Error(
        `MIGRATIONS_DIR (${configured}) ist kein Migrationsordner: meta/_journal.json fehlt.`,
      );
    }
    return configured;
  }

  const candidates = [
    fileURLToPath(new URL('./drizzle', moduleUrl)),
    fileURLToPath(new URL('../drizzle', moduleUrl)),
  ];
  const found = candidates.find(isMigrationsFolder);
  if (!found) {
    throw new Error(
      `Kein Migrationsordner gefunden. Gesucht: ${candidates.join(', ')}. MIGRATIONS_DIR setzen.`,
    );
  }
  return found;
}

export interface RunMigrationsOptions {
  /** Standard: `resolveMigrationsFolder()` ohne `MIGRATIONS_DIR`. */
  migrationsFolder?: string;
}

/** Spielt alle ausstehenden Migrationen ein. Idempotent. */
export async function runMigrations(
  url: string,
  options: RunMigrationsOptions = {},
): Promise<void> {
  const migrationsFolder = options.migrationsFolder ?? resolveMigrationsFolder();
  const { db, close } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}
