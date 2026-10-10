import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccessDeniedError } from './access';
import { createFileProfile } from './file-profiles';
import {
  claimNextFileImport,
  createFileImport,
  FileImportError,
  finishFileImport,
  listFileImports,
  campaignOwnership,
  hasClaimableFileImport,
  listProfilesWithOpenFileImports,
} from './file-imports';
import {
  amazonAdsCampaigns,
  amazonAdsProfiles,
  auditEvents,
  fileImportContents,
  fileImports,
  members,
  notifications,
  users,
} from './schema';
import { createTestConnection, createTestOrganization, createTestProfile } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/** Hochgeladene Dateien und ihr Import (`phase-1.md` 1.11c). */

let testDb: TestDatabase;
const ids = {
  org: '',
  otherOrg: '',
  admin: '',
  editor: '',
  outsider: '',
  profile: '',
  hiddenProfile: '',
  apiProfile: '',
  foreignProfile: '',
};

const content = new TextEncoder().encode('Datum,Kampagnen-ID\n2026-09-01,1\n');
const noEnqueue = async () => {};

const upload = (overrides: Partial<Parameters<typeof createFileImport>[1]> = {}) =>
  createFileImport(testDb.db, {
    userId: ids.admin,
    orgId: ids.org,
    profileId: ids.profile,
    kind: 'daily_report',
    fileName: 'bericht.csv',
    content,
    enqueue: noEnqueue,
    // Fester Tag: Die Zeiträume der Tests (September 2026) sollen nicht irgendwann „zu alt“ sein.
    now: new Date('2026-10-08T10:00:00Z'),
    ...overrides,
  });

const fileInput = {
  accountName: 'Datei',
  countryCode: 'DE',
  currencyCode: 'EUR',
  timezone: 'Europe/Berlin',
  accountType: 'seller' as const,
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.org = await createTestOrganization(db, 'muuv');
  ids.otherOrg = await createTestOrganization(db, 'andere');
  const [admin, editor, outsider] = await db
    .insert(users)
    .values([
      { name: 'Ada', email: 'ada@muuv.test' },
      { name: 'Emil', email: 'emil@muuv.test' },
      { name: 'Otto', email: 'otto@andere.test' },
    ])
    .returning({ id: users.id });
  ids.admin = admin!.id;
  ids.editor = editor!.id;
  ids.outsider = outsider!.id;
  await db.insert(members).values([
    { organizationId: ids.org, userId: ids.admin, role: 'admin', createdAt: new Date() },
    { organizationId: ids.org, userId: ids.editor, role: 'editor', createdAt: new Date() },
    { organizationId: ids.otherOrg, userId: ids.outsider, role: 'admin', createdAt: new Date() },
  ]);
  ids.profile = (
    await createFileProfile(db, { userId: ids.admin, orgId: ids.org, input: fileInput })
  ).id;
  ids.hiddenProfile = (
    await createFileProfile(db, { userId: ids.admin, orgId: ids.org, input: fileInput })
  ).id;
  await db
    .update(amazonAdsProfiles)
    .set({ isHidden: true })
    .where(eq(amazonAdsProfiles.id, ids.hiddenProfile));
  ids.apiProfile = await createTestProfile(db, {
    organizationId: ids.org,
    connectionId: await createTestConnection(db, ids.org, 'amzn1.account.A'),
    amazonProfileId: '1',
  });
  ids.foreignProfile = (
    await createFileProfile(db, { userId: ids.outsider, orgId: ids.otherOrg, input: fileInput })
  ).id;
});

afterAll(() => testDb?.close());

beforeEach(async () => {
  await testDb.db.delete(fileImports);
  await testDb.db.delete(auditEvents);
  await testDb.db.delete(notifications);
});

