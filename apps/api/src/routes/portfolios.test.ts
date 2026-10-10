import { schema } from '@profitbash/db';
import { seedAdChangeFixture, type AdChangeFixture } from '@profitbash/db/testing';
import type {
  AdChangeSubmissionDetail,
  ErrorResponse,
  PortfolioListResponse,
} from '@profitbash/shared';
import { openXlsx } from '@profitbash/sheets';
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
  adChangeSubmissions,
  amazonAdsPortfolios,
  amazonAdsProfiles,
  auditEvents,
  campaignSetupItems,
  orgEntitlements,
} = schema;

/**
 * Portfolio anlegen über die API (`phase-4.md` 4.7, F9): Liste je Profil, Anlage als Übermittlung per Bulk-Datei
 * (Blatt „Portfolios“). Je Endpunkt: Recht `write`, fremde Organisation, ausgeblendetes Profil, Entitlement `tools`.
 */

let ctx: TestContext;
let f: AdChangeFixture;
let other: AdChangeFixture;
let admin = '';
let editor = '';
let viewer = '';
let foreign = '';

async function call<T>(method: string, path: string, cookie?: string, json?: unknown) {
  const res = await request(ctx, `/api${path}`, { method, cookie, json });
  return { status: res.status, body: await readJson<T & ErrorResponse>(res) };
}
const create = (cookie: string, body: Record<string, unknown> = {}) =>
  call<{ submission: { id: string; kind: string } }>('POST', '/ads/tools/portfolios', cookie, {
    profileId: f.profile,
    name: 'Garten',
    budget: { amount: '500.00', policy: 'dateRange', startDate: '2026-11-01', endDate: null },
    ...body,
  });
const list = (cookie: string, profileId = f.profile) =>
  call<PortfolioListResponse>('GET', `/ads/tools/portfolios?profileId=${profileId}`, cookie);

beforeAll(async () => {
  ctx = await createTestContext();
  const { db } = ctx.testDb;
  const orgId = ctx.seeded.organizationId;
  const editorUser = await createUser(ctx, {
    email: 'editor@muuv.test',
    org: { id: orgId, role: 'editor' },
  });
  await createUser(ctx, { email: 'viewer@muuv.test', org: { id: orgId, role: 'viewer' } });
  f = await seedAdChangeFixture(db, 'muuv-api', {
    org: orgId,
    ada: ctx.seeded.userId,
    emil: editorUser.id,
  });
  other = await seedAdChangeFixture(db, 'fremd-portfolio');
  await db.insert(orgEntitlements).values({ organizationId: other.org, feature: 'tools' });
  await createUser(ctx, { email: 'fremd@andere.test', org: { id: other.org, role: 'admin' } });
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
  viewer = await signIn(ctx, 'viewer@muuv.test');
  foreign = await signIn(ctx, 'fremd@andere.test');
  await db.insert(amazonAdsPortfolios).values({
    organizationId: orgId,
    profileId: f.profile,
    amazonPortfolioId: '7001',
    name: 'Bestand',
  });
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  const { db } = ctx.testDb;
  await db.delete(campaignSetupItems);
  await db.delete(adChangeSubmissions);
  await db.delete(auditEvents);
  await db.update(amazonAdsProfiles).set({ isHidden: false });
});

describe('Portfolios (/api/ads/tools/portfolios)', () => {
  it('legt ein Portfolio als Bulk-Datei an; die Seite „Änderungen“ liefert Datei und Zeile', async () => {
    const created = await create(editor);
    expect(created.status).toBe(201);
    expect(created.body.submission.kind).toBe('portfolio');
    const id = created.body.submission.id;

    const detail = await call<AdChangeSubmissionDetail>(
      'GET',
      `/ads/changes/submissions/${id}`,
      editor,
    );
    expect(detail.body.setupItems).toEqual([
      expect.objectContaining({ entityType: 'portfolio', campaignRef: 'Garten' }),
    ]);
    const file = await request(ctx, `/api/ads/changes/submissions/${id}/bulk-file`, {
      cookie: editor,
    });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toMatch(/filename="profitbash-portfolio-/);
    const workbook = openXlsx(new Uint8Array(await file.arrayBuffer()));
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(['Portfolios']);

    const listed = await list(viewer);
    expect(listed.status).toBe(200);
    expect(listed.body.portfolios.map((portfolio) => portfolio.name)).toEqual(['Bestand']);
    expect(listed.body.pending).toEqual([
      expect.objectContaining({ name: 'Garten', submissionId: id, status: 'submitted' }),
    ]);
  });

  it('lehnt doppelte Namen und ungültige Budgets ab', async () => {
    const taken = await create(editor, { name: 'bestand' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('PORTFOLIO_NAME_TAKEN');
    const invalid = await create(editor, {
      budget: { amount: '10', policy: 'dateRange', startDate: '2026-11-01', endDate: '2026-10-01' },
    });
    expect(invalid.status).toBe(400);
  });

  it('Viewer legen nicht an; fremde Organisationen und ausgeblendete Profile sehen nichts', async () => {
    expect((await create(viewer)).status).toBe(403);
    expect((await create(foreign)).status).toBe(404);
    expect((await list(foreign)).status).toBe(404);
    await ctx.testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, f.profile));
    expect((await list(admin)).status).toBe(404);
    expect((await create(admin)).status).toBe(404);
  });

  it('verlangt das Feature „tools“', async () => {
    await ctx.testDb.db
      .delete(orgEntitlements)
      .where(eq(orgEntitlements.organizationId, other.org));
    expect((await list(foreign, other.profile)).status).toBe(403);
    await ctx.testDb.db
      .insert(orgEntitlements)
      .values({ organizationId: other.org, feature: 'tools' });
  });
});
