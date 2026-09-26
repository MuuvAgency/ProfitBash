import {
  ciphertextKeyId,
  connectionTokenAad,
  decrypt,
  DecryptionError,
  encrypt,
  needsReencryption,
  type Keyring,
} from '@profitbash/shared/crypto';
import { and, eq, sql } from 'drizzle-orm';
import { recordAuditEvent } from './audit';
import type { Db } from './client';
import { connections } from './schema';

/**
 * Schlüsselrotation (`docs/deploy.md`): Verschlüsselt alle Refresh-Tokens, die noch mit einem früheren
 * Schlüssel verschlüsselt sind, mit dem aktuellen neu. Plattformweiter Systemzugriff, nur für das
 * Rotations-Skript (`rotate-keys-cli.ts`).
 */

export interface ReencryptFailure {
  connectionId: string;
  organizationId: string;
  /** Meldung des `DecryptionError`; enthält nie Klartext, Schlüssel oder ungeprüfte Werte. */
  reason: string;
}

export interface ReencryptResult {
  /** Geprüfte Connections. */
  checked: number;
  /** Davon neu verschlüsselt. */
  reencrypted: number;
  /** Nicht lesbar (`DecryptionError`), übersprungen und unverändert. */
  failed: ReencryptFailure[];
}

export interface ReencryptOptions {
  db: Db;
  keyring: Keyring;
  /**
   * So lange wartet das Skript auf die Zeilensperre einer Connection (ein laufender Refresh hält sie
   * während des Aufrufs an Amazon). Danach bricht es ab; ein erneuter Lauf setzt fort. Standard 30 s.
   */
  lockTimeoutMs?: number;
}

/**
 * Je Connection eine eigene Transaktion mit Zeilensperre (wie der Token-Store): So überschreibt die
 * Rotation nie einen Token, den ein paralleler Refresh gerade rotiert hat. Wiederholbar; Zeilen mit
 * dem aktuellen Schlüssel bleiben unverändert. Kaputte Werte (`DecryptionError`) werden gemeldet und
 * übersprungen, alle anderen Fehler (z. B. Datenbank) brechen ab.
 *
 * Nebenwirkung: Der Worker merkt sich den Ciphertext beim Jobstart. Verschlüsselt die Rotation die
 * Zeile zwischen Jobstart und einer Ablehnung (`invalid_grant`) neu, greift
 * `markConnectionReauthRequired` nicht (anderer Ciphertext). Der nächste Lauf markiert die Connection.
 */
export async function reencryptConnectionTokens(
  options: ReencryptOptions,
): Promise<ReencryptResult> {
  const { db, keyring } = options;
  const lockTimeoutMs = Math.max(1, Math.floor(options.lockTimeoutMs ?? 30_000));

  const refs = await db
    .select({ id: connections.id, organizationId: connections.organizationId })
    .from(connections)
    .orderBy(connections.createdAt, connections.id);

  const result: ReencryptResult = { checked: 0, reencrypted: 0, failed: [] };
  for (const ref of refs) {
    try {
      const changed = await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`));
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
            and(eq(connections.id, ref.id), eq(connections.organizationId, ref.organizationId)),
          )
          .for('no key update');
        // Inzwischen gelöscht: nichts zu tun.
        if (!row) return null;
        if (!needsReencryption(row.refreshTokenEncrypted, keyring)) return false;

        const aad = connectionTokenAad(row);
        const plaintext = decrypt(row.refreshTokenEncrypted, { keyring, aad });
        await tx
          .update(connections)
          .set({ refreshTokenEncrypted: encrypt(plaintext, { keyring, aad }) })
          .where(eq(connections.id, ref.id));
        await recordAuditEvent(tx, {
          organizationId: ref.organizationId,
          actorUserId: null,
          action: 'connection.token_reencrypt',
          target: {
            type: 'connection',
            id: ref.id,
            fromKeyId: ciphertextKeyId(row.refreshTokenEncrypted),
            toKeyId: keyring.current.id,
          },
        });
        return true;
      });
      if (changed === null) continue;
      result.checked += 1;
      if (changed) result.reencrypted += 1;
    } catch (error) {
      if (!(error instanceof DecryptionError)) throw error;
      result.checked += 1;
      result.failed.push({
        connectionId: ref.id,
        organizationId: ref.organizationId,
        reason: error.message,
      });
    }
  }
  return result;
}
