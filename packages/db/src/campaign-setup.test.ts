import type { PlannedCampaign, SaveCampaignSetupDraft, SourceNegative } from '@profitbash/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import { listAdChangeSubmissions } from './ad-changes';
import {
  CampaignSetupError,
  discardCampaignSetupDraft,
  getCampaignSetupContext,
  getCampaignSetupDraft,
  loadProfileBidSuggestions,
  listCampaignSetupDrafts,
  saveCampaignSetupDraft,
  submitCampaignSetupDraft,
} from './campaign-setup';
import {
  adChangeSubmissions,
  amazonAdsProfiles,
  amazonAdsTargetDailyMetrics,
  amazonAdsPortfolios,
  auditEvents,
  campaignSetupDrafts,
  clients,
  campaignSetupItems,
  members,
  productGroups,
  users,
} from './schema';
import { createTestOrganization } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/**
 * Setup-Entwürfe (`phase-4.md` 4.4, F5, F13): speichern, lesen, verwerfen und als Übermittlung (Art `setup`) mit je
 * einer Zeile pro neuer Entity übermitteln. Sichtbar für alle mit Zugriff auf das Profil (Entwürfe gehören dem Team).
 */

let testDb: TestDatabase;
let f: AdChangeFixture;
const other = { org: '', otto: '', profile: '' };
let hiddenProfile = '';

const as = (userId: string, orgId = f.org) => ({ userId, orgId });
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CampaignSetupError) return err.code;
    throw err;
  }
  return null;
};

const campaign = (name: string, overrides: Partial<PlannedCampaign> = {}): PlannedCampaign => ({
  block: 'SP-KW-EXACT',
  adProduct: 'SP',
  targeting: 'keyword',
  name,
  state: 'ENABLED',
  currencyCode: 'EUR',
  dailyBudget: '25.00',
  biddingStrategy: 'SALES_DOWN_ONLY',
  sdOptimization: null,
  costType: 'cpc',
  offAmazon: false,
  placements: { topOfSearch: 20, productPages: 0, restOfSearch: 0 },
  adGroup: { name, defaultBid: '0.85' },
  ads: [{ asin: 'B0TEST0001', sku: 'SKU-1' }],
  targets: [{ type: 'keyword', text: 'trinkflasche', matchType: 'exact', bid: '0.90' }],
  negatives: [{ type: 'keyword', text: 'glas', matchType: 'negativePhrase' }],
  ...overrides,
});

const draftInput = (overrides: Partial<SaveCampaignSetupDraft> = {}): SaveCampaignSetupDraft => ({
  profileId: f.profile,
  productGroupId: null,
  presetKey: 'muuv-standard',
  name: 'Flaschen',
  campaignState: 'ENABLED',
  inputs: {
    keywords: [],
    brandTerms: [],
    productTargets: [],
    categories: [],
    harvest: [],
    unlocks: {},
  },
  campaigns: [campaign('SP | EXACT | Flaschen')],
  sourceNegatives: [],
  portfolioId: null,
  ...overrides,
});

const save = async (overrides: Partial<SaveCampaignSetupDraft> = {}, userId = f.ada) =>
  (await saveCampaignSetupDraft(testDb.db, { ...as(userId), draft: draftInput(overrides) }))!;

const noEnqueue = async () => undefined;
const submit = (
  draftId: string,
  version: number,
  extra: Partial<Parameters<typeof submitCampaignSetupDraft>[1]> = {},
) =>
  submitCampaignSetupDraft(testDb.db, {
    ...as(f.emil),
    draftId,
    version,
    channel: 'bulk_file',
    enqueue: noEnqueue,
    limitFor: () => null,
    ...extra,
  });

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  f = await seedAdChangeFixture(db);
  other.org = await createTestOrganization(db, 'andere');
  const [otto] = await db
    .insert(users)
    .values({ name: 'Otto', email: 'otto@andere.test' })
    .returning({ id: users.id });
  other.otto = otto!.id;
  await db.insert(members).values({
    organizationId: other.org,
    userId: other.otto,
    role: 'admin',
    createdAt: new Date(),
  });
  const base = { countryCode: 'DE', currencyCode: 'EUR', timezone: 'Europe/Berlin' };
  const [foreign] = await db
    .insert(amazonAdsProfiles)
    .values({ ...base, organizationId: other.org, accountName: 'Fremd', accountType: 'seller' })
    .returning({ id: amazonAdsProfiles.id });
  other.profile = foreign!.id;
  const [hidden] = await db
    .insert(amazonAdsProfiles)
    .values({
      ...base,
      organizationId: f.org,
      accountName: 'Versteckt',
      accountType: 'seller',
      isHidden: true,
    })
    .returning({ id: amazonAdsProfiles.id });
  hiddenProfile = hidden!.id;
});

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  const { db } = testDb;
  await db.delete(campaignSetupItems);
  await db.delete(campaignSetupDrafts);
  await db.delete(adChangeSubmissions);
  await db.delete(auditEvents);
});

