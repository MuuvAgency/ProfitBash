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
} from './file-imports';
import {
  amazonAdsProfiles,
  auditEvents,
  fileImportContents,
  fileImports,
  members,
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
});

describe('createFileImport', () => {
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

  it('holt die älteste offene Datei mit Inhalt ab und setzt sie auf running', async () => {
    const first = await upload({ fileName: 'eins.csv' });
    await upload({ fileName: 'zwei.csv' });
    const now = new Date('2026-09-29T10:00:00Z');
    const runId = crypto.randomUUID();

    const claimed = await claimNextFileImport(testDb.db, { ...scope(), jobRunId: runId, now });
    expect(claimed).toMatchObject({
      id: first.id,
      kind: 'daily_report',
      fileName: 'eins.csv',
      content,
      attempts: 1,
    });
    const [row] = await testDb.db.select().from(fileImports).where(eq(fileImports.id, first.id));
    expect(row).toMatchObject({ status: 'running', startedAt: now, jobRunId: runId });
  });

  it('schließt ab: Status, Zähler, Fehler, Ende, und löscht den Inhalt', async () => {
    const created = await upload();
    const now = new Date('2026-09-29T10:00:00Z');
    await claimNextFileImport(testDb.db, { ...scope(), jobRunId: crypto.randomUUID(), now });
    await finishFileImport(testDb.db, {
      organizationId: ids.org,
      id: created.id,
      status: 'failed',
      error: 'Spalte „Datum“ fehlt.',
      counters: { rows: 0 },
      now,
    });
    const [row] = await testDb.db.select().from(fileImports).where(eq(fileImports.id, created.id));
    expect(row).toMatchObject({
      status: 'failed',
      error: 'Spalte „Datum“ fehlt.',
      counters: { rows: 0 },
      finishedAt: now,
    });
    expect(await testDb.db.select().from(fileImportContents)).toEqual([]);
  });

  it('liefert nichts, wenn nichts offen ist oder eine Datei gerade läuft', async () => {
    const now = new Date('2026-09-29T10:00:00Z');
    expect(
      await claimNextFileImport(testDb.db, { ...scope(), jobRunId: crypto.randomUUID(), now }),
    ).toBeNull();
    await upload();
    await upload();
    await claimNextFileImport(testDb.db, { ...scope(), jobRunId: crypto.randomUUID(), now });
    // Die zweite wartet, bis die erste fertig ist (Reihenfolge der Uploads).
    expect(
      await claimNextFileImport(testDb.db, { ...scope(), jobRunId: crypto.randomUUID(), now }),
    ).toBeNull();
  });

  it('holt eine hängende Datei nach 30 Minuten erneut ab und gibt nach drei Versuchen auf', async () => {
    const created = await upload();
    let now = new Date('2026-09-29T10:00:00Z');
    const claim = () =>
      claimNextFileImport(testDb.db, { ...scope(), jobRunId: crypto.randomUUID(), now });
    expect((await claim())?.attempts).toBe(1);
    now = new Date(now.getTime() + 29 * 60_000);
    expect(await claim()).toBeNull();
    now = new Date(now.getTime() + 2 * 60_000);
    expect((await claim())?.attempts).toBe(2);
    now = new Date(now.getTime() + 31 * 60_000);
    expect((await claim())?.attempts).toBe(3);
    now = new Date(now.getTime() + 31 * 60_000);
    expect(await claim()).toBeNull();
    const [row] = await testDb.db.select().from(fileImports).where(eq(fileImports.id, created.id));
    expect(row).toMatchObject({ status: 'failed', finishedAt: now });
    expect(row?.error).toContain('abgebrochen');
    expect(await testDb.db.select().from(fileImportContents)).toEqual([]);
  });

  it('holt keine Dateien anderer Profile oder Organisationen', async () => {
    await upload({ profileId: ids.hiddenProfile });
    const now = new Date('2026-09-29T10:00:00Z');
    expect(
      await claimNextFileImport(testDb.db, { ...scope(), jobRunId: crypto.randomUUID(), now }),
    ).toBeNull();
    expect(
      await claimNextFileImport(testDb.db, {
        organizationId: ids.otherOrg,
        profileId: ids.hiddenProfile,
        jobRunId: crypto.randomUUID(),
        now,
      }),
    ).toBeNull();
  });
});
