import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { amazonAdsProfiles } from './app';
import { users } from './auth';
import { createdAt, id, organizationId, updatedAt } from './columns';

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  fromDriver: (value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
});

/**
 * Hochgeladene Dateien aus der Werbekonsole (`phase-1.md` 1.11c) und das Ergebnis ihres Imports. Der
 * Inhalt liegt nur bis zum Ende des Imports in `file_import_contents` (F5: keine Rohdateien aufbewahren).
 * Zugriffe nur über `file-imports.ts`.
 */
export const fileImports = pgTable(
  'file_imports',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: uuid('profile_id').notNull(),
    /** `bulk` (Bulk-Datei) | `daily_report` (Tagesbericht), siehe `FILE_IMPORT_KINDS`. */
    kind: text('kind').notNull(),
    fileName: text('file_name').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    /** `pending` → `running` → `imported` | `failed`. */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Für die Anzeige gedachter Grund eines Fehlschlags (ohne Inhalte der Datei). */
    error: text('error'),
    counters: jsonb('counters')
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Lauf des Jobs `file-import`, der die Datei zuletzt bearbeitet hat. */
    jobRunId: uuid('job_run_id'),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Verlauf eines Profils: verschwindet mit dem Profil (wie die Amazon-Aufträge).
    foreignKey({
      name: 'file_imports_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }).onDelete('cascade'),
    check('file_imports_kind_ck', sql`${t.kind} in ('bulk', 'daily_report')`),
    check(
      'file_imports_status_ck',
      sql`${t.status} in ('pending', 'running', 'imported', 'failed')`,
    ),
    unique('file_imports_id_org_uq').on(t.id, t.organizationId),
    index('file_imports_profile_created_idx').on(t.profileId, t.createdAt.desc()),
    index('file_imports_open_idx')
      .on(t.profileId, t.createdAt)
      .where(sql`${t.status} in ('pending', 'running')`),
  ],
);

/** Inhalt einer Datei bis zum Ende ihres Imports (eigene Tabelle, damit Listen ihn nie mitlesen). */
export const fileImportContents = pgTable(
  'file_import_contents',
  {
    fileImportId: uuid('file_import_id').primaryKey(),
    organizationId: organizationId(),
    content: bytea('content').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'file_import_contents_import_org_fk',
      columns: [t.fileImportId, t.organizationId],
      foreignColumns: [fileImports.id, fileImports.organizationId],
    }).onDelete('cascade'),
  ],
);
