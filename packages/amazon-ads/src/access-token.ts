import { noopLogger, type Logger } from './logger';
import type { LwaClient } from './lwa';
import type { AmazonAdsRegion } from './regions';

/** Was der Client von einer Connection braucht. Der Refresh-Token kommt aus dem `RefreshTokenStore`. */
export interface ConnectionRef {
  /** Interne Connection-ID (UUID) */
  id: string;
  /** Eigentümer-Organisation: Der Store liest die Connection nur in diesem Org-Kontext. */
  organizationId: string;
  region: AmazonAdsRegion;
}

export interface RefreshOutcome<T> {
  result: T;
  /** Neuer Refresh-Token, falls Amazon rotiert hat; sonst `null` (dann wird nichts geschrieben). */
  rotatedRefreshToken: string | null;
}

/**
 * Zugriff auf den gespeicherten Refresh-Token einer Connection. Die Implementierung muss `refresh`
 * unter einer prozessübergreifenden Sperre der Connection ausführen (DB: `SELECT … FOR NO KEY UPDATE`)
 * und einen rotierten Token verschlüsselt speichern, bevor die Sperre fällt. So überschreiben sich API
 * und Worker nie gegenseitig einen rotierten Token. `createConnectionTokenStore` aus `@profitbash/db`.
 */
export interface RefreshTokenStore {
  withRefreshToken<T>(
    connection: ConnectionRef,
    refresh: (refreshToken: string) => Promise<RefreshOutcome<T>>,
  ): Promise<T>;
}

export interface AccessTokenProvider {
  getAccessToken(connection: ConnectionRef): Promise<string>;
  /** Verwirft das gecachte Token, z. B. nach einem 401 oder nach dem Neu-Verbinden. */
  invalidate(connectionId: string): void;
}

export interface AccessTokenProviderOptions {
  lwa: LwaClient;
  store: RefreshTokenStore;
  logger?: Logger;
  now?: () => number;
  /** So lange vor Ablauf wird erneuert. Standard 5 Minuten, höchstens die halbe Laufzeit. */
  refreshSkewMs?: number;
}

interface CachedToken {
  accessToken: string;
  /** Ab diesem Zeitpunkt wird erneuert (Ablauf minus Puffer). */
  refreshAt: number;
}

/**
 * Access-Tokens je Connection mit In-Memory-Cache bis kurz vor Ablauf. Gleichzeitige Anfragen derselben
 * Connection teilen sich einen Refresh (im Prozess); zwischen Prozessen serialisiert der Store.
 */
export function createAccessTokenProvider(
  options: AccessTokenProviderOptions,
): AccessTokenProvider {
  const { lwa, store } = options;
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? Date.now;
  const refreshSkewMs = options.refreshSkewMs ?? 5 * 60_000;
  const cache = new Map<string, CachedToken>();
  const inFlight = new Map<string, Promise<string>>();

  async function refresh(connection: ConnectionRef): Promise<string> {
    let rotated = false;
    try {
      const token = await store.withRefreshToken(connection, async (refreshToken) => {
        const refreshed = await lwa.refreshAccessToken({ region: connection.region, refreshToken });
        const rotatedRefreshToken =
          refreshed.refreshToken !== null && refreshed.refreshToken !== refreshToken
            ? refreshed.refreshToken
            : null;
        rotated = rotatedRefreshToken !== null;
        return { result: refreshed, rotatedRefreshToken };
      });
      const lifetimeMs = token.expiresInSeconds * 1000;
      // Kurzlebige Tokens mindestens die halbe Laufzeit nutzen, sonst würde jeder Aufruf erneuern.
      const usableMs = Math.max(lifetimeMs / 2, lifetimeMs - refreshSkewMs);
      cache.set(connection.id, { accessToken: token.accessToken, refreshAt: now() + usableMs });
      return token.accessToken;
    } catch (error) {
      if (rotated) {
        // Amazon hat rotiert, aber der neue Token wurde nicht gespeichert: Er ist verloren, und die
        // Connection wird beim nächsten Refresh eine neue Einwilligung brauchen.
        logger({
          level: 'error',
          msg: 'amazon_ads.rotated_refresh_token_not_saved',
          connectionId: connection.id,
          organizationId: connection.organizationId,
        });
      }
      throw error;
    }
  }

  return {
    getAccessToken(connection) {
      const cached = cache.get(connection.id);
      if (cached && now() < cached.refreshAt) return Promise.resolve(cached.accessToken);

      const pending = inFlight.get(connection.id);
      if (pending) return pending;

      const promise = refresh(connection).finally(() => inFlight.delete(connection.id));
      inFlight.set(connection.id, promise);
      return promise;
    },

    invalidate(connectionId) {
      cache.delete(connectionId);
    },
  };
}
