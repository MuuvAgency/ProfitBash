import { NOTIFICATION_KINDS, type Notification } from '@profitbash/shared';
import { describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import { notificationTexts } from './labels';

const base: Notification = {
  id: '00000000-0000-4000-8000-000000000001',
  seq: 1,
  kind: 'bulk_file_stale',
  severity: 'warning',
  profileId: '00000000-0000-4000-8000-000000000002',
  profileName: 'Nordwind DE',
  params: {},
  link: null,
  createdAt: '2026-10-10T08:00:00.000Z',
  readAt: null,
};
const texts = (patch: Partial<Notification>) => notificationTexts({ ...base, ...patch });

describe('notificationTexts', () => {
  it('hat Titel und Text für jede Art', () => {
    const { te } = i18n.global;
    const missing = NOTIFICATION_KINDS.flatMap((kind) =>
      [`notifications.kind.${kind}.title`, `notifications.kind.${kind}.text`].filter(
        (key) => !te(key),
      ),
    );
    expect(missing).toEqual([]);
  });

  it('setzt Parameter, Profil und Weg ein', () => {
    expect(texts({ kind: 'bulk_file_stale', params: { days: 9 } })).toEqual({
      title: 'Keine neue Bulk-Datei',
      text: 'Seit 9 Tagen keine neue Bulk-Datei für Nordwind DE. Die Daten veralten.',
    });
    expect(
      texts({
        kind: 'file_import_failed',
        params: { fileName: 'bulk.xlsx', error: 'Spalte fehlt.' },
      }),
    ).toEqual({ title: 'Import fehlgeschlagen', text: 'bulk.xlsx (Nordwind DE): Spalte fehlt.' });
    expect(
      texts({ kind: 'submission_failed', params: { applied: 3, failed: 1, channel: 'bulk_file' } })
        .text,
    ).toBe('Nordwind DE, Bulk-Datei: 1 Änderung fehlgeschlagen, 3 angewendet.');
    expect(
      texts({ kind: 'submission_finished', params: { applied: 1, failed: 0, channel: 'api' } })
        .text,
    ).toBe('Nordwind DE, API: 1 Änderung angewendet.');
    expect(
      texts({
        kind: 'consent_expiring',
        profileId: null,
        profileName: null,
        params: { days: 14, account: 'konto@muuv.test' },
      }).text,
    ).toBe(
      'Die Amazon-Einwilligung für konto@muuv.test läuft in 14 Tagen ab. Unter Clients & Connections neu verbinden.',
    );
  });

  it('kommt ohne Profilnamen und Fehlertext aus', () => {
    expect(
      texts({ kind: 'file_import_imported', profileName: null, params: { fileName: 'a.xlsx' } })
        .text,
    ).toBe('a.xlsx ist importiert.');
    expect(
      texts({ kind: 'file_import_failed', profileName: null, params: { fileName: 'a.xlsx' } }).text,
    ).toBe('a.xlsx: Der Import ist fehlgeschlagen.');
  });
});
