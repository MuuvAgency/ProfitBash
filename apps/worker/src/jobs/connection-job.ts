import {
  AmazonAdsHttpError,
  AmazonAdsReauthRequiredError,
  type AmazonAdsClient,
  type ConnectionRef,
  type RequestMeter,
} from '@profitbash/amazon-ads';
import {
  ConnectionReauthRequiredError,
  findJobConnection,
  markConnectionReauthRequired,
  type Db,
} from '@profitbash/db';
import type { ConnectionJobName, Logger } from '@profitbash/shared';
import { z } from 'zod';
import { JobFailure } from '../run-job';

/** So oft wird ein Job nach `Retry-After` von Amazon neu eingeplant, danach erst im nächsten Zyklus. */
export const MAX_RETRY_AFTER_ATTEMPTS = 3;
/**
 * Längere Pausen werden nicht neu eingeplant: Der wartende Job belegte sonst stundenlang den einzigen
 * Warteplatz der Connection (`stately`), und reguläre wie manuelle Läufe fielen still weg.
 */
export const MAX_RETRY_AFTER_SECONDS = 60 * 60;

/**
 * Gültigkeit der Lease je Connection (1.3). Länger als der Ablauf der Jobs in pg-boss
 * (`expireInSeconds`, siehe `queues.ts`): Ein von pg-boss schon als abgelaufen geführter, aber noch
 * laufender Job hält die Connection weiter. Nach einem Absturz ist sie spätestens danach wieder frei.
 */
export const CONNECTION_LEASE_SECONDS = 15 * 60;
/** Ist die Connection belegt, startet der Job so viel später erneut. */
export const LEASE_DEFER_SECONDS = 60;

/** Daten der Jobs je Connection (`CONNECTION_JOB_NAMES`). */
export const connectionJobDataSchema = z.object({
  organizationId: z.uuid(),
  connectionId: z.uuid(),
  /** Zählt Neu-Planungen nach `Retry-After`. */
  retryAttempt: z.number().int().min(1).max(MAX_RETRY_AFTER_ATTEMPTS).optional(),
  /** Zählt Zurückstellungen, weil ein anderer Datenjob die Connection hielt (ohne Obergrenze). */
  deferredCount: z.number().int().min(1).optional(),
  /**
   * „Jetzt synchronisieren“ (1.7): `profiles-sync` plant danach `entities-sync` ein, dieser `reports-sync`.
   * Nur der manuelle Auslöser setzt es; die täglichen Läufe haben eigene Zeiten.
   */
  chain: z.boolean().optional(),
  /**
   * Fortsetzung nach Ablauf des Zeitbudgets (`entities-sync`, `reports-sync`): beginnt mit diesem
   * Profil. Fehlt es inzwischen, beginnt der Lauf von vorn (die Jobs sind idempotent).
   */
  resumeFromProfileId: z.uuid().optional(),
});

export type ConnectionJobData = z.infer<typeof connectionJobDataSchema>;

/** Queue-Namen = Jobnamen in `job_runs`; der Sync-Status filtert danach (`CONNECTION_JOB_NAMES`). */
export type ConnectionQueue = ConnectionJobName;

export interface ScheduledRetry {
  queue: ConnectionQueue;
  job: ConnectionJobData;
  startAfterSeconds: number;
}

export interface ConnectionJobDeps {
  db: Db;
  logger: Logger;
  amazonAds: AmazonAdsClient;
  /** Plant denselben Job später erneut ein (pg-boss `startAfter`); `false`, wenn schon einer wartet. */
  scheduleRetry(retry: ScheduledRetry): Promise<boolean>;
  /**
   * Plant einen Job je Connection ein (Kette, Poll nach dem Anfordern); `false`, wenn für die Connection
   * in dieser Queue schon einer wartet.
   */
  enqueue(
    queue: ConnectionQueue,
    job: ConnectionJobData,
    options?: { startAfterSeconds?: number },
  ): Promise<boolean>;
  /** Uhr (Tests). Standard `new Date()`. */
  now?: () => Date;
}

