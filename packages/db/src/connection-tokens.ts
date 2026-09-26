import { connectionTokenAad, decrypt, encrypt, type Keyring } from '@profitbash/shared/crypto';
import { and, eq, sql } from 'drizzle-orm';
import { recordAuditEvent } from './audit';
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

/**
 * Die Connection wartet auf eine neue Einwilligung (`status = 'reauth_required'`). Der Store ruft den
 * Anbieter dann nicht mehr auf: Der Refresh-Token wurde bereits abgelehnt.
 */
export class ConnectionReauthRequiredError extends Error {
  constructor() {
    super('Die Connection muss neu verbunden werden.');
    this.name = 'ConnectionReauthRequiredError';
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
   * unverändert. Bei `status = 'reauth_required'` wird `refresh` nicht aufgerufen
   * (`ConnectionReauthRequiredError`).
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
            status: connections.status,
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
        if (row.status === 'reauth_required') throw new ConnectionReauthRequiredError();

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

/**
 * Setzt `status = 'reauth_required'` (Amazon hat den Refresh-Token abgelehnt) und schreibt ein
 * Audit-Event ohne handelnden Nutzer. Eigene Transaktion: Die Transaktion des Token-Stores ist zu
 * diesem Zeitpunkt bereits zurückgerollt.
 *
 * Nur, solange noch der abgelehnte Token gespeichert ist: Ein Neu-Verbinden, das während des
 * Refreshes auf die Zeilensperre gewartet hat, ist danach bereits committet und bleibt aktiv.
 * Liefert `false`, wenn nichts geändert wurde.
 */
export async function markConnectionReauthRequired(
  db: Db,
  connection: { id: string; organizationId: string; rejectedRefreshTokenEncrypted: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(connections)
      .set({ status: 'reauth_required' })
      .where(
        and(
          eq(connections.id, connection.id),
          eq(connections.organizationId, connection.organizationId),
          eq(connections.status, 'active'),
          eq(connections.refreshTokenEncrypted, connection.rejectedRefreshTokenEncrypted),
        ),
      )
      .returning({ id: connections.id });
    if (!row) return false;
    await recordAuditEvent(tx, {
      organizationId: connection.organizationId,
      actorUserId: null,
      action: 'connection.reauth_required',
      target: { type: 'connection', id: connection.id },
    });
    return true;
  });
}
