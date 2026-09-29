import { z } from 'zod';

/**
 * Datei-Import aus der Amazon-Werbekonsole (`phase-1.md` 1.11c): Arten, Status und Grenzen, gemeinsam für
 * API, Worker und Web.
 */

/** `bulk` = Bulk-Datei (Entities, 1.11d), `daily_report` = Tagesbericht (Kennzahlen, 1.11e). */
export const FILE_IMPORT_KINDS = ['bulk', 'daily_report'] as const;
export type FileImportKind = (typeof FILE_IMPORT_KINDS)[number];

export const FILE_IMPORT_STATUSES = ['pending', 'running', 'imported', 'failed'] as const;
export type FileImportStatus = (typeof FILE_IMPORT_STATUSES)[number];

/** Größte Datei beim Upload (gepackt bzw. als CSV). Bulk-Dateien großer Konten liegen darunter. */
export const FILE_IMPORT_MAX_BYTES = 50 * 1024 * 1024;

/** So viele Importe je Profil liefert die Liste (neueste zuerst). */
export const FILE_IMPORT_LIST_LIMIT = 50;

const timestamp = z.iso.datetime();

export const fileImportSchema = z
  .object({
    id: z.uuid(),
    profileId: z.uuid(),
    kind: z.enum(FILE_IMPORT_KINDS),
    fileName: z.string(),
    byteSize: z.number().int(),
    sha256: z.string(),
    status: z.enum(FILE_IMPORT_STATUSES),
    /** Grund eines Fehlschlags, für die Anzeige (ohne Inhalte der Datei). */
    error: z.string().nullable(),
    counters: z.record(z.string(), z.number()),
    uploadedBy: z.uuid().nullable(),
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
  })
  .meta({ id: 'FileImport' });
export type FileImport = z.infer<typeof fileImportSchema>;

export const fileImportListSchema = z
  .object({ fileImports: z.array(fileImportSchema) })
  .meta({ id: 'FileImportList' });
