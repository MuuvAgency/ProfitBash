import { z } from 'zod';

/**
 * Datei-Import aus der Amazon-Werbekonsole (`phase-1.md` 1.11c): Arten, Status und Grenzen, gemeinsam für
 * API, Worker und Web.
 */

/**
 * `bulk` = Bulk-Datei (Entities, 1.11d). `daily_report` = Tagesbericht (Kennzahlen, 1.11e): entfällt bis auf Weiteres
 * (kein Importer, die Oberfläche bietet die Art nicht an), bleibt aber in Schema und API.
 */
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
    /** Laut Upload vollständig: der Import darf Fehlendes als entfernt markieren. */
    complete: z.boolean(),
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

/** Hinweis „Bulk-Datei veraltet“, wenn der letzte erfolgreiche Bulk-Import mehr als so viele Tage zurückliegt. */
export const FILE_BULK_STALE_AFTER_DAYS = 7;
/** Hinweis „Kennzahlen veraltet“, wenn „Daten bis“ mehr als so viele Kalendertage (Zeitzone des Profils) zurückliegt. */
export const FILE_METRICS_STALE_AFTER_DAYS = 3;

/** `noBulk` = noch keine Bulk-Datei importiert, `bulkStale` / `metricsStale` siehe Konstanten oben. */
export type FileDataStaleness = 'noBulk' | 'bulkStale' | 'metricsStale';

const DAY_MS = 86_400_000;

function todayIn(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Hinweise auf veraltete Daten eines Profils ohne Connection (`phase-1.md` 1.11f). Fehlende Kennzahlen sind kein
 * Hinweis: Viele Datei-Profile haben (noch) keine Tagesberichte.
 */
export function fileDataStaleness(
  input: {
    lastBulkImportAt: string | null;
    metricsImportedThrough: string | null;
    timezone: string;
  },
  now: Date,
): FileDataStaleness[] {
  const result: FileDataStaleness[] = [];
  if (input.lastBulkImportAt === null) result.push('noBulk');
  else if (
    now.getTime() - Date.parse(input.lastBulkImportAt) >
    FILE_BULK_STALE_AFTER_DAYS * DAY_MS
  ) {
    result.push('bulkStale');
  }
  if (input.metricsImportedThrough !== null) {
    const today = todayIn(input.timezone, now);
    const days =
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${input.metricsImportedThrough}T00:00:00Z`)) /
      DAY_MS;
    if (days > FILE_METRICS_STALE_AFTER_DAYS) result.push('metricsStale');
  }
  return result;
}