describe('saveCampaignSetupDraft', () => {
  it('legt einen Entwurf an und ändert ihn mit Version, mit Audit', async () => {
    const created = await save();
    expect(created).toMatchObject({
      profileId: f.profile,
      name: 'Flaschen',
      status: 'draft',
      campaignState: 'ENABLED',
      version: 1,
      createdBy: f.ada,
      submissionId: null,
    });
    expect(created.campaigns).toHaveLength(1);

    const updated = (await saveCampaignSetupDraft(testDb.db, {
      ...as(f.emil),
      draftId: created.id,
      version: 1,
      draft: draftInput({ name: 'Flaschen 2', campaignState: 'PAUSED' }),
    }))!;
    expect(updated).toMatchObject({ name: 'Flaschen 2', campaignState: 'PAUSED', version: 2 });
    expect(updated.updatedBy).toBe(f.emil);

    const events = await testDb.db.select().from(auditEvents);
    expect(events.map((event) => event.action).sort()).toEqual([
      'campaign_setup_draft.create',
      'campaign_setup_draft.update',
    ]);
  });

  it('meldet gleichzeitige Änderungen (Version) und ändert keine übermittelten Entwürfe', async () => {
    const created = await save();
    const again = () =>
      saveCampaignSetupDraft(testDb.db, {
        ...as(f.ada),
        draftId: created.id,
        version: 1,
        draft: draftInput(),
      });
    await again();
    expect(await code(again())).toBe('VERSION_CONFLICT');

    await submit(created.id, 2);
    expect(
      await code(
        saveCampaignSetupDraft(testDb.db, {
          ...as(f.ada),
          draftId: created.id,
          version: 2,
          draft: draftInput(),
        }),
      ),
    ).toBe('NOT_DRAFT');
  });

  it('nimmt nur sichtbare Profile, Gruppen desselben Profils und bekannte Presets', async () => {
    expect(await code(save({ profileId: other.profile }))).toBe('NOT_FOUND');
    expect(await code(save({ profileId: hiddenProfile }))).toBe('NOT_FOUND');
    expect(await code(save({ presetKey: 'gibt-es-nicht' }))).toBe('UNKNOWN_PRESET');

    const [group] = await testDb.db
      .insert(productGroups)
      .values({ organizationId: f.org, profileId: f.fileProfile, name: 'Andere Gruppe' })
      .returning({ id: productGroups.id });
    expect(await code(save({ productGroupId: group!.id }))).toBe('PRODUCT_GROUP_MISMATCH');
    expect(await code(save({ productGroupId: group!.id, profileId: f.fileProfile }))).toBeNull();
  });

  it('lässt das Profil eines Entwurfs nicht wechseln', async () => {
    const created = await save();
    expect(
      await code(
        saveCampaignSetupDraft(testDb.db, {
          ...as(f.ada),
          draftId: created.id,
          version: 1,
          draft: draftInput({ profileId: f.fileProfile }),
        }),
      ),
    ).toBe('PROFILE_CHANGED');
  });

  it('liefert null für Nicht-Mitglieder', async () => {
    expect(
      await saveCampaignSetupDraft(testDb.db, { ...as(other.otto), draft: draftInput() }),
    ).toBeNull();
  });
});

