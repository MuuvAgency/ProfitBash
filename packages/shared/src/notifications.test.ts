import { describe, expect, it } from 'vitest';
import {
  bulkFileStaleWeek,
  consentReminderStage,
  markNotificationsReadRequestSchema,
  notificationListQuerySchema,
} from './notifications';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2099-10-10T06:00:00Z');
const inDays = (days: number) => new Date(now.getTime() + days * DAY);

describe('consentReminderStage', () => {
  it('meldet nichts, solange mehr als 30 Tage bleiben', () => {
    expect(consentReminderStage(inDays(31), now)).toBeNull();
  });

  it('liefert die kleinste erreichte Stufe (30, 14, 3 Tage)', () => {
    expect(consentReminderStage(inDays(30), now)).toBe(30);
    expect(consentReminderStage(inDays(15), now)).toBe(30);
    expect(consentReminderStage(inDays(14), now)).toBe(14);
    expect(consentReminderStage(inDays(4), now)).toBe(14);
    expect(consentReminderStage(inDays(3), now)).toBe(3);
    expect(consentReminderStage(inDays(0.5), now)).toBe(3);
  });

  it('meldet abgelaufene Einwilligungen nicht mehr als Ablauf (die Connection braucht dann ohnehin Neu-Verbinden)', () => {
    expect(consentReminderStage(inDays(0), now)).toBeNull();
    expect(consentReminderStage(inDays(-2), now)).toBeNull();
  });
});

describe('bulkFileStaleWeek', () => {
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  it('meldet nichts unter 8 Tagen', () => {
    expect(bulkFileStaleWeek(ago(7.9), now)).toBeNull();
  });

  it('zählt ab Tag 8 je angefangene Woche hoch (einmal je Woche melden)', () => {
    expect(bulkFileStaleWeek(ago(8), now)).toBe(0);
    expect(bulkFileStaleWeek(ago(14.9), now)).toBe(0);
    expect(bulkFileStaleWeek(ago(15), now)).toBe(1);
    expect(bulkFileStaleWeek(ago(29), now)).toBe(3);
  });
});

describe('notificationListQuerySchema', () => {
  it('liest Filter aus dem Query-String', () => {
    expect(
      notificationListQuerySchema.parse({ unread: 'true', before: '42', limit: '10' }),
    ).toEqual({ unread: true, before: 42, limit: 10 });
    expect(notificationListQuerySchema.parse({})).toEqual({ unread: false, limit: 50 });
  });

  it('lehnt unbekannte Arten und zu große Seiten ab', () => {
    expect(notificationListQuerySchema.safeParse({ kind: 'x' }).success).toBe(false);
    expect(notificationListQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });
});

describe('markNotificationsReadRequestSchema', () => {
  it('nimmt entweder IDs oder „alle“', () => {
    expect(
      markNotificationsReadRequestSchema.safeParse({
        ids: ['0b7e1a6c-3c2a-4a7e-9a52-4b8d8b0d2f11'],
      }).success,
    ).toBe(true);
    expect(markNotificationsReadRequestSchema.safeParse({ all: true }).success).toBe(true);
    expect(markNotificationsReadRequestSchema.safeParse({}).success).toBe(false);
    expect(
      markNotificationsReadRequestSchema.safeParse({
        all: true,
        ids: ['0b7e1a6c-3c2a-4a7e-9a52-4b8d8b0d2f11'],
      }).success,
    ).toBe(false);
  });
});
