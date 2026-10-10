import { z } from 'zod';

/**
 * Benachrichtigungen in der App (`docs/tasks/phase-5.md` 5.2a, F8): Glocke und Liste, live per SSE. Texte kommen
 * aus i18n-Keys je Art (`notifications.kinds.<kind>`), die Parameter liefert der Server.
 */

export const NOTIFICATION_KINDS = [
  'file_import_imported',
  'file_import_failed',
  'submission_finished',
  'submission_failed',
  'bulk_file_stale',
  'consent_expiring',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_SEVERITIES = ['info', 'success', 'warning', 'error'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/**
 * Wer eine Benachrichtigung sieht (Dominik, 2026-10-10), immer nur Mitglieder, die das Profil sehen:
 * `members` alle; `admins` Org-Admins und der Empfänger; `recipient` nur der Empfänger.
 */
export const NOTIFICATION_AUDIENCES = ['members', 'admins', 'recipient'] as const;
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Stufen der Erinnerung vor dem Ablauf der Amazon-Einwilligung, in Tagen. */
export const CONSENT_REMINDER_DAYS = [30, 14, 3] as const;

/**
 * Kleinste erreichte Erinnerungsstufe vor dem Ablauf (30, 14 oder 3 Tage), `null` außerhalb der 30 Tage oder nach
 * dem Ablauf. Die Stufe steckt im Schlüssel gegen Dubletten: je Stufe genau eine Meldung, auch wenn ein Tag ausfällt.
 */
export function consentReminderStage(expiresAt: Date, now: Date): number | null {
  const remaining = expiresAt.getTime() - now.getTime();
  if (remaining <= 0) return null;
  let stage: number | null = null;
  for (const days of CONSENT_REMINDER_DAYS) {
    if (remaining <= days * DAY_MS) stage = days;
  }
  return stage;
}

/** Ab so vielen Tagen ohne neue Bulk-Datei warnt ProfitBash (wöchentlicher Download, ein Tag Puffer). */
export const BULK_FILE_STALE_DAYS = 8;

/**
 * Wie viele volle Wochen seit Tag 8 ohne neue Bulk-Datei vergangen sind (0 ab Tag 8, 1 ab Tag 15 …), `null` davor.
 * Je Woche eine Meldung je Profil.
 */
export function bulkFileStaleWeek(lastFileAt: Date, now: Date): number | null {
  const days = (now.getTime() - lastFileAt.getTime()) / DAY_MS;
  if (days < BULK_FILE_STALE_DAYS) return null;
  return Math.floor((days - BULK_FILE_STALE_DAYS) / 7);
}

/** Gelesene Benachrichtigungen verschwinden nach so vielen Tagen, ungelesene nach `NOTIFICATION_MAX_AGE_DAYS`. */
export const NOTIFICATION_READ_RETENTION_DAYS = 90;
export const NOTIFICATION_MAX_AGE_DAYS = 365;

export const NOTIFICATION_PAGE_MAX = 100;
export const NOTIFICATION_READ_IDS_MAX = 200;

export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);

export const notificationSchema = z
  .object({
    id: z.uuid(),
    /** Fortlaufende Nummer, Reihenfolge und `Last-Event-ID` des SSE-Kanals. */
    seq: z.number().int(),
    kind: notificationKindSchema,
    severity: z.enum(NOTIFICATION_SEVERITIES),
    profileId: z.uuid().nullable(),
    profileName: z.string().nullable(),
    /** Parameter für den i18n-Text (Dateiname, Anzahl …). */
    params: z.record(z.string(), z.union([z.string(), z.number()])),
    /** Ziel in der App (Route), wenn es eins gibt. */
    link: z.string().nullable(),
    createdAt: z.string(),
    readAt: z.string().nullable(),
  })
  .meta({ id: 'Notification' });
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListQuerySchema = z.object({
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  kind: notificationKindSchema.optional(),
  profileId: z.uuid().optional(),
  /** Nur ältere als diese Nummer (nächste Seite). */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(NOTIFICATION_PAGE_MAX).default(50),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export const notificationListResponseSchema = z
  .object({
    items: z.array(notificationSchema),
    /** `before` für die nächste Seite, `null` am Ende. */
    nextBefore: z.number().int().nullable(),
  })
  .meta({ id: 'NotificationListResponse' });
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

export const notificationUnreadCountResponseSchema = z
  .object({ count: z.number().int() })
  .meta({ id: 'NotificationUnreadCountResponse' });

export const markNotificationsReadRequestSchema = z
  .union([
    z.strictObject({ ids: z.array(z.uuid()).min(1).max(NOTIFICATION_READ_IDS_MAX) }),
    z.strictObject({ all: z.literal(true) }),
  ])
  .meta({ id: 'MarkNotificationsReadRequest' });
export type MarkNotificationsReadRequest = z.infer<typeof markNotificationsReadRequestSchema>;

export const markNotificationsReadResponseSchema = z
  .object({ updated: z.number().int() })
  .meta({ id: 'MarkNotificationsReadResponse' });