/** Kontext eines Laufs: Zähler für alle Aufrufe an Amazon (landen in `job_runs.counters`). */
export interface ConnectionJobRun {
  meter: RequestMeter;
  /** ID der `job_runs`-Zeile (nur Datenjobs mit Lease, sonst `null`). */
  runId: string | null;
  /**
   * Verlängert die Lease der Connection um `CONNECTION_LEASE_SECONDS` ab jetzt. Lange Schritte (viele
   * Aufrufe, Downloads) rufen das vor jedem Schritt, sonst könnte nach Ablauf ein zweiter Datenjob starten.
   * Ohne Lease wirkungslos.
   */
  extendLease(): Promise<void>;
}

export const CONNECTION_NOT_FOUND_MESSAGE = 'Connection nicht gefunden.';

export const REAUTH_REQUIRED_MESSAGE =
  'Amazon hat den Refresh-Token abgelehnt. Die Connection muss neu verbunden werden.';

export interface LoadedConnection extends ConnectionRef {
  /** Refresh-Token (verschlüsselt) beim Start des Jobs: Nur dieser darf als abgelehnt markiert werden. */
  refreshTokenEncrypted: string;
}

/** Lädt die Connection im Org-Kontext des Jobs. Connections mit `reauth_required` laufen nicht. */
export async function loadConnection(db: Db, job: ConnectionJobData): Promise<LoadedConnection> {
  const row = await findJobConnection(db, job);
  if (!row) throw new JobFailure(CONNECTION_NOT_FOUND_MESSAGE);
  if (row.status === 'reauth_required') throw new JobFailure(REAUTH_REQUIRED_MESSAGE);
  if (!row.region) throw new JobFailure('Connection ohne Region.');
  return {
    id: row.id,
    organizationId: row.organizationId,
    region: row.region,
    refreshTokenEncrypted: row.refreshTokenEncrypted,
  };
}

/**
 * Übersetzt Fehler von Amazon in das Ergebnis des Jobs:
 * - abgelehnter Refresh-Token → Connection auf `reauth_required` (eigene Anweisung nach dem Rollback
 *   des Token-Stores), Lauf scheitert mit Hinweis
 * - `Retry-After` → derselbe Job wird mit dieser Wartezeit neu eingeplant (höchstens
 *   `MAX_RETRY_AFTER_ATTEMPTS`-mal)
 * Alles andere wird unverändert weitergeworfen.
 */
export async function handleAmazonError(
  deps: ConnectionJobDeps,
  queue: ConnectionQueue,
  job: ConnectionJobData,
  connection: LoadedConnection,
  err: unknown,
): Promise<never> {
  if (err instanceof AmazonAdsReauthRequiredError) {
    // Abgelehnt wurde der Token, den der Job beim Start vorfand (oder ein älterer): Ein inzwischen
    // neu verbundener Token bleibt aktiv.
    await markConnectionReauthRequired(deps.db, {
      id: connection.id,
      organizationId: connection.organizationId,
      rejectedRefreshTokenEncrypted: connection.refreshTokenEncrypted,
    });
    throw new JobFailure(REAUTH_REQUIRED_MESSAGE);
  }
  if (err instanceof ConnectionReauthRequiredError) throw new JobFailure(REAUTH_REQUIRED_MESSAGE);
  if (err instanceof AmazonAdsHttpError && err.retryAfterMs !== null) {
    const attempt = job.retryAttempt ?? 0;
    const startAfterSeconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
    if (attempt >= MAX_RETRY_AFTER_ATTEMPTS || startAfterSeconds > MAX_RETRY_AFTER_SECONDS) {
      throw new JobFailure(
        `Amazon verlangt eine Pause (HTTP ${err.status}, ${startAfterSeconds} s); keine weiteren Versuche, der nächste reguläre Lauf holt es nach.`,
      );
    }
    const scheduled = await deps.scheduleRetry({
      queue,
      job: {
        organizationId: job.organizationId,
        connectionId: job.connectionId,
        retryAttempt: attempt + 1,
        ...(job.chain && { chain: true }),
        ...(job.resumeFromProfileId && { resumeFromProfileId: job.resumeFromProfileId }),
      },
      startAfterSeconds,
    });
    throw new JobFailure(
      scheduled
        ? `Amazon verlangt eine Pause (HTTP ${err.status}). Neuer Versuch in ${startAfterSeconds} s eingeplant.`
        : `Amazon verlangt eine Pause (HTTP ${err.status}). Für die Connection ist bereits ein Job eingeplant.`,
      undefined,
      { alert: false },
    );
  }
  throw err;
}