describe('createFileImport', () => {
  it('merkt sich, ob die Datei laut Upload vollständig ist (Standard: nein)', async () => {
    expect((await upload()).complete).toBe(false);
    expect((await upload({ complete: true })).complete).toBe(true);
  });

  it('speichert Metadaten, Inhalt und Audit und plant den Job in derselben Transaktion ein', async () => {
    const enqueued: unknown[] = [];
    const created = await upload({
      enqueue: async (tx) => {
        // Innerhalb der Transaktion ist der Import schon sichtbar.
        const [row] = await tx.select({ id: fileImports.id }).from(fileImports);
        enqueued.push(row?.id);
      },
    });

    expect(created).toMatchObject({
      profileId: ids.profile,
      kind: 'daily_report',
      fileName: 'bericht.csv',
      byteSize: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
      status: 'pending',
      error: null,
      counters: {},
      uploadedBy: ids.admin,
    });
    expect(enqueued).toEqual([created.id]);
    const [stored] = await testDb.db
      .select()
      .from(fileImportContents)
      .where(eq(fileImportContents.fileImportId, created.id));
    expect(stored?.content).toEqual(content);
    const [event] = await testDb.db.select().from(auditEvents);
    expect(event).toMatchObject({
      action: 'file_import.create',
      actorUserId: ids.admin,
      target: {
        type: 'file_import',
        id: created.id,
        profileId: ids.profile,
        kind: 'daily_report',
        fileName: 'bericht.csv',
        byteSize: content.byteLength,
      },
    });
  });

  it('legt nichts an, wenn das Einplanen scheitert', async () => {
    await expect(
      upload({
        enqueue: async () => {
          throw new Error('Queue weg');
        },
      }),
    ).rejects.toThrow('Queue weg');
    expect(await testDb.db.select().from(fileImports)).toEqual([]);
    expect(await testDb.db.select().from(auditEvents)).toEqual([]);
  });

  it('nimmt auch ausgeblendete Datei-Profile an', async () => {
    await expect(upload({ profileId: ids.hiddenProfile })).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('lehnt Profile mit Connection, fremde Profile und Nicht-Admins ab', async () => {
    await expect(upload({ profileId: ids.apiProfile })).rejects.toMatchObject({
      code: 'PROFILE_HAS_CONNECTION',
    });
    await expect(upload({ profileId: ids.foreignProfile })).rejects.toBeInstanceOf(FileImportError);
    await expect(upload({ profileId: ids.foreignProfile })).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
    });
    await expect(upload({ userId: ids.editor })).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(upload({ userId: ids.outsider })).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await testDb.db.select().from(fileImports)).toEqual([]);
  });

  it('lehnt leere Dateien ab', async () => {
    await expect(upload({ content: new Uint8Array(0) })).rejects.toMatchObject({
      code: 'EMPTY_FILE',
    });
  });
});

