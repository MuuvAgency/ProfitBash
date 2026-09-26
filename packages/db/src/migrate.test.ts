import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveMigrationsFolder } from './migrate';

/** Legt einen Migrationsordner an, wie drizzle-kit ihn erzeugt (nur das Journal zählt). */
function makeMigrationsDir(path: string): string {
  mkdirSync(join(path, 'meta'), { recursive: true });
  writeFileSync(join(path, 'meta', '_journal.json'), '{"entries":[]}');
  return path;
}

describe('resolveMigrationsFolder', () => {
  let root: string;
  /** Simulierte Moduldatei `<root>/pkg/src/migrate.js` bzw. nach dem Bündeln `<root>/dist/migrate.js`. */
  let sourceModuleUrl: string;
  let bundleModuleUrl: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pb-migrations-'));
    mkdirSync(join(root, 'pkg', 'src'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    sourceModuleUrl = pathToFileURL(join(root, 'pkg', 'src', 'migrate.js')).href;
    bundleModuleUrl = pathToFileURL(join(root, 'dist', 'migrate.js')).href;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('nutzt im Quellcode den Ordner drizzle/ neben src/', () => {
    const expected = makeMigrationsDir(join(root, 'pkg', 'drizzle'));
    expect(resolveMigrationsFolder({ moduleUrl: sourceModuleUrl })).toBe(expected);
  });

  it('nutzt im Bundle den daneben kopierten Ordner drizzle/', () => {
    const expected = makeMigrationsDir(join(root, 'dist', 'drizzle'));
    expect(resolveMigrationsFolder({ moduleUrl: bundleModuleUrl })).toBe(expected);
  });

  it('bevorzugt MIGRATIONS_DIR vor den Standardorten', () => {
    makeMigrationsDir(join(root, 'dist', 'drizzle'));
    const configured = makeMigrationsDir(join(root, 'custom'));
    expect(resolveMigrationsFolder({ moduleUrl: bundleModuleUrl, migrationsDir: configured })).toBe(
      configured,
    );
  });

  it('löst ein relatives MIGRATIONS_DIR gegen das Arbeitsverzeichnis auf', () => {
    const configured = makeMigrationsDir(join(root, 'custom'));
    expect(
      resolveMigrationsFolder({ moduleUrl: bundleModuleUrl, migrationsDir: 'custom', cwd: root }),
    ).toBe(configured);
  });

  it('wirft, wenn MIGRATIONS_DIR kein Migrationsordner ist, statt auf die Standardorte auszuweichen', () => {
    makeMigrationsDir(join(root, 'dist', 'drizzle'));
    const empty = join(root, 'empty');
    mkdirSync(empty);
    expect(() =>
      resolveMigrationsFolder({ moduleUrl: bundleModuleUrl, migrationsDir: empty }),
    ).toThrow(/MIGRATIONS_DIR.*meta\/_journal\.json/);
  });

  it('wirft mit den gesuchten Orten, wenn kein Migrationsordner gefunden wird', () => {
    expect(() => resolveMigrationsFolder({ moduleUrl: bundleModuleUrl })).toThrow(
      new RegExp(`Kein Migrationsordner gefunden.*${join(root, 'dist', 'drizzle')}`),
    );
  });
});
