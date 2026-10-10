import {
  bulkFileStaleWeek,
  consentReminderStage,
  CONSENT_REMINDER_DAYS,
  refreshTokenExpiresAt,
} from '@profitbash/shared';
import { and, eq, gte, isNull, lte, max } from 'drizzle-orm';
import type { Db } from './client';
import { createNotification } from './notifications';
import { amazonAdsProfiles, connections, fileImports } from './schema';

/**
 * Zeitgesteuerte Quellen der Benachrichtigungen (5.2a), täglich vom Job `notifications-check` aufgerufen.
 * Systemzugriffe über alle Organisationen (wie die Wartung, ADR 002); jede Benachrichtigung trägt die Organisation
 * und das Profil bzw. die Connection, gelesen wird sie nur über den Access-Layer. Schlüssel gegen Dubletten machen
 * die Aufrufe wiederholbar.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * „Keine Bulk-Datei seit 8 Tagen“ je Datei-Profil (ohne Connection, weder entfernt noch ausgeblendet), an alle
 * Mitglieder, die das Profil sehen (Dominik, 2026-10-10), einmal je Woche. Stand ist der Upload der letzten
 * importierten Bulk-Datei, ohne jede Datei die Anlage des Profils. Liefert die Zahl neuer Benachrichtigungen.
 */
export async function notifyStaleBulkFiles(db: Db, input: { now: Date }): Promise<number> {
  const p = amazonAdsProfiles;
  const rows = await db
    .select({
      organizationId: p.organizationId,
      profileId: p.id,
      createdAt: p.createdAt,
      lastFileAt: max(fileImports.createdAt),
    })
    .from(p)
    .leftJoin(
      fileImports,
      and(
        eq(fileImports.profileId, p.id),
        eq(fileImports.kind, 'bulk'),
        eq(fileImports.status, 'imported'),
      ),
    )
    .where(and(isNull(p.connectionId), isNull(p.removedAt), eq(p.isHidden, false)))
    .groupBy(p.id);
  let created = 0;
  for (const row of rows) {
    const since = row.lastFileAt ? new Date(row.lastFileAt) : row.createdAt;
    const week = bulkFileStaleWeek(since, input.now);
    if (week === null) continue;
    const id = await createNotification(db, {
      organizationId: row.organizationId,
      profileId: row.profileId,
      audience: 'members',
      kind: 'bulk_file_stale',
      severity: 'warning',
      params: { days: Math.floor((input.now.getTime() - since.getTime()) / DAY_MS) },
      // Hochladen dürfen nur Admins (Clients & Connections); die anderen bekämen eine gesperrte Seite.
      link: null,
      dedupeKey: `bulk_file_stale:${row.profileId}:${since.toISOString()}:${week}`,
    });
    if (id) created += 1;
  }
  return created;
}

/**
 * Erinnerung an den Ablauf der Amazon-Einwilligung (30, 14, 3 Tage vorher) je Connection, nur an Org-Admins (nur
 * sie verbinden neu, Dominik 2026-10-10), je Stufe einmal. Ohne Einwilligungszeitpunkt keine Erinnerung.
 */
export async function notifyExpiringConsents(db: Db, input: { now: Date }): Promise<number> {
  const earliest = new Date(input.now.getTime() - 365 * DAY_MS);
  const latest = new Date(
    input.now.getTime() - (365 - Math.max(...CONSENT_REMINDER_DAYS)) * DAY_MS,
  );
  const rows = await db
    .select({
      id: connections.id,
      organizationId: connections.organizationId,
      consentedAt: connections.consentedAt,
      email: connections.externalAccountEmail,
    })
    .from(connections)
    .where(
      and(gte(connections.consentedAt, earliest), lte(connections.consentedAt, latest)),
    );
  let created = 0;
  for (const row of rows) {
    const expiresAt = refreshTokenExpiresAt(row.consentedAt)!;
    const stage = consentReminderStage(expiresAt, input.now);
    if (stage === null) continue;
    const id = await createNotification(db, {
      organizationId: row.organizationId,
      connectionId: row.id,
      audience: 'admins',
      kind: 'consent_expiring',
      severity: stage <= 3 ? 'error' : 'warning',
      params: {
        days: Math.ceil((expiresAt.getTime() - input.now.getTime()) / DAY_MS),
        account: row.email ?? '',
      },
      link: '/admin/connections',
      dedupeKey: `consent:${row.id}:${row.consentedAt!.toISOString()}:${stage}`,
    });
    if (id) created += 1;
  }
  return created;
}