describe('createFileImport mit von Hand angegebenem Zeitraum (2b.2c)', () => {
  const september = { startDate: '2026-09-01', endDate: '2026-09-30' };
  const renamed = { kind: 'bulk' as const, fileName: 'kunde-september.xlsx' };

  it('speichert den Zeitraum, nennt ihn im Audit-Event und in der Liste', async () => {
    const created = await upload({ ...renamed, period: september });
    expect(created).toMatchObject({ periodStart: '2026-09-01', periodEnd: '2026-09-30' });
    const [event] = await testDb.db.select().from(auditEvents);
    expect(event?.target).toMatchObject({ periodStart: '2026-09-01', periodEnd: '2026-09-30' });
    const [listed] = await listFileImports(testDb.db, {
      userId: ids.admin,
      orgId: ids.org,
      profileId: ids.profile,
    });
    expect(listed).toMatchObject({ periodStart: '2026-09-01', periodEnd: '2026-09-30' });
  });

  it('bleibt ohne Angabe leer', async () => {
    expect(await upload(renamed)).toMatchObject({ periodStart: null, periodEnd: null });
    const [event] = await testDb.db.select().from(auditEvents);
    expect(event?.target).toMatchObject({ periodStart: null, periodEnd: null });
  });

  it('ignoriert die Angabe, wenn der Dateiname selbst einen Zeitraum trägt (und prüft sie dann nicht)', async () => {
    const fileName = 'bulk-a1b2c3-20260801-20260831-1.xlsx';
    expect(await upload({ kind: 'bulk', fileName, period: september })).toMatchObject({
      periodStart: null,
      periodEnd: null,
    });
    await expect(
      upload({
        kind: 'bulk',
        fileName,
        period: { startDate: '2026-09-30', endDate: '2026-09-01' },
      }),
    ).resolves.toMatchObject({ periodStart: null });
  });

  it('lehnt verdrehte, zu lange und unmögliche Zeiträume ab', async () => {
    for (const period of [
      { startDate: '2026-09-30', endDate: '2026-09-01' },
      { startDate: '2026-06-01', endDate: '2026-09-30' },
      { startDate: '2026-02-30', endDate: '2026-03-01' },
      { startDate: '2026-09-01', endDate: '' },
    ]) {
      await expect(upload({ ...renamed, period })).rejects.toMatchObject({
        code: 'INVALID_PERIOD',
      });
    }
    expect(await testDb.db.select().from(fileImports)).toEqual([]);
  });

  it('lehnt Tage in der Zukunft ab, gemessen am Kalendertag in der Zeitzone des Profils', async () => {
    // 22:30 UTC ist in Berlin (Zeitzone des Profils) schon der 8. Oktober.
    const now = new Date('2026-10-07T22:30:00Z');
    await expect(
      upload({ ...renamed, now, period: { startDate: '2026-10-01', endDate: '2026-10-08' } }),
    ).resolves.toMatchObject({ periodEnd: '2026-10-08' });
    await expect(
      upload({ ...renamed, now, period: { startDate: '2026-10-01', endDate: '2026-10-09' } }),
    ).rejects.toMatchObject({ code: 'INVALID_PERIOD' });
  });

  it('lehnt Zeiträume ab, die mehr als 365 Tage vor „heute“ in der Zeitzone des Profils beginnen (2b.2d)', async () => {
    // 22:30 UTC ist in Berlin schon der 8. Oktober 2026: 365 Tage zurück liegt der 8. Oktober 2025.
    const now = new Date('2026-10-07T22:30:00Z');
    await expect(
      upload({ ...renamed, now, period: { startDate: '2025-10-08', endDate: '2025-10-31' } }),
    ).resolves.toMatchObject({ periodStart: '2025-10-08' });
    await expect(
      upload({ ...renamed, now, period: { startDate: '2025-10-07', endDate: '2025-10-31' } }),
    ).rejects.toMatchObject({
      code: 'INVALID_PERIOD',
      message: 'Der erste Tag darf höchstens 365 Tage zurückliegen.',
    });
    // Der Dateiname gewinnt: Eine zu alte Angabe wird dann verworfen und nicht geprüft.
    await expect(
      upload({
        kind: 'bulk',
        fileName: 'bulk-a1b2c3-20260801-20260831-1.xlsx',
        now,
        period: { startDate: '2025-09-01', endDate: '2025-09-30' },
      }),
    ).resolves.toMatchObject({ periodStart: null });
  });

  it('lässt in der Tabelle nur beide Tage oder keinen zu, von nie nach bis', async () => {
    const created = await upload(renamed);
    const set = (periodStart: string | null, periodEnd: string | null) =>
      testDb.db
        .update(fileImports)
        .set({ periodStart, periodEnd })
        .where(eq(fileImports.id, created.id));
    await expect(set('2026-09-01', null)).rejects.toThrow();
    await expect(set(null, '2026-09-30')).rejects.toThrow();
    await expect(set('2026-09-30', '2026-09-01')).rejects.toThrow();
    await expect(set('2026-09-01', '2026-09-01')).resolves.toBeDefined();
  });
});

