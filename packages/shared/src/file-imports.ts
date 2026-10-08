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

/**
 * Zeitraum, über den eine Bulk-Datei ihre Kennzahlen summiert (Suchbegriffe, `phase-2b.md` 2b.1). Er steht im
 * Dateinamen der Werbekonsole; bei umbenannten Dateien gibt man ihn beim Upload von Hand an (2b.2c).
 */
export interface BulkPeriod {
  /** Beide Tage eingeschlossen (`YYYY-MM-DD`). */
  startDate: string;
  endDate: string;
}

/**
 * So viele Tage dürfen höchstens zwischen erstem und letztem Tag eines von Hand angegebenen Zeitraums liegen:
 * Die Werbekonsole exportiert höchstens 60 Tage.
 */
export const BULK_PERIOD_MAX_DAYS = 60;

/**
 * So viele Tage darf der erste Tag eines von Hand angegebenen Zeitraums höchstens vor „heute“ liegen (2b.2d): Ein
 * Tippfehler im Jahr ergäbe sonst einen Zeitraum, der in der Suchbegriff-Analyse stehen bleibt.
 */
export const BULK_PERIOD_MAX_AGE_DAYS = 365;

const DAY_MS = 86_400_000;

/** Gültiger Kalendertag in der Schreibweise `YYYY-MM-DD` (kein 30. Februar)? */
function isIsoDay(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/**
 * Download-Zeitraum aus dem Dateinamen der Werbekonsole (`bulk-<konto>-<von>-<bis>-<zeitstempel>.xlsx`,
 * Tage `YYYYMMDD`); `null`, wenn die Datei umbenannt wurde oder der Zeitraum unmöglich ist. Import (Worker),
 * Upload (API) und Dialog (Web) nutzen dieselbe Funktion: Der Dialog fragt genau dann nach dem Zeitraum, wenn
 * der Import ihn nicht aus dem Namen lesen kann.
 */
export function parseBulkPeriod(fileName: string): BulkPeriod | null {
  const match = /^bulk-.+?-(\d{8})-(\d{8})-\d+/i.exec(fileName.trim());
  if (!match) return null;
  const [startDate, endDate] = [match[1]!, match[2]!].map(
    (text) => `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`,
  ) as [string, string];
  if (!isIsoDay(startDate) || !isIsoDay(endDate) || startDate > endDate) return null;
  return { startDate, endDate };
}

/**
 * Was an einem von Hand angegebenen Zeitraum nicht stimmt: nur ein Tag angegeben, kein gültiger Tag, von nach
 * bis, Tag in der Zukunft, mehr als `BULK_PERIOD_MAX_DAYS` Tage, erster Tag mehr als `BULK_PERIOD_MAX_AGE_DAYS`
 * Tage vor „heute“.
 */
export const BULK_PERIOD_ISSUES = [
  'incomplete',
  'invalidDate',
  'startAfterEnd',
  'future',
  'tooLong',
  'tooOld',
] as const;
export type BulkPeriodIssue = (typeof BULK_PERIOD_ISSUES)[number];

/** Frühester erlaubter erster Tag eines von Hand angegebenen Zeitraums (`today` − `BULK_PERIOD_MAX_AGE_DAYS`). */
export function oldestBulkPeriodStart(today: string): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - BULK_PERIOD_MAX_AGE_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * Prüft einen von Hand angegebenen Zeitraum (Dialog und API mit denselben Regeln). Keine Angabe (beide leer) ist
 * erlaubt: Dann bleiben die Suchbegriffe einer Datei ohne Zeitraum im Namen weg. `today` = heutiger Kalendertag in
 * der Zeitzone des Profils; ohne ihn entfallen die Prüfungen auf Tage in der Zukunft und auf zu alte Zeiträume.
 */
export function bulkPeriodIssue(
  input: { startDate?: string | null; endDate?: string | null },
  today?: string,
): BulkPeriodIssue | null {
  const startDate = input.startDate ?? '';
  const endDate = input.endDate ?? '';
  if (startDate === '' && endDate === '') return null;
  if (startDate === '' || endDate === '') return 'incomplete';
  if (!isIsoDay(startDate) || !isIsoDay(endDate)) return 'invalidDate';
  if (startDate > endDate) return 'startAfterEnd';
  if (today !== undefined && endDate > today) return 'future';
  const days = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY_MS;
  if (days > BULK_PERIOD_MAX_DAYS) return 'tooLong';
  // Nach der Länge: Die prüft die API schon ohne „heute“, so melden Dialog und API dasselbe.
  if (today !== undefined && startDate < oldestBulkPeriodStart(today)) return 'tooOld';
  return null;
}

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
    /**
     * Beim Upload von Hand angegebener Zeitraum der Kennzahlen (beide Tage eingeschlossen); `null`, wenn der
     * Dateiname ihn trägt oder keiner angegeben wurde.
     */
    periodStart: z.iso.date().nullable(),
    periodEnd: z.iso.date().nullable(),
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

/** Heutiger Kalendertag (`YYYY-MM-DD`) in einer Zeitzone, z. B. der des Profils. */
export function todayInTimezone(timezone: string, now: Date): string {
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
    const today = todayInTimezone(input.timezone, now);
    const days =
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${input.metricsImportedThrough}T00:00:00Z`)) /
      DAY_MS;
    if (days > FILE_METRICS_STALE_AFTER_DAYS) result.push('metricsStale');
  }
  return result;
}