describe('Entwürfe lesen und verwerfen', () => {
  it('zeigt Entwürfe des Teams je sichtbarem Profil, ohne fremde', async () => {
    const mine = await save();
    await save({ name: 'Von Emil' }, f.emil);
    await save({ profileId: f.fileProfile, name: 'Datei' });

    const all = (await listCampaignSetupDrafts(testDb.db, as(f.emil)))!;
    expect(all.map((draft) => draft.name).sort()).toEqual(['Datei', 'Flaschen', 'Von Emil']);
    expect(all.find((draft) => draft.id === mine.id)).toMatchObject({
      createdByName: 'Ada',
      campaigns: 1,
      status: 'draft',
    });
    const onProfile = (await listCampaignSetupDrafts(testDb.db, {
      ...as(f.ada),
      profileId: f.fileProfile,
    }))!;
    expect(onProfile.map((draft) => draft.name)).toEqual(['Datei']);
    expect(await listCampaignSetupDrafts(testDb.db, as(other.otto))).toBeNull();
    expect(await listCampaignSetupDrafts(testDb.db, as(other.otto, other.org))).toEqual([]);

    expect((await getCampaignSetupDraft(testDb.db, { ...as(f.emil), draftId: mine.id }))!.id).toBe(
      mine.id,
    );
    expect(
      await code(
        getCampaignSetupDraft(testDb.db, { ...as(other.otto, other.org), draftId: mine.id }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('verwirft einen Entwurf mit Audit; verworfene erscheinen nicht mehr in der Liste', async () => {
    const created = await save();
    const discarded = (await discardCampaignSetupDraft(testDb.db, {
      ...as(f.emil),
      draftId: created.id,
      version: 1,
    }))!;
    expect(discarded.status).toBe('discarded');
    expect(await listCampaignSetupDrafts(testDb.db, as(f.ada))).toEqual([]);
    expect(
      await code(
        discardCampaignSetupDraft(testDb.db, { ...as(f.emil), draftId: created.id, version: 2 }),
      ),
    ).toBe('NOT_DRAFT');
    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'campaign_setup_draft.discard'));
    expect(event).toBeDefined();
  });
});

describe('getCampaignSetupContext', () => {
  it('nennt Profil, vorhandene Kampagnennamen, exakte Keywords und Kampagnen offener Setups', async () => {
    const created = await save({ campaigns: [campaign('Neu aus Setup')] });
    await submit(created.id, 1);

    const context = (await getCampaignSetupContext(testDb.db, {
      ...as(f.ada),
      profileId: f.profile,
    }))!;
    expect(context.profile).toMatchObject({
      countryCode: 'DE',
      currencyCode: 'EUR',
      accountType: 'seller',
      timezone: 'Europe/Berlin',
    });
    expect(context.existing.campaignNames.sort()).toEqual(['Kampagne 1001', 'Neu aus Setup']);
    // Exakte Keywords offener Setups zählen wie gebuchte (Warnung vor Dubletten).
    expect(context.existing.exactKeywords).toEqual([
      { text: 'trinkflasche', campaignName: 'Neu aus Setup' },
    ]);
    expect(
      await code(getCampaignSetupContext(testDb.db, { ...as(f.ada), profileId: hiddenProfile })),
    ).toBe('NOT_FOUND');
  });
});

describe('loadProfileBidSuggestions (F13)', () => {
  it('schlägt den mittleren CPC der letzten 60 Tage je Match-Typ bzw. Art vor, ab 30 Klicks', async () => {
    const { db } = testDb;
    const row = (targetId: string, date: string, clicks: number, cost: string) => ({
      organizationId: f.org,
      profileId: f.profile,
      targetId,
      date,
      adProduct: 'SPONSORED_PRODUCTS',
      currencyCode: 'EUR',
      importedAt: new Date(),
      impressions: clicks * 10,
      clicks,
      cost,
    });
    await db.insert(amazonAdsTargetDailyMetrics).values([
      // Keyword (BROAD): 40 Klicks, 22.40 → 0.56
      row(f.keyword, '2026-10-01', 25, '14.00'),
      row(f.keyword, '2026-09-01', 15, '8.40'),
      // Älter als 60 Tage: zählt nicht.
      row(f.keyword, '2026-07-01', 100, '500.00'),
      // Produkt-Target: nur 10 Klicks → zu wenig Daten.
      row(f.productTarget, '2026-10-01', 10, '9.00'),
    ]);
    try {
      expect(
        await loadProfileBidSuggestions(db, { profileId: f.profile, today: '2026-10-09' }),
      ).toEqual({ keyword: { broad: '0.56' } });
    } finally {
      await db.delete(amazonAdsTargetDailyMetrics);
    }
  });
});

const sourceNegative = (overrides: Partial<SourceNegative> = {}): SourceNegative => ({
  markId: '00000000-0000-4000-8000-000000000001',
  searchTerm: 'trinkflasche 1l',
  amazonCampaignId: '1001',
  amazonAdGroupId: '2001',
  campaignName: 'Kampagne 1001',
  adGroupName: 'AG 2001',
  negative: { type: 'keyword', text: 'trinkflasche 1l', matchType: 'negativeExact' },
  selected: true,
  ...overrides,
});

describe('Negatives in der Quelle (4.6)', () => {
  // Der Plan legt die Begriffe an; sonst sperrt die Prüfung das Negativ (`sourceNegativeNotPlanned`).
  const harvestCampaign = campaign('SP | EXACT | Harvest', {
    targets: [
      { type: 'keyword', text: 'trinkflasche 1l', matchType: 'exact', bid: '0.90' },
      { type: 'keyword', text: 'becher', matchType: 'exact', bid: '0.90' },
    ],
  });

  it('speichert die Vorschläge mit Auswahl im Entwurf', async () => {
    const created = await save({
      sourceNegatives: [sourceNegative(), sourceNegative({ selected: false })],
    });
    const draft = (await getCampaignSetupDraft(testDb.db, { ...as(f.ada), draftId: created.id }))!;
    expect(draft.sourceNegatives.map((entry) => entry.selected)).toEqual([true, false]);
  });

  it('übermittelt gewählte Negatives als Zeilen nach den Kampagnen', async () => {
    const created = await save({
      campaigns: [harvestCampaign],
      sourceNegatives: [
        sourceNegative(),
        sourceNegative({
          selected: false,
          negative: { type: 'keyword', text: 'becher', matchType: 'negativeExact' },
        }),
      ],
    });
    const result = await submit(created.id, 1);
    if (result?.status !== 'submitted') throw new Error(JSON.stringify(result));
    const items = await testDb.db
      .select()
      .from(campaignSetupItems)
      .where(eq(campaignSetupItems.submissionId, result.submission.id))
      .orderBy(campaignSetupItems.position);
    expect(items.at(-1)).toMatchObject({
      entityType: 'source_negative',
      campaignRef: 'Kampagne 1001',
      adGroupRef: 'AG 2001',
      status: 'submitted',
      payload: { amazonCampaignId: '1001', amazonAdGroupId: '2001' },
    });
    expect(items.filter((item) => item.entityType === 'source_negative')).toHaveLength(1);
  });

  it('sperrt fehlende Quellen und geschützte Begriffe des Clients', async () => {
    const [client] = await testDb.db
      .insert(clients)
      .values({
        organizationId: f.org,
        name: 'Flaschen GmbH',
        slug: 'flaschen',
        protectedTerms: ['trinkflasche'],
      })
      .returning({ id: clients.id });
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ clientId: client!.id })
      .where(eq(amazonAdsProfiles.id, f.profile));
    try {
      const created = await save({
        campaigns: [harvestCampaign],
        sourceNegatives: [
          sourceNegative(),
          sourceNegative({
            amazonAdGroupId: '9002',
            adGroupName: 'AG 9002',
            negative: { type: 'keyword', text: 'becher', matchType: 'negativeExact' },
          }),
        ],
      });
      expect(await submit(created.id, 1)).toEqual({
        status: 'rejected',
        issues: [
          { severity: 'error', code: 'sourceNegativeProtected', keyword: 'trinkflasche 1l' },
          {
            severity: 'error',
            code: 'sourceNegativeMissing',
            campaign: 'Kampagne 1001',
            target: 'becher',
          },
        ],
      });
    } finally {
      await testDb.db
        .update(amazonAdsProfiles)
        .set({ clientId: null })
        .where(eq(amazonAdsProfiles.id, f.profile));
      await testDb.db.delete(clients);
    }
  });
});

describe('submitCampaignSetupDraft', () => {
  it('legt eine Übermittlung der Art setup mit einer Zeile je Entity an, Eltern zuerst', async () => {
    const created = await save({
      campaignState: 'PAUSED',
      campaigns: [
        campaign('SP | EXACT | Flaschen'),
        campaign('SD | RT | Flaschen', {
          adProduct: 'SD',
          targeting: 'audience',
          biddingStrategy: null,
          placements: null,
          sdOptimization: 'clicks',
          targets: [{ type: 'audience', audience: 'views', lookbackDays: 30, bid: '0.60' }],
          negatives: [],
        }),
      ],
    });
    const result = await submit(created.id, 1);
    expect(result).toMatchObject({
      status: 'submitted',
      items: 7,
      unsupported: 1,
      // Hinweise sperren nicht.
      issues: [{ severity: 'info', code: 'adProductLater', campaign: 'SD | RT | Flaschen' }],
    });
    if (result?.status !== 'submitted') throw new Error('nicht übermittelt');
    expect(result.submission).toMatchObject({
      kind: 'setup',
      channel: 'bulk_file',
      status: 'pending',
      profileId: f.profile,
      createdBy: f.emil,
    });

    const items = await testDb.db
      .select()
      .from(campaignSetupItems)
      .where(eq(campaignSetupItems.submissionId, result.submission.id))
      .orderBy(campaignSetupItems.position);
    expect(items.map((item) => [item.entityType, item.status, item.errorCode])).toEqual([
      ['campaign', 'submitted', null],
      ['placement', 'submitted', null],
      ['ad_group', 'submitted', null],
      ['product_ad', 'submitted', null],
      ['keyword', 'submitted', null],
      ['negative_keyword', 'submitted', null],
      ['campaign', 'failed', 'AD_PRODUCT_NOT_SUPPORTED'],
    ]);
    expect(items[0]!.payload).toMatchObject({ entity: 'campaign', state: 'PAUSED' });
    expect(items[2]).toMatchObject({
      campaignRef: 'SP | EXACT | Flaschen',
      adGroupRef: 'SP | EXACT | Flaschen',
    });

    const draft = (await getCampaignSetupDraft(testDb.db, { ...as(f.ada), draftId: created.id }))!;
    expect(draft).toMatchObject({ status: 'submitted', submissionId: result.submission.id });

    // Die Übermittlung erscheint auf der Seite „Änderungen“ mit den Zählern ihrer Anlagen.
    const [listed] = (await listAdChangeSubmissions(testDb.db, as(f.ada)))!;
    expect(listed).toMatchObject({
      id: result.submission.id,
      kind: 'setup',
      changes: 7,
      counts: { submitted: 6, applied: 0, failed: 1, dismissed: 0 },
    });

    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'ad_change_submission.create'));
    expect(event!.target).toMatchObject({ kind: 'setup', draftId: created.id, items: 7 });
  });

  it('prüft mit reviewCampaignPlan gegen den aktuellen Stand und übermittelt bei Fehlern nichts', async () => {
    const created = await save({ campaigns: [campaign('Kampagne 1001')] });
    const result = await submit(created.id, 1);
    expect(result).toEqual({
      status: 'rejected',
      issues: [{ severity: 'error', code: 'campaignNameTaken', campaign: 'Kampagne 1001' }],
    });
    expect(await testDb.db.select().from(adChangeSubmissions)).toEqual([]);
    expect(
      (await getCampaignSetupDraft(testDb.db, { ...as(f.ada), draftId: created.id }))!.status,
    ).toBe('draft');
  });

  it('erkennt Kampagnen offener Setups als vergeben und prüft die Grenzen von Amazon', async () => {
    const first = await save({ campaigns: [campaign('Neu')] });
    const second = await save({ campaigns: [campaign('neu')] });
    expect((await submit(first.id, 1))?.status).toBe('submitted');
    expect(await submit(second.id, 1)).toMatchObject({
      status: 'rejected',
      issues: [
        { code: 'campaignNameTaken', campaign: 'neu' },
        // Das exakte Keyword des ersten Setups gilt als gebucht.
        { code: 'keywordAlreadyExact', keyword: 'trinkflasche', existing: 'Neu' },
      ],
    });

    const expensive = await save({ campaigns: [campaign('Teuer')] });
    expect(
      await submit(expensive.id, 1, {
        limitFor: ({ field }) => (field === 'budget' ? null : { min: '0.02', max: '0.88' }),
      }),
    ).toMatchObject({
      status: 'rejected',
      issues: [{ code: 'bidOutOfRange' }, { code: 'keywordAlreadyExact' }],
    });
  });

  it('schließt eine Übermittlung ohne anlegbare Kampagne sofort ab', async () => {
    const created = await save({
      campaigns: [
        campaign('SD | RT | Flaschen', {
          adProduct: 'SD',
          targeting: 'audience',
          biddingStrategy: null,
          placements: null,
          sdOptimization: 'clicks',
          targets: [{ type: 'audience', audience: 'views', lookbackDays: 30, bid: '0.60' }],
          negatives: [],
        }),
      ],
    });
    const result = await submit(created.id, 1);
    expect(result).toMatchObject({
      status: 'submitted',
      items: 1,
      unsupported: 1,
      submission: { status: 'finished', counts: { failed: 1 } },
    });
  });

  it('übermittelt über die API nur Profile mit Connection und plant den Job ein', async () => {
    const created = await save();
    const enqueued: string[] = [];
    const result = await submit(created.id, 1, {
      channel: 'api',
      enqueue: async (_tx, submission) => {
        enqueued.push(submission.id);
      },
    });
    if (result?.status !== 'submitted') throw new Error('nicht übermittelt');
    expect(enqueued).toEqual([result.submission.id]);

    const fileDraft = await save({ profileId: f.fileProfile });
    expect(await code(submit(fileDraft.id, 1, { channel: 'api' }))).toBe(
      'PROFILE_HAS_NO_CONNECTION',
    );
  });

  it('verlangt die aktuelle Version und einen offenen Entwurf', async () => {
    const created = await save();
    expect(await code(submit(created.id, 5))).toBe('VERSION_CONFLICT');
    await submit(created.id, 1);
    expect(await code(submit(created.id, 1))).toBe('NOT_DRAFT');
    expect(
      await code(
        submitCampaignSetupDraft(testDb.db, {
          ...as(other.otto, other.org),
          draftId: created.id,
          version: 1,
          channel: 'bulk_file',
          enqueue: noEnqueue,
          limitFor: () => null,
        }),
      ),
    ).toBe('NOT_FOUND');
    const submissions = await testDb.db
      .select()
      .from(adChangeSubmissions)
      .where(and(eq(adChangeSubmissions.kind, 'setup')));
    expect(submissions).toHaveLength(1);
  });
});

