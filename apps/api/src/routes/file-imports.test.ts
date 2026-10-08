import { schema } from '@profitbash/db';
import {
  FILE_IMPORT_MAX_BYTES,
  todayInTimezone,
  type ErrorResponse,
  type FileImport,
} from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  type TestContext,
} from '../testing';

const {
  amazonAdsProfiles,
  auditEvents,
  connections,
  fileImportContents,
  fileImports,
  organizations,
} = schema;

/** Upload und Liste der Datei-Importe (`phase-1.md` 1.11c). */

let ctx: TestContext;
let admin: string;
let editor: string;
const ids = { profile: '', apiProfile: '', foreignProfile: '' };

const fileProfile = (organizationId: string, accountName: string) => ({
  organizationId,
  connectionId: null,
  amazonProfileId: null,
  accountName,
  countryCode: 'DE',
  currencyCode: 'EUR',
  timezone: 'Europe/Berlin',
  accountType: 'seller',
});

beforeAll(async () => {
  ctx = await createTestContext();
  const orgId = ctx.seeded.organizationId;
  await createUser(ctx, { email: 'editor@muuv.test', org: { id: orgId, role: 'editor' } });
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
  const { db } = ctx.testDb;
  const [other] = await db
    .insert(organizations)
    .values({ name: 'Andere', slug: 'andere', type: 'internal', createdAt: new Date() })
    .returning({ id: organizations.id });
  const [connection] = await db
    .insert(connections)
    .values({
      organizationId: orgId,
      provider: 'amazon_ads',
      region: 'eu',
      externalAccountId: 'amzn1.account.EINS',
      refreshTokenEncrypted: 'v1:k1:nicht-benutzt',
    })
    .returning({ id: connections.id });
  const [profile, foreign, apiProfile] = await db
    .insert(amazonAdsProfiles)
    .values([
      fileProfile(orgId, 'Waldkauz Datei'),
      fileProfile(other!.id, 'Fremd'),
      {
        ...fileProfile(orgId, 'API-Profil'),
        connectionId: connection!.id,
        amazonProfileId: '123',
      },
    ])
    .returning({ id: amazonAdsProfiles.id });
  ids.profile = profile!.id;
  ids.foreignProfile = foreign!.id;
  ids.apiProfile = apiProfile!.id;
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.testDb.db.delete(fileImports);
  await ctx.testDb.db.delete(auditEvents);
  ctx.jobs.fileImports.length = 0;
  ctx.jobs.enqueuedInTransaction.length = 0;
});

function form(kind: string, content: string | Uint8Array, fileName = 'bericht.csv') {
  const data = new FormData();
  data.set('kind', kind);
  data.set('file', new File([content], fileName, { type: 'text/csv' }));
  return data;
}

const upload = (profileId: string, data: FormData, cookie = admin) =>
  request(ctx, `/api/profiles/${profileId}/file-imports`, { method: 'POST', form: data, cookie });

async function errorCode(res: Response) {
  return (await readJson<ErrorResponse>(res)).error.code;
}

