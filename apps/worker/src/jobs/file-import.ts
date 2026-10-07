import {
  claimNextFileImport,
  errorLogFields,
  finishFileImport,
  hasClaimableFileImport,
  type Db,
} from '@profitbash/db';
import type { FileImportKind, Logger } from '@profitbash/shared';
import { SheetReadError } from '@profitbash/sheets';
import { z } from 'zod';
import { JobFailure, type JobCounters, type JobRunResult, type RunJob } from '../run-job';

/**
 * Job `file-import` je Profil (`phase-1.md` 1.11c): arbeitet die hochgeladenen Dateien des Profils in der
 * Reihenfolge des Uploads ab. Eine Datei, die scheitert, hält die übrigen nicht auf. Die Abbildung auf die
 * Schreibschicht (1.5) liefern die Importer je Dateiart (1.11d Bulk-Datei, 1.11e Tagesbericht).
 */

export const fileImportJobDataSchema = z.object({
  organizationId: z.uuid(),
  profileId: z.uuid(),
});
export type FileImportJobData = z.infer<typeof fileImportJobDataSchema>;

/** Wie die Datenjobs kurz bleiben (`expireInSeconds`): danach neu einplanen. */
export const FILE_IMPORT_TIME_BUDGET_MS = 5 * 60 * 1000;

/**
 * Erwartete Ablehnung einer Datei (falsche Datei, fehlende Spalte, anderes Konto). Die Meldung erscheint
 * beim Import und darf keine Inhalte der Datei nennen.
 */
export class FileImportRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileImportRejectedError';
  }
}

export interface FileImporterInput {
  db: Db;
  logger: Logger;
  organizationId: string;
  profileId: string;
  fileName: string;
  /** `file_imports.id` der Datei (fehlt bei direktem Aufruf in Tests). */
  fileImportId?: string;
  content: Uint8Array;
  now: Date;
  /** Laut Upload enthält die Datei alle Entities (siehe `file_imports.complete`). */
  complete: boolean;
  /** Zeitpunkt des Uploads. */
  uploadedAt: Date;
}

/** Importiert eine Datei und liefert ihre Zähler; wirft `FileImportRejectedError` bei ungeeigneten Dateien. */
export type FileImporter = (input: FileImporterInput) => Promise<JobCounters>;
export type FileImporters = Partial<Record<FileImportKind, FileImporter>>;

export interface FileImportJobDeps {
  db: Db;
  logger: Logger;
  importers: FileImporters;
  now: () => Date;
  /** Plant den nächsten Lauf für das Profil ein (nach dem Zeitbudget). */
  enqueueFollowUp: (job: FileImportJobData) => Promise<void>;
}

function publicReason(error: unknown): string | null {
  if (error instanceof FileImportRejectedError || error instanceof SheetReadError) {
    return error.message;
  }
  return null;
}

export async function importProfileFiles(
  runJob: RunJob,
  deps: FileImportJobDeps,
  job: FileImportJobData,
): Promise<JobRunResult | null> {
  // Nichts abzuholen (doppelt eingeplant, Datei läuft schon): kein Lauf, sonst rückte „Letzter Sync“ vor.
  if (!(await hasClaimableFileImport(deps.db, { ...job, now: deps.now() }))) return null;
  return runJob(
    'file-import',
    { organizationId: job.organizationId, scope: job.profileId },
    async ({ runId }) => {
      const started = deps.now().getTime();
      const counters: JobCounters = { files: 0, imported: 0, filesFailed: 0 };
      const add = (more: JobCounters) => {
        for (const [key, value] of Object.entries(more))
          counters[key] = (counters[key] ?? 0) + value;
      };

      for (;;) {
        if (deps.now().getTime() - started >= FILE_IMPORT_TIME_BUDGET_MS) {
          if (await hasClaimableFileImport(deps.db, { ...job, now: deps.now() })) {
            await deps.enqueueFollowUp(job);
          }
          break;
        }
        const claim = await claimNextFileImport(deps.db, {
          ...job,
          jobRunId: runId,
          now: deps.now(),
        });
        // Unterwegs aufgegebene Dateien (Versuche erschöpft, Inhalt fehlt) zählen als gescheitert.
        counters.files! += claim.abandoned;
        counters.filesFailed! += claim.abandoned;
        const claimed = claim.file;
        if (!claimed) break;
        counters.files! += 1;

        const importer = deps.importers[claimed.kind];
        let result: { status: 'imported' | 'failed'; error: string | null; counters: JobCounters };
        if (!importer) {
          result = {
            status: 'failed',
            error: 'Diese Dateiart wird noch nicht unterstützt.',
            counters: {},
          };
        } else {
          try {
            const fileCounters = await importer({
              db: deps.db,
              logger: deps.logger,
              organizationId: job.organizationId,
              profileId: job.profileId,
              fileName: claimed.fileName,
              fileImportId: claimed.id,
              content: claimed.content,
              now: deps.now(),
              complete: claimed.complete,
              uploadedAt: claimed.uploadedAt,
            });
            result = { status: 'imported', error: null, counters: fileCounters };
          } catch (error) {
            const reason = publicReason(error);
            deps.logger({
              level: reason ? 'warn' : 'error',
              msg: 'file_import.failed',
              fileImportId: claimed.id,
              kind: claimed.kind,
              ...errorLogFields(error),
            });
            result = {
              status: 'failed',
              error: reason ?? 'Unerwarteter Fehler beim Import. Details stehen im Log.',
              counters: {},
            };
          }
        }
        const finished = await finishFileImport(deps.db, {
          organizationId: job.organizationId,
          id: claimed.id,
          jobRunId: runId,
          ...result,
          now: deps.now(),
        });
        if (!finished) {
          // Ein neuerer Lauf hat die Datei übernommen (dieser hing länger als erlaubt); sein Ergebnis gilt.
          deps.logger({ level: 'warn', msg: 'file_import.superseded', fileImportId: claimed.id });
          counters.files! -= 1;
          continue;
        }
        counters[result.status === 'imported' ? 'imported' : 'filesFailed']! += 1;
        add(result.counters);
      }

      if (counters.filesFailed! > 0) {
        throw new JobFailure(
          `${counters.filesFailed} von ${counters.files} Dateien nicht importiert.`,
          counters,
        );
      }
      return { counters };
    },
  );
}
