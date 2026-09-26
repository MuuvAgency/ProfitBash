import { errorLogFields, isDbQueryError, schema, type Db } from '@profitbash/db';
import type { Logger } from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { pingHealthcheck } from './healthchecks';

const { jobRuns } = schema;

/** Namen in `job_runs.job` (und in der Sync-Status-Ansicht). */
export type JobName = 'token-refresh' | 'profiles-sync' | 'job-runs-cleanup';

export interface JobScope {
  /** Eigentümer-Organisation; `null` für plattformweite Läufe. */
  organizationId: string | null;
  /** Worauf sich der Lauf bezieht, z. B. die Connection-ID; `null` für „alle“. */
  scope: string | null;
}

export interface JobContext {
  runId: string;
}

export type JobCounters = Record<string, number>;

export interface JobOutcome {
  counters?: JobCounters;
}

/**
 * Erwarteter Fehlschlag mit einer Meldung für die Sync-Status-Ansicht (z. B. „Connection muss neu
 * verbunden werden“). Die Meldung darf keine Secrets oder Rohdaten enthalten.
 */
export class JobFailure extends Error {
  /**
   * `false`: Der Lauf endet als `failed`, Healthchecks bekommt aber keinen Alarm (`/fail`), weil sich
   * der Fall selbst erledigt (z. B. nach `Retry-After` neu eingeplant).
   */
  public readonly alert: boolean;

  constructor(
    message: string,
    public readonly counters?: JobCounters,
    options: { alert?: boolean } = {},
  ) {
    super(message);
    this.name = 'JobFailure';
    this.alert = options.alert ?? true;
  }
}

export type JobRunResult =
  { status: 'success'; runId: string } | { status: 'failed'; runId: string; error: string };

export interface JobRunnerDeps {
  db: Db;
  logger: Logger;
  /** Ping-URL je Job (Healthchecks.io). Ohne URL wird nicht gepingt. */
  healthchecks?: Partial<Record<JobName, string | undefined>>;
  fetch?: typeof fetch;
}

export type RunJob = (
  name: JobName,
  scope: JobScope,
  fn: (context: JobContext) => Promise<JobOutcome | void>,
) => Promise<JobRunResult>;

const MAX_ERROR_LENGTH = 1_000;

/**
 * Job-Wrapper: schreibt `job_runs` (running → success/failed), fängt Fehler ab und pingt
 * Healthchecks. Wirft nur, wenn `job_runs` selbst nicht geschrieben werden kann (Anlegen oder
 * Abschließen, z. B. Datenbank weg); der Lauf bleibt dann `running`, bis `job-runs-cleanup` ihn abschließt.
 */
export function createJobRunner(deps: JobRunnerDeps): RunJob {
  const { db, logger } = deps;

  return async (name, scope, fn) => {
    const [run] = await db
      .insert(jobRuns)
      .values({ job: name, organizationId: scope.organizationId, scope: scope.scope })
      .returning({ id: jobRuns.id });
    if (!run) throw new Error('Insert in job_runs lieferte keine Zeile.');
    const runId = run.id;

    const url = deps.healthchecks?.[name];
    const ping = async (kind: 'start' | 'success' | 'fail') => {
      if (url) await pingHealthcheck({ url, ping: kind, rid: runId, logger, fetch: deps.fetch });
    };

    await ping('start');
    try {
      const outcome = await fn({ runId });
      await db
        .update(jobRuns)
        .set({ status: 'success', finishedAt: new Date(), counters: outcome?.counters ?? {} })
        .where(eq(jobRuns.id, runId));
      await ping('success');
      return { status: 'success', runId };
    } catch (err) {
      const error = jobErrorMessage(err);
      logger({
        level: 'error',
        msg: 'job.failed',
        job: name,
        runId,
        organizationId: scope.organizationId,
        scope: scope.scope,
        ...errorLogFields(err),
      });
      await db
        .update(jobRuns)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          error,
          ...(err instanceof JobFailure && err.counters && { counters: err.counters }),
        })
        .where(eq(jobRuns.id, runId));
      await ping(err instanceof JobFailure && !err.alert ? 'success' : 'fail');
      return { status: 'failed', runId, error };
    }
  };
}

/** Fehlertext für `job_runs.error`: ohne Parameterwerte fehlgeschlagener Abfragen, gekürzt. */
export function jobErrorMessage(err: unknown): string {
  if (isDbQueryError(err)) return 'Datenbankabfrage fehlgeschlagen.';
  const message = err instanceof Error ? err.message : 'Unbekannter Fehler.';
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)} …` : message;
}