describe('listFileImports', () => {
  it('liefert die Importe des Profils, neueste zuerst, ohne Inhalt', async () => {
    const first = await upload({ fileName: 'eins.csv' });
    const second = await upload({ fileName: 'zwei.csv' });
    await upload({ profileId: ids.hiddenProfile, fileName: 'anderes-profil.csv' });

    const rows = await listFileImports(testDb.db, {
      userId: ids.admin,
      orgId: ids.org,
      profileId: ids.profile,
    });
    expect(rows.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(JSON.stringify(rows)).not.toContain('content');
  });

  it('liefert für fremde Profile nichts', async () => {
    await expect(
      listFileImports(testDb.db, {
        userId: ids.admin,
        orgId: ids.org,
        profileId: ids.foreignProfile,
      }),
    ).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
  });
});

describe('claimNextFileImport und finishFileImport', () => {
  const scope = () => ({ organizationId: ids.org, profileId: ids.profile });
  const claimAt = (now: Date, jobRunId: string = crypto.randomUUID()) =>
    claimNextFileImport(testDb.db, { ...scope(), jobRunId, now });

  it('holt die älteste offene Datei mit Inhalt ab und setzt sie auf running', async () => {
    const first = await upload({ fileName: 'eins.csv' });
    await upload({ fileName: 'zwei.csv' });
    const now = new Date('2026-09-29T10:00:00Z');
    const runId = crypto.randomUUID();

    const claimed = await claimAt(now, runId);
    expect(claimed).toEqual({
      file: {
        id: first.id,
        kind: 'daily_report',
        fileName: 'eins.csv',
        content,
        attempts: 1,
        complete: false,
        uploadedAt: new Date(first.createdAt),
        period: null,
      },
      abandoned: 0,
    });
    const [row] = await testDb.db.select().from(fileImports).where(eq(fileImports.id, first.id));
    expect(row).toMatchObject({ status: 'running', startedAt: now, jobRunId: runId });
  });

  it('gibt den von Hand angegebenen Zeitraum an den Import weiter', async () => {
    await upload({
      kind: 'bulk',
      fileName: 'kunde.xlsx',
      period: { startDate: '2026-09-01', endDate: '2026-09-30' },
    });
    const claimed = await claimAt(new Date('2026-10-07T10:00:00Z'));
    expect(claimed.file?.period).toEqual({ startDate: '2026-09-01', endDate: '2026-09-30' });
  });

  it('schließt ab: Status, Zähler, Fehler, Ende, und löscht den Inhalt', async () => {
    const created = await upload();
    const now = new Date('2026-09-29T10:00:00Z');
    const runId = crypto.randomUUID();
    await claimAt(now, runId);
    expect(
      await finishFileImport(testDb.db, {
        organizationId: ids.org,
        id: created.id,
        jobRunId: runId,
        status: 'failed',
        error: 'Spalte „Datum“ fehlt.',
        counters: { rows: 0 },
        now,
      }),
    ).toBe(true);
    const [row] = await testDb.db.select().from(fileImports).where(eq(fileImports.id, created.id));
    expect(row).toMatchObject({
      status: 'failed',
      error: 'Spalte „Datum“ fehlt.',
      counters: { rows: 0 },
      finishedAt: now,
    });
    expect(await testDb.db.select().from(fileImportContents)).toEqual([]);
  });

  it('benachrichtigt den Uploader (Erfolg) bzw. ihn und die Admins (Fehler), je Datei einmal (5.2a)', async () => {
    const ok = await upload({ fileName: 'gut.csv' });
    const bad = await upload({ fileName: 'schlecht.csv' });
    const now = new Date('2026-09-29T10:00:00Z');
    const finish = async (id: string, status: 'imported' | 'failed') => {
      const runId = crypto.randomUUID();
      await claimAt(now, runId);
      await finishFileImport(testDb.db, {
        organizationId: ids.org,
        id,
        jobRunId: runId,
        status,
        error: status === 'failed' ? 'Spalte „Datum“ fehlt.' : null,
        counters: { rows: 3 },
        now,
      });
    };
    await finish(ok.id, 'imported');
    await finish(bad.id, 'failed');
    const rows = await testDb.db
      .select()
      .from(notifications)
      .orderBy(notifications.seq);
    expect(rows).toEqual([
      expect.objectContaining({
        organizationId: ids.org,
        profileId: ids.profile,
        audience: 'recipient',
        recipientUserId: ids.admin,
        kind: 'file_import_imported',
        severity: 'success',
        params: { fileName: 'gut.csv' },
        link: '/admin/connections',
        dedupeKey: `file_import:${ok.id}`,
      }),
      expect.objectContaining({
        audience: 'admins',
        recipientUserId: ids.admin,
        kind: 'file_import_failed',
        severity: 'error',
        params: { fileName: 'schlecht.csv', error: 'Spalte „Datum“ fehlt.' },
        dedupeKey: `file_import:${bad.id}`,
      }),
    ]);
  });

  it('benachrichtigt auch, wenn eine Datei aufgegeben wird (Inhalt fehlt)', async () => {
    const broken = await upload({ fileName: 'ohne-inhalt.csv' });
    await testDb.db
      .delete(fileImportContents)
      .where(eq(fileImportContents.fileImportId, broken.id));
    await claimAt(new Date('2026-09-29T10:00:00Z'));
    const rows = await testDb.db.select().from(notifications);
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'file_import_failed',
        params: { fileName: 'ohne-inhalt.csv', error: 'Der Inhalt der Datei fehlt.' },
      }),
    ]);
  });

  it('überschreibt beim Abschließen nie das Ergebnis eines neueren Laufs', async () => {
    const created = await upload();
    const start = new Date('2026-09-29T10:00:00Z');
    const oldRun = crypto.randomUUID();
    const newRun = crypto.randomUUID();
    await claimAt(start, oldRun);
    // Der alte Lauf hängt, nach 30 Min. holt ein neuer die Datei erneut ab und schließt sie ab.
    const later = new Date(start.getTime() + 31 * 60_000);
    await claimAt(later, newRun);
    const finish = (jobRunId: string, status: 'imported' | 'failed') =>
      finishFileImport(testDb.db, {
        organizationId: ids.org,
        id: created.id,
        jobRunId,
        status,
        error: null,
        counters: {},
        now: later,
      });
    expect(await finish(newRun, 'imported')).toBe(true);
    expect(await finish(oldRun, 'failed')).toBe(false);
    const [row] = await testDb.db.select().from(fileImports).where(eq(fileImports.id, created.id));
    expect(row).toMatchObject({ status: 'imported', jobRunId: newRun });
  });

  it('liefert nichts, wenn nichts offen ist oder eine Datei gerade läuft', async () => {
    const now = new Date('2026-09-29T10:00:00Z');
    expect(await claimAt(now)).toEqual({ file: null, abandoned: 0 });
    await upload();
    await upload();
    await claimAt(now);
    // Die zweite wartet, bis die erste fertig ist (Reihenfolge der Uploads).
    expect(await claimAt(now)).toEqual({ file: null, abandoned: 0 });
  });

  it('holt eine hängende Datei nach 30 Minuten erneut ab und gibt nach drei Versuchen auf (gezählt)', async () => {
    const created = await upload();
    const next = await upload({ fileName: 'danach.csv' });
    let now = new Date('2026-09-29T10:00:00Z');
    expect((await claimAt(now)).file?.attempts).toBe(1);
    now = new Date(now.getTime() + 29 * 60_000);
    expect((await claimAt(now)).file).toBeNull();
    now = new Date(now.getTime() + 2 * 60_000);
    expect((await claimAt(now)).file?.attempts).toBe(2);
    now = new Date(now.getTime() + 31 * 60_000);
    expect((await claimAt(now)).file?.attempts).toBe(3);
    now = new Date(now.getTime() + 31 * 60_000);
    // Aufgegeben und gezählt; die nächste Datei kommt sofort dran.
    expect(await claimAt(now)).toMatchObject({ file: { id: next.id }, abandoned: 1 });
    const [row] = await testDb.db.select().from(fileImports).where(eq(fileImports.id, created.id));
    expect(row).toMatchObject({ status: 'failed', finishedAt: now });
    expect(row?.error).toContain('abgebrochen');
  });

  it('übergeht eine Datei ohne Inhalt (gezählt) und holt die nächste ab', async () => {
    const broken = await upload({ fileName: 'ohne-inhalt.csv' });
    const next = await upload({ fileName: 'gut.csv' });
    await testDb.db
      .delete(fileImportContents)
      .where(eq(fileImportContents.fileImportId, broken.id));
    const now = new Date('2026-09-29T10:00:00Z');
    expect(await claimAt(now)).toMatchObject({ file: { id: next.id }, abandoned: 1 });
    const [row] = await testDb.db.select().from(fileImports).where(eq(fileImports.id, broken.id));
    expect(row).toMatchObject({ status: 'failed', error: 'Der Inhalt der Datei fehlt.' });
  });

  it('holt keine Dateien anderer Profile oder Organisationen', async () => {
    await upload({ profileId: ids.hiddenProfile });
    const now = new Date('2026-09-29T10:00:00Z');
    expect((await claimAt(now)).file).toBeNull();
    expect(
      (
        await claimNextFileImport(testDb.db, {
          organizationId: ids.otherOrg,
          profileId: ids.hiddenProfile,
          jobRunId: crypto.randomUUID(),
          now,
        })
      ).file,
    ).toBeNull();
  });
});

