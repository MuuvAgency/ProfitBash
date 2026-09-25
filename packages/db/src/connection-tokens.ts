import { connectionTokenAad, decrypt, encrypt, type Keyring } from '@profitbash/shared/crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { connections } from './schema';

/**
 * Refresh-Tokens der Connections, verschlüsselt mit AAD über den natürlichen Schlüssel
 * (`connectionTokenAad`). Erfüllt die `RefreshTokenStore`-Schnittstelle von `@profitbash/amazon-ads`
 * und ist anbieterneutral.
 */

export class ConnectionNotFoundError extends Error {
  constructor() {
    super('Connection nicht gefunden.');
    this.name = 'ConnectionNotFoundError';
  }
}

export interface ConnectionTokenRefreshOutcome<T> {
  result: T;
  /** Neuer Refresh-Token nach Rotation, sonst `null`. */
  rotatedRefreshToken: string | null;
}

export interface ConnectionTokenStore {
  /**
   * Führt `refresh` unter einer Zeilensperre der Connection aus. Ein rotierter Token wird verschlüsselt
   * gespeichert, bevor die Sperre fällt; so überschreiben sich API und Worker nie gegenseitig einen
   * rotierten Token. `last_refreshed_at` wird bei Erfolg gesetzt. Scheitert `refresh`, bleibt die Zeile
   * unverändert.
   */
  withRefreshToken<T>(
    connection: { id: string; organizationId: string },
    refresh: (refreshToken: string) => Promise<ConnectionTokenRefreshOutcome<T>>,
  ): Promise<T>;
}

export interface ConnectionTokenStoreOptions {
  db: Db;
  keyring: Keyring;
  /**
   * So lange wartet ein zweiter Refresh auf die Sperre, danach scheitert er (der Aufrufer bzw. Job
   * versucht es später erneut). Standard 20 s; der LWA-Aufruf unter der Sperre ist knapper begrenzt.
   */
  lockTimeoutMs?: number;
}

export function createConnectionTokenStore(
  options: ConnectionTokenStoreOptions,
): ConnectionTokenStore {
  const { db, keyring } = options;
  const lockTimeoutMs = Math.max(1, Math.floor(options.lockTimeoutMs ?? 20_000));

  return {
    withRefreshToken(connection, refresh) {
      return db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`));

        // FOR NO KEY UPDATE statt FOR UPDATE: serialisiert Refreshes und andere Updates der Zeile,
        // blockiert aber keine Inserts, deren Fremdschlüssel auf die Connection zeigt (FOR KEY SHARE,
        // z. B. Profil-Upserts im profiles-sync). Sonst könnte ein Sync, der in seiner Transaktion
        // einen Refresh auslöst, auf sich selbst warten.
        const [row] = await tx
          .select({
            organizationId: connections.organizationId,
            provider: connections.provider,
            region: connections.region,
            externalAccountId: connections.externalAccountId,
            refreshTokenEncrypted: connections.refreshTokenEncrypted,
          })
          .from(connections)
          .where(
            and(
              eq(connections.id, connection.id),
              eq(connections.organizationId, connection.organizationId),
            ),
          )
          .for('no key update');
        if (!row) throw new ConnectionNotFoundError();

        const aad = connectionTokenAad(row);
        const refreshToken = decrypt(row.refreshTokenEncrypted, { keyring, aad });

        // Die Sperre hält während des Aufrufs an Amazon; der Client begrenzt ihn (Timeout, wenige Versuche).
        const { result, rotatedRefreshToken } = await refresh(refreshToken);

        if (rotatedRefreshToken !== null && !rotatedRefreshToken) {
          throw new TypeError('Rotierter Refresh-Token darf nicht leer sein.');
        }
        // Scheitert das Speichern nach einer echten Rotation, ist der neue Token verloren und die
        // Connection braucht später eine neue Einwilligung. Der Client loggt diesen Fall als Fehler.
        await tx
          .update(connections)
          .set({
            lastRefreshedAt: new Date(),
            ...(rotatedRefreshToken !== null && {
              refreshTokenEncrypted: encrypt(rotatedRefreshToken, { keyring, aad }),
            }),
          })
          .where(eq(connections.id, connection.id));
        return result;
      });
    },
  };
}
