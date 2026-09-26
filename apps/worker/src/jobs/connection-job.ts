import {
  AmazonAdsHttpError,
  AmazonAdsReauthRequiredError,
  type AmazonAdsClient,
  type ConnectionRef,
} from '@profitbash/amazon-ads';
import {
  ConnectionReauthRequiredError,
  findJobConnection,
  markConnectionReauthRequired,
  type Db,
} from '@profitbash/db';
import type { Logger } from '@profitbash/shared';
import { z } from 'zod';
import { JobFailure } from '../run-job';

/** So oft wird ein Job nach `Retry-After` von Amazon neu eingeplant, danach erst im nächsten Zyklus. */
export const MAX_RETRY_AFTER_ATTEMPTS = 3;
/**
 * Längere Pausen werden nicht neu eingeplant: Der wartende Job belegte sonst stundenlang den einzigen
 * Warteplatz der Connection (`stately`), und reguläre wie manuelle Läufe fielen still weg.
 */
export const MAX_RETRY_AFTER_SECONDS = 60 * 60;

/** Daten der Jobs je Connection (`token-refresh`, `profiles-sync`). */
export const connectionJobDataSchema = z.object({
  organizationId: z.uuid(),
  connectionId: z.uuid(),
  /** Zählt Neu-Planungen nach `Retry-After`. */
  retryAttempt: z.number().int().min(1).max(MAX_RETRY_AFTER_ATTEMPTS).optional(),
});

export type ConnectionJobData = z.infer<typeof connectionJobDataSchema>;

export type ConnectionQueue = 'token-refresh' | 'profiles-sync';

export interface ScheduledRetry {
  queue: ConnectionQueue;
  job: ConnectionJobData;
  startAfterSeconds: number;
}

export interface ConnectionJobDeps {
  db: Db;
  logger: Logger;
  amazonAds: Pick<AmazonAdsClient, 'listProfiles' | 'getAccessToken' | 'invalidateAccessToken'>;
  /** Plant denselben Job später erneut ein (pg-boss `startAfter`); `false`, wenn schon einer wartet. */
  scheduleRetry(retry: ScheduledRetry): Promise<boolean>;
}

export const REAUTH_REQUIRED_MESSAGE =
  'Amazon hat den Refresh-Token abgelehnt. Die Connection muss neu verbunden werden.';

export interface LoadedConnection extends ConnectionRef {
  /** Refresh-Token (verschlüsselt) beim Start des Jobs: Nur dieser darf als abgelehnt markiert werden. */
  refreshTokenEncrypted: string;
}

/** Lädt die Connection im Org-Kontext des Jobs. Connections mit `reauth_required` laufen nicht. */
export async function loadConnection(db: Db, job: ConnectionJobData): Promise<LoadedConnection> {
  const row = await findJobConnection(db, job);
  if (!row) throw new JobFailure('Connection nicht gefunden.');
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