describe('hasClaimableFileImport', () => {
  it('ist wahr bei wartenden oder hängenden Dateien, solange keine andere gerade läuft', async () => {
    const scope = { organizationId: ids.org, profileId: ids.profile };
    const now = new Date('2026-09-29T10:00:00Z');
    expect(await hasClaimableFileImport(testDb.db, { ...scope, now })).toBe(false);
    await upload();
    await upload();
    expect(await hasClaimableFileImport(testDb.db, { ...scope, now })).toBe(true);
    await claimNextFileImport(testDb.db, { ...scope, jobRunId: crypto.randomUUID(), now });
    expect(await hasClaimableFileImport(testDb.db, { ...scope, now })).toBe(false);
    expect(
      await hasClaimableFileImport(testDb.db, {
        ...scope,
        now: new Date(now.getTime() + 30 * 60_000),
      }),
    ).toBe(true);
  });
});

describe('listProfilesWithOpenFileImports', () => {
  it('nennt Profile mit wartenden oder hängenden Dateien, nicht mit laufenden oder fertigen', async () => {
    const now = new Date('2026-09-29T10:00:00Z');
    await upload({ profileId: ids.profile });
    expect(await listProfilesWithOpenFileImports(testDb.db, { now })).toEqual([
      { organizationId: ids.org, profileId: ids.profile },
    ]);
    // Läuft gerade (noch nicht hängend): kein neuer Lauf nötig.
    await claimNextFileImport(testDb.db, {
      organizationId: ids.org,
      profileId: ids.profile,
      jobRunId: crypto.randomUUID(),
      now,
    });
    expect(await listProfilesWithOpenFileImports(testDb.db, { now })).toEqual([]);
    // Nach 30 Min. gilt sie als hängend (Absturz, Deploy).
    expect(
      await listProfilesWithOpenFileImports(testDb.db, {
        now: new Date(now.getTime() + 30 * 60_000),
      }),
    ).toEqual([{ organizationId: ids.org, profileId: ids.profile }]);
  });
});

