import { schema } from '@profitbash/db';
import { FILE_IMPORT_MAX_BYTES, type ErrorResponse, type FileImport } from '@profitbash/shared';
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

  it('kürzt Pfadangaben im Dateinamen auf den Namen', async () => {
    const res = await upload(ids.profile, form('bulk', 'x', 'C:\\Downloads\\..\\bulk.xlsx'));
    expect((await readJson<FileImport>(res)).fileName).toBe('bulk.xlsx');
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
