import { schema } from '@profitbash/db';
import { seedAdChangeFixture, type AdChangeFixture } from '@profitbash/db/testing';
import type {
  AdChangeSubmissionDetail,
  CampaignSetupDraft,
  CampaignSetupDraftListResponse,
  ErrorResponse,
  PlanCampaignSetupResponse,
  SubmitCampaignSetupResponse,
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
  adChangeSubmissions,
  amazonAdsProfiles,
  auditEvents,
  campaignSetupDrafts,
  campaignSetupItems,
  orgEntitlements,
  productGroupItems,
  productGroups,
} = schema;

/**
 * Kampagnen-Setup über die API (`phase-4.md` 4.5): planen, Entwürfe speichern, ändern, verwerfen und übermitteln.
 * Je Endpunkt: Recht `write`, fremde Organisation, ausgeblendetes Profil, Entitlement `tools`.
 */

let ctx: TestContext;
let f: AdChangeFixture;
let other: AdChangeFixture;
let admin = '';
let editor = '';
let viewer = '';
let foreign = '';
let groupId = '';

async function call<T>(method: string, path: string, cookie?: string, json?: unknown) {
  const res = await request(ctx, `/api/ads/tools/setup${path}`, { method, cookie, json });
  return { status: res.status, body: await readJson<T & ErrorResponse>(res) };
}

const inputs = {
  keywords: [{ text: 'trinkflasche 1l', single: true }, { text: 'trinkflasche edelstahl' }],
  brandTerms: [],
  productTargets: [],
  categories: [],
  unlocks: {},
};
const plan = (cookie: string, profileId = f.profile, productGroupId = groupId) =>
  call<PlanCampaignSetupResponse>('POST', '/plan', cookie, {
    profileId,
    productGroupId,
    presetKey: 'control',
    inputs,
  });

async function draft(cookie = editor) {
  const planned = await plan(cookie);
  const saved = await call<CampaignSetupDraft>('POST', '/drafts', cookie, {
    profileId: f.profile,
    productGroupId: groupId,
    presetKey: 'control',
    name: 'Flaschen',
    campaignState: 'ENABLED',
    inputs,
    campaigns: planned.body.campaigns,
  });
  expect(saved.status).toBe(201);
  return saved.body;
}

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
  other = await seedAdChangeFixture(db, 'fremd-setup');
  await db.insert(orgEntitlements).values({ organizationId: other.org, feature: 'tools' });
  await createUser(ctx, { email: 'fremd@andere.test', org: { id: other.org, role: 'admin' } });
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
  viewer = await signIn(ctx, 'viewer@muuv.test');
  foreign = await signIn(ctx, 'fremd@andere.test');
  const [group] = await db
    .insert(productGroups)
    .values({ organizationId: orgId, profileId: f.profile, name: 'Flaschen' })
    .returning({ id: productGroups.id });
  groupId = group!.id;
  await db.insert(productGroupItems).values({
    productGroupId: groupId,
    position: 0,
    asin: 'B0TEST0001',
    sku: 'SKU-1',
    isHero: true,
  });
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  const { db } = ctx.testDb;
  await db.delete(campaignSetupItems);
  await db.delete(campaignSetupDrafts);
  await db.delete(adChangeSubmissions);
  await db.delete(auditEvents);
  await db.update(amazonAdsProfiles).set({ isHidden: false });
});