describe('Portfolio des Entwurfs (4.7, F9)', () => {
  async function portfolio(profileId: string, amazonPortfolioId: string) {
    const [row] = await testDb.db
      .insert(amazonAdsPortfolios)
      .values({
        organizationId: f.org,
        profileId,
        amazonPortfolioId,
        name: `P ${amazonPortfolioId}`,
      })
      .returning({ id: amazonAdsPortfolios.id });
    return row!.id;
  }

  it('nimmt nur Portfolios desselben Profils', async () => {
    const foreign = await portfolio(f.fileProfile, '7101');
    expect(await code(save({ portfolioId: foreign }))).toBe('PORTFOLIO_MISMATCH');
    const own = await portfolio(f.profile, '7102');
    const saved = await save({ portfolioId: own });
    expect(saved.portfolioId).toBe(own);
  });

  it('übermittelt die Kampagnen mit der Portfolio-ID und sperrt ein entferntes Portfolio', async () => {
    const own = await portfolio(f.profile, '7103');
    const first = await save({ portfolioId: own });
    const result = await submit(first.id, 1);
    if (result?.status !== 'submitted') throw new Error(JSON.stringify(result));
    const [campaignItem] = await testDb.db
      .select()
      .from(campaignSetupItems)
      .where(eq(campaignSetupItems.submissionId, result.submission.id))
      .orderBy(campaignSetupItems.position);
    expect(campaignItem!.payload).toMatchObject({ entity: 'campaign', amazonPortfolioId: '7103' });

    const second = await save({
      portfolioId: own,
      campaigns: [campaign('SP | EXACT | Zweite')],
    });
    await testDb.db
      .update(amazonAdsPortfolios)
      .set({ removedAt: new Date() })
      .where(eq(amazonAdsPortfolios.id, own));
    const rejected = await submit(second.id, 1);
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.issues).toContainEqual({ severity: 'error', code: 'portfolioMissing' });
  });
});