describe('campaignOwnership', () => {
  it('nennt Profile, denen Kampagnen-IDs schon gehören, und wie viele zum eigenen Profil passen', async () => {
    const { db } = testDb;
    const campaign = (profileId: string, amazonCampaignId: string) => ({
      organizationId: ids.org,
      profileId,
      amazonCampaignId,
      adProduct: 'SPONSORED_PRODUCTS',
      name: amazonCampaignId,
      state: 'ENABLED',
      syncedAt: new Date(),
    });
    await db
      .insert(amazonAdsCampaigns)
      .values([campaign(ids.profile, '111'), campaign(ids.hiddenProfile, '222')]);
    const scope = { organizationId: ids.org, profileId: ids.profile };

    expect(await campaignOwnership(db, { ...scope, amazonCampaignIds: ['111', '333'] })).toEqual({
      existing: 1,
      matched: 1,
      otherProfiles: [],
    });
    expect(await campaignOwnership(db, { ...scope, amazonCampaignIds: ['222', '333'] })).toEqual({
      existing: 1,
      matched: 0,
      otherProfiles: [{ id: ids.hiddenProfile, accountName: 'Datei', isHidden: true }],
    });
    // Andere Organisationen zählen nie.
    expect(
      await campaignOwnership(db, {
        organizationId: ids.otherOrg,
        profileId: ids.foreignProfile,
        amazonCampaignIds: ['111'],
      }),
    ).toEqual({ existing: 0, matched: 0, otherProfiles: [] });
    await db.delete(amazonAdsCampaigns);
  });
});