describe('Planen (/api/ads/tools/setup/plan)', () => {
  it('plant aus Produktgruppe, Preset und Eingaben, auch für Viewer', async () => {
    const res = await plan(viewer);
    expect(res.status).toBe(200);
    expect(res.body.campaigns.map((campaign) => campaign.name)).toEqual(
      expect.arrayContaining(['SP | AUTO | Flaschen', 'SP | EXACT1 | Flaschen | trinkflasche 1l']),
    );
    expect(res.body.eurRate).toEqual({ rate: '1', date: expect.any(String) });
    expect(res.body.profileBids).toEqual({});
    expect(res.body.campaigns.every((campaign) => campaign.currencyCode === 'EUR')).toBe(true);
  });

  it('kennt nur sichtbare Profile, Gruppen desselben Profils und bekannte Presets', async () => {
    expect((await plan(foreign)).status).toBe(404);
    expect((await plan(editor, f.fileProfile)).status).toBe(404);
    const unknown = await call('POST', '/plan', editor, {
      profileId: f.profile,
      productGroupId: groupId,
      presetKey: 'gibt-es-nicht',
      inputs,
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('CAMPAIGN_SETUP_UNKNOWN_PRESET');
    await ctx.testDb.db.update(amazonAdsProfiles).set({ isHidden: true });
    expect((await plan(admin)).status).toBe(404);
  });
});

describe('Entwürfe (/api/ads/tools/setup/drafts)', () => {
  it('speichert, listet, ändert und verwirft; Viewer lesen nur', async () => {
    const saved = await draft();
    expect(saved).toMatchObject({ name: 'Flaschen', status: 'draft', version: 1 });

    const listed = await call<CampaignSetupDraftListResponse>('GET', '/drafts', viewer);
    expect(listed.body.drafts).toEqual([
      expect.objectContaining({ id: saved.id, campaigns: saved.campaigns.length }),
    ]);
    expect((await call('GET', `/drafts/${saved.id}`, viewer)).status).toBe(200);
    expect((await call('GET', `/drafts/${saved.id}`, foreign)).status).toBe(404);

    const body = {
      version: 1,
      draft: {
        profileId: f.profile,
        productGroupId: groupId,
        presetKey: 'control',
        name: 'Flaschen pausiert',
        campaignState: 'PAUSED',
        inputs,
        campaigns: saved.campaigns,
      },
    };
    expect((await call('PUT', `/drafts/${saved.id}`, viewer, body)).status).toBe(403);
    const updated = await call<CampaignSetupDraft>('PUT', `/drafts/${saved.id}`, editor, body);
    expect(updated.body).toMatchObject({ campaignState: 'PAUSED', version: 2 });
    const stale = await call('PUT', `/drafts/${saved.id}`, editor, body);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CAMPAIGN_SETUP_VERSION_CONFLICT');

    const discarded = await call<CampaignSetupDraft>(
      'POST',
      `/drafts/${saved.id}/discard`,
      editor,
      {
        version: 2,
      },
    );
    expect(discarded.body.status).toBe('discarded');
    expect(
      (await call<CampaignSetupDraftListResponse>('GET', '/drafts', editor)).body.drafts,
    ).toEqual([]);
  });

  it('übermittelt als Bulk-Datei; die Seite „Änderungen“ zeigt die Anlagen', async () => {
    const saved = await draft();
    expect(
      (
        await call('POST', `/drafts/${saved.id}/submit`, viewer, {
          version: 1,
          channel: 'bulk_file',
        })
      ).status,
    ).toBe(403);
    const res = await call<SubmitCampaignSetupResponse>(
      'POST',
      `/drafts/${saved.id}/submit`,
      editor,
      {
        version: 1,
        channel: 'bulk_file',
      },
    );
    expect(res.status).toBe(200);
    if (res.body.status !== 'submitted') throw new Error('nicht übermittelt');
    expect(res.body.submission).toMatchObject({ kind: 'setup', channel: 'bulk_file' });

    const detail = await request(ctx, `/api/ads/changes/submissions/${res.body.submission.id}`, {
      method: 'GET',
      cookie: editor,
    });
    const body = await readJson<AdChangeSubmissionDetail>(detail);
    expect(body.changes).toEqual([]);
    expect(body.setupItems[0]).toMatchObject({
      entityType: 'campaign',
      status: 'submitted',
      payload: { entity: 'campaign', name: 'SP | AUTO | Flaschen' },
    });
  });

  it('lehnt Dubletten ab und plant über die API den Job ein', async () => {
    const first = await draft();
    const second = await draft();
    const submitted = await call<SubmitCampaignSetupResponse>(
      'POST',
      `/drafts/${first.id}/submit`,
      editor,
      { version: 1, channel: 'api' },
    );
    expect(submitted.body.status).toBe('submitted');
    expect(ctx.jobs.adChangesSubmits.length).toBeGreaterThan(0);

    const rejected = await call<SubmitCampaignSetupResponse>(
      'POST',
      `/drafts/${second.id}/submit`,
      editor,
      { version: 1, channel: 'bulk_file' },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({
      status: 'rejected',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'campaignNameTaken', campaign: 'SP | AUTO | Flaschen' }),
      ]),
    });
    const [stillDraft] = await ctx.testDb.db
      .select({ status: campaignSetupDrafts.status })
      .from(campaignSetupDrafts)
      .where(eq(campaignSetupDrafts.id, second.id));
    expect(stillDraft!.status).toBe('draft');
  });

  it('verlangt das Feature „tools“', async () => {
    await ctx.testDb.db
      .delete(orgEntitlements)
      .where(eq(orgEntitlements.organizationId, other.org));
    try {
      expect((await call('GET', '/drafts', foreign)).status).toBe(403);
    } finally {
      await ctx.testDb.db
        .insert(orgEntitlements)
        .values({ organizationId: other.org, feature: 'tools' });
    }
  });
});