describe('POST /api/profiles/:id/file-imports', () => {
  it('nimmt die Datei an, speichert sie und plant den Import in derselben Transaktion ein', async () => {
    const text = 'Datum,Kampagnen-ID\n2026-09-01,1\n';
    const res = await upload(ids.profile, form('daily_report', text));
    expect(res.status).toBe(201);
    const created = await readJson<FileImport>(res);
    expect(created).toMatchObject({
      profileId: ids.profile,
      kind: 'daily_report',
      fileName: 'bericht.csv',
      byteSize: new TextEncoder().encode(text).byteLength,
      status: 'pending',
      error: null,
      startedAt: null,
    });
    expect(ctx.jobs.fileImports).toEqual([
      { organizationId: ctx.seeded.organizationId, profileId: ids.profile },
    ]);
    expect(ctx.jobs.enqueuedInTransaction).toEqual([true]);
    const [stored] = await ctx.testDb.db
      .select()
      .from(fileImportContents)
      .where(eq(fileImportContents.fileImportId, created.id));
    expect(new TextDecoder().decode(stored!.content)).toBe(text);
    const [event] = await ctx.testDb.db.select().from(auditEvents);
    expect(event).toMatchObject({ action: 'file_import.create' });
  });

  it('kürzt Pfadangaben im Dateinamen auf den Namen und entfernt Steuerzeichen', async () => {
    const res = await upload(ids.profile, form('bulk', 'x', 'C:\\Downloads\\..\\bulk.xlsx'));
    expect((await readJson<FileImport>(res)).fileName).toBe('bulk.xlsx');
    const tricky = await upload(ids.profile, form('bulk', 'x', 'bulk\u202Excod.exe\u0007.xlsx'));
    expect((await readJson<FileImport>(tricky)).fileName).toBe('bulkxcod.exe.xlsx');
  });

  it('nimmt keine Uploads für entfernte Profile an', async () => {
    await ctx.testDb.db
      .update(amazonAdsProfiles)
      .set({ removedAt: new Date() })
      .where(eq(amazonAdsProfiles.id, ids.profile));
    try {
      const res = await upload(ids.profile, form('bulk', 'x'));
      expect(res.status).toBe(404);
    } finally {
      await ctx.testDb.db
        .update(amazonAdsProfiles)
        .set({ removedAt: null })
        .where(eq(amazonAdsProfiles.id, ids.profile));
    }
  });

  it('nimmt das Häkchen „Datei ist vollständig“ an (Standard: nein)', async () => {
    const data = form('bulk', 'x', 'bulk.xlsx');
    data.set('complete', 'true');
    expect((await readJson<FileImport>(await upload(ids.profile, data))).complete).toBe(true);
    expect(
      (await readJson<FileImport>(await upload(ids.profile, form('bulk', 'x')))).complete,
    ).toBe(false);
    const invalid = form('bulk', 'x');
    invalid.set('complete', 'vielleicht');
    expect((await upload(ids.profile, invalid)).status).toBe(400);
  });

  describe('Zeitraum von Hand (2b.2c)', () => {
    const withPeriod = (fileName: string, periodStart?: string, periodEnd?: string) => {
      const data = form('bulk', 'x', fileName);
      if (periodStart !== undefined) data.set('periodStart', periodStart);
      if (periodEnd !== undefined) data.set('periodEnd', periodEnd);
      return upload(ids.profile, data);
    };

    /** Kalendertag `days` Tage vor `day` (`YYYY-MM-DD`). */
    const daysBefore = (day: string, days: number) =>
      new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

    it('speichert den angegebenen Zeitraum, nennt ihn im Audit-Event und in der Liste', async () => {
      // Relativ zu heute: Feste Tage wären irgendwann „zu alt“ (2b.2d).
      const today = todayInTimezone('Europe/Berlin', new Date());
      const period = { periodStart: daysBefore(today, 37), periodEnd: daysBefore(today, 8) };
      const res = await withPeriod('kunde-september.xlsx', period.periodStart, period.periodEnd);
      expect(res.status).toBe(201);
      expect(await readJson<FileImport>(res)).toMatchObject(period);
      const [event] = await ctx.testDb.db.select().from(auditEvents);
      expect(event?.target).toMatchObject(period);
      const list = await request(ctx, `/api/profiles/${ids.profile}/file-imports`, {
        cookie: admin,
      });
      expect((await readJson<{ fileImports: FileImport[] }>(list)).fileImports).toMatchObject([
        period,
      ]);
    });

    it('lehnt Zeiträume ab, die mehr als 365 Tage vor heute (Zeitzone des Profils) beginnen (2b.2d)', async () => {
      // Die API hat keine feste Uhr: deutlich innerhalb und deutlich außerhalb der Grenze, damit ein Tageswechsel
      // während des Tests nichts ändert. Die genaue Grenze (365 erlaubt, 366 nicht) prüft der DB-Test mit fester
      // Uhr (`packages/db/src/file-imports.test.ts`).
      const today = todayInTimezone('Europe/Berlin', new Date());
      const allowed = await withPeriod(
        'kunde.xlsx',
        daysBefore(today, 300),
        daysBefore(today, 280),
      );
      expect(allowed.status).toBe(201);
      expect(await readJson<FileImport>(allowed)).toMatchObject({
        periodStart: daysBefore(today, 300),
      });

      const tooOld = await withPeriod('kunde.xlsx', daysBefore(today, 400), daysBefore(today, 380));
      expect(tooOld.status).toBe(400);
      expect((await readJson<ErrorResponse>(tooOld)).error).toEqual({
        code: 'INVALID_PERIOD',
        message: 'Der erste Tag darf höchstens 365 Tage zurückliegen.',
      });
      expect(await ctx.testDb.db.select().from(fileImports)).toHaveLength(1);

      // Der Dateiname gewinnt: Die zu alte Angabe wird verworfen und nicht geprüft.
      const named = await withPeriod(
        'bulk-a1b2c3-20260801-20260831-1.xlsx',
        daysBefore(today, 400),
        daysBefore(today, 380),
      );
      expect(named.status).toBe(201);
      expect(await readJson<FileImport>(named)).toMatchObject({ periodStart: null });
    });

    it('bleibt ohne Angabe leer', async () => {
      expect(await readJson<FileImport>(await withPeriod('kunde.xlsx'))).toMatchObject({
        periodStart: null,
        periodEnd: null,
      });
    });

    it('ignoriert die Felder, wenn der Dateiname selbst einen Zeitraum trägt', async () => {
      const fileName = 'bulk-a1b2c3-20260801-20260831-1.xlsx';
      const res = await withPeriod(fileName, '2026-09-01', '2026-09-30');
      expect(res.status).toBe(201);
      expect(await readJson<FileImport>(res)).toMatchObject({
        fileName,
        periodStart: null,
        periodEnd: null,
      });
      // Auch ein unstimmiger Zeitraum stört dann nicht; nur die Schreibweise wird immer geprüft.
      expect((await withPeriod(fileName, '2026-09-30', '2026-09-01')).status).toBe(201);
      expect((await withPeriod(fileName, '30.09.2026', '01.10.2026')).status).toBe(400);
    });

    it('behandelt leere Felder wie fehlende (Formulare senden leere Texte)', async () => {
      const res = await withPeriod('kunde.xlsx', '', '');
      expect(res.status).toBe(201);
      expect(await readJson<FileImport>(res)).toMatchObject({ periodStart: null, periodEnd: null });
      const named = await withPeriod('bulk-a1b2c3-20260801-20260831-1.xlsx', '', '');
      expect(named.status).toBe(201);
      expect((await withPeriod('kunde.xlsx', '2026-09-01', '')).status).toBe(400);
    });

    it('lehnt unvollständige, verdrehte, zu lange, unmögliche und künftige Zeiträume ab', async () => {
      const dayAfterTomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      const lastWeek = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      // Form und Regeln prüft zod (`VALIDATION_ERROR`, die Meldung nennt das Feld), „nicht in der Zukunft“ die
      // DB-Schicht mit dem Kalendertag in der Zeitzone des Profils (`INVALID_PERIOD`).
      for (const [periodStart, periodEnd, code, field] of [
        ['2026-09-01', undefined, 'VALIDATION_ERROR', 'periodEnd'],
        [undefined, '2026-09-30', 'VALIDATION_ERROR', 'periodStart'],
        ['2026-09-30', '2026-09-01', 'VALIDATION_ERROR', 'periodEnd'],
        ['2026-06-01', '2026-09-30', 'VALIDATION_ERROR', 'periodEnd'],
        ['2026-02-30', '2026-03-01', 'VALIDATION_ERROR', 'periodStart'],
        ['01.09.2026', '30.09.2026', 'VALIDATION_ERROR', 'periodStart'],
        [lastWeek, dayAfterTomorrow, 'INVALID_PERIOD', ''],
      ] as const) {
        const res = await withPeriod('kunde.xlsx', periodStart, periodEnd);
        expect(res.status, `${periodStart}–${periodEnd}`).toBe(400);
        const body = await readJson<ErrorResponse>(res);
        expect(body.error.code, `${periodStart}–${periodEnd}`).toBe(code);
        expect(body.error.message, `${periodStart}–${periodEnd}`).toContain(field);
        expect(body.error.message).not.toBe('');
      }
      expect(await ctx.testDb.db.select().from(fileImports)).toEqual([]);
      const future = await withPeriod('kunde.xlsx', lastWeek, dayAfterTomorrow);
      expect(await errorCode(future)).toBe('INVALID_PERIOD');
    });
  });

  it('legt nichts an, wenn das Einplanen scheitert', async () => {
    ctx.jobs.failNext = true;
    const res = await upload(ids.profile, form('bulk', 'x'));
    expect(res.status).toBe(500);
    expect(await ctx.testDb.db.select().from(fileImports)).toEqual([]);
  });

  it('meldet ungeeignete Profile, Eingaben und Rechte', async () => {
    expect(await errorCode(await upload(ids.apiProfile, form('bulk', 'x')))).toBe(
      'PROFILE_HAS_CONNECTION',
    );
    const foreign = await upload(ids.foreignProfile, form('bulk', 'x'));
    expect(foreign.status).toBe(404);
    expect(await errorCode(foreign)).toBe('PROFILE_NOT_FOUND');
    const empty = await upload(ids.profile, form('bulk', ''));
    expect(empty.status).toBe(400);
    expect(await errorCode(empty)).toBe('EMPTY_FILE');
    expect((await upload(ids.profile, form('anderes', 'x'))).status).toBe(400);
    const withoutFile = new FormData();
    withoutFile.set('kind', 'bulk');
    expect((await upload(ids.profile, withoutFile)).status).toBe(400);
    expect((await upload(ids.profile, form('bulk', 'x'), editor)).status).toBe(403);
    expect(
      (await request(ctx, `/api/profiles/${ids.profile}/file-imports`, { method: 'POST' })).status,
    ).toBe(401);
    expect(await ctx.testDb.db.select().from(fileImports)).toEqual([]);
  });

  it('bricht zu große Requests schon beim Lesen ab (Limit der Route)', async () => {
    const res = await upload(
      ids.profile,
      form('bulk', new Uint8Array(FILE_IMPORT_MAX_BYTES + 128 * 1024)),
    );
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe('FILE_TOO_LARGE');
  });

  it('lehnt Dateien über der Grenze mit 413 ab', async () => {
    const res = await upload(ids.profile, form('bulk', new Uint8Array(FILE_IMPORT_MAX_BYTES + 1)));
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe('FILE_TOO_LARGE');
    expect(await ctx.testDb.db.select().from(fileImports)).toEqual([]);
  });
});

describe('GET /api/profiles/:id/file-imports', () => {
  it('listet die Importe des Profils, neueste zuerst', async () => {
    await upload(ids.profile, form('bulk', 'a', 'eins.xlsx'));
    await upload(ids.profile, form('daily_report', 'b', 'zwei.csv'));
    const res = await request(ctx, `/api/profiles/${ids.profile}/file-imports`, { cookie: admin });
    expect(res.status).toBe(200);
    const body = await readJson<{ fileImports: FileImport[] }>(res);
    expect(body.fileImports.map((f) => f.fileName)).toEqual(['zwei.csv', 'eins.xlsx']);
  });

  it('verweigert fremde Profile und Nicht-Admins', async () => {
    expect(
      (await request(ctx, `/api/profiles/${ids.foreignProfile}/file-imports`, { cookie: admin }))
        .status,
    ).toBe(404);
    expect(
      (await request(ctx, `/api/profiles/${ids.profile}/file-imports`, { cookie: editor })).status,
    ).toBe(403);
  });
});
