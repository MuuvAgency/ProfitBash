import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import { planAutomationRun, saveAutomationRun, type AutomationRunPlan } from './automation-runs';
import { replaceEntityPeriodMetrics, type EntityPeriodMetric } from './entity-period-metrics';
import {
  amazonAdsCampaigns,
  amazonAdsEntityPeriodMetrics,
  amazonAdsProfiles,
  amazonAdsSearchTermPeriodMetrics,
  amazonAdsTargets,
  auditEvents,
  automationRuns,
  automationStructureProposals,
  campaignBlocks,
  notifications,
  productGroupItems,
  productGroups,
  searchTermHarvestMarks,
  structureCatalogs,
} from './schema';
import {
  acceptStructureProposals,
  dismissStructureProposals,
  listStructureProposals,
  loadStructureProposals,
  type StructureProposalInput,
} from './structure-proposals';
import { createTestDatabase, type TestDatabase } from './testing';

/**
 * Graduation- und Preset-Vorschläge (`phase-5.md` 5.11b): im Lauf berechnet und abgeglichen, in der Liste angenommen
 * (Merkliste bzw. Preset der Produktgruppe) oder verworfen.
 */

let testDb: TestDatabase;
let f: AdChangeFixture;
let group = '';
const NOW = new Date('2026-10-10T08:00:00Z');
const PERIOD = { startDate: '2026-09-08', endDate: '2026-10-07' };

const scope = () => ({ organizationId: f.org, profileId: f.profile });
const who = (userId = f.ada) => ({ userId, orgId: f.org });
const metric = (
  level: EntityPeriodMetric['level'],
  amazonEntityId: string,
  cost: string,
  sales: string,
  purchases: number,
): EntityPeriodMetric => ({
  level,
  amazonCampaignId: '1001',
  amazonEntityId,
  impressions: 1000,
  clicks: 100,
  cost,
  sales,
  purchases,
  units: purchases,
});
const importMetrics = (rows: EntityPeriodMetric[]) =>
  replaceEntityPeriodMetrics(testDb.db, {
    ...scope(),
    adProduct: 'SPONSORED_PRODUCTS',
    period: PERIOD,
    currencyCode: 'EUR',
    rows,
    replace: 'period',
    now: NOW,
  });
const term = (searchTerm: string, purchases: number, cost = '10.00', sales = '100.00') => ({
  organizationId: f.org,
  profileId: f.profile,
  adProduct: 'SPONSORED_PRODUCTS',
  periodStart: PERIOD.startDate,
  periodEnd: PERIOD.endDate,
  amazonCampaignId: '1001',
  amazonAdGroupId: '2001',
  amazonTargetId: '3001',
  searchTerm,
  currencyCode: 'EUR',
  impressions: 500,
  clicks: 40,
  cost,
  sales,
  purchases,
  units: purchases,
  importedAt: NOW,
});
async function plan(): Promise<AutomationRunPlan> {
  const result = await planAutomationRun(testDb.db, scope(), NOW);
  if (result.skip !== null) throw new Error(`Kein Plan: ${result.skip}`);
  return result;
}
const compute = async () => loadStructureProposals(testDb.db, scope(), await plan());
const save = async (structure: StructureProposalInput[]) =>
  saveAutomationRun(testDb.db, {
    ...scope(),
    plan: await plan(),
    jobRunId: null,
    counts: {},
    proposals: [],
    structure,
  });
/** Kampagne `1001` der Fixture gehört zum Baustein „Automatisch“. */
const assignAuto = () =>
  testDb.db.insert(campaignBlocks).values({
    campaignId: f.campaign,
    organizationId: f.org,
    profileId: f.profile,
    blockKey: 'SP-AUTO',
  });
async function addGroup(presetKey: string | null) {
  const [row] = await testDb.db
    .insert(productGroups)
    .values({ organizationId: f.org, profileId: f.profile, name: 'Flaschen', presetKey })
    .returning({ id: productGroups.id });
  group = row!.id;
  // `B0TEST0001` ist das Produkt der Anzeige `4001` der Fixture.
  await testDb.db
    .insert(productGroupItems)
    .values({ productGroupId: group, position: 0, asin: 'B0TEST0001', sku: 'SKU-1' });
}
const graduation = (subject: string): StructureProposalInput => ({
  kind: 'graduation',
  subject,
  key: 'SP-AUTO',
  detail: {
    searchTerm: subject,
    toBlocks: ['SP-KW-EXACT'],
    periodStart: PERIOD.startDate,
    periodEnd: PERIOD.endDate,
  },
});
const stored = () =>
  testDb.db
    .select()
    .from(automationStructureProposals)
    .orderBy(automationStructureProposals.subject);
const structureNotifications = async () =>
  (await testDb.db.select().from(notifications)).filter((n) => n.kind === 'structure_proposals');

beforeAll(async () => {
  testDb = await createTestDatabase();
  f = await seedAdChangeFixture(testDb.db);
});

beforeEach(async () => {
  const { db } = testDb;
  await db.delete(automationStructureProposals);
  await db.delete(automationRuns);
  await db.delete(notifications);
  await db.delete(auditEvents);
  await db.delete(amazonAdsEntityPeriodMetrics);
  await db.delete(amazonAdsSearchTermPeriodMetrics);
  await db.delete(searchTermHarvestMarks);
  await db.delete(campaignBlocks);
  await db.delete(productGroups);
  await db.delete(structureCatalogs);
  await db
    .update(amazonAdsProfiles)
    .set({ isHidden: false })
    .where(eq(amazonAdsProfiles.id, f.profile));
  await importMetrics([metric('campaign', '1001', '400.00', '1000.00', 40)]);
});

afterAll(async () => {
  await testDb?.close();
});

describe('Plan des Laufs', () => {
  it('wird fällig, wenn sich die Zuordnung Kampagne → Baustein oder ein Preset ändert', async () => {
    await save([]);
    expect(await planAutomationRun(testDb.db, scope(), NOW)).toEqual({ skip: 'unchanged' });
    await assignAuto();
    await save([]);
    expect(await planAutomationRun(testDb.db, scope(), NOW)).toEqual({ skip: 'unchanged' });
    await addGroup('launch');
    expect((await planAutomationRun(testDb.db, scope(), NOW)).skip).toBeNull();
  });
});

describe('loadStructureProposals', () => {
  it('schlägt Suchbegriffe des Datei-Zeitraums vor, die die Kante ihres Bausteins erfüllen', async () => {
    await assignAuto();
    await testDb.db.insert(amazonAdsSearchTermPeriodMetrics).values([
      term('trinkflasche 1l', 3),
      { ...term('zu wenig', 2), amazonTargetId: '3002' },
      { ...term('vorgemerkt', 5), amazonTargetId: '3003' },
      // Anderer Zeitraum: zählt nicht.
      { ...term('alt', 9), periodStart: '2026-08-01', periodEnd: '2026-08-31' },
    ]);
    await testDb.db.insert(searchTermHarvestMarks).values({
      ...term('vorgemerkt', 5),
      importedAt: undefined,
      termKey: 'vorgemerkt',
      sourceRows: 1,
    } as never);

    expect(await compute()).toEqual([
      {
        kind: 'graduation',
        subject: 'trinkflasche 1l',
        key: 'SP-AUTO',
        detail: {
          searchTerm: 'trinkflasche 1l',
          fromBlock: 'SP-AUTO',
          toBlocks: ['SP-KW-BROAD-CLUSTER', 'SP-KW-EXACT'],
          amazonCampaignId: '1001',
          clicks: 40,
          orders: 3,
          spend: '10',
          sales: '100',
          acos: '10',
          periodStart: PERIOD.startDate,
          periodEnd: PERIOD.endDate,
        },
      },
    ]);
  });

  it('lässt einen Begriff aus, den eine Kampagne ohne Baustein schon exakt bucht', async () => {
    await assignAuto();
    await testDb.db
      .insert(amazonAdsSearchTermPeriodMetrics)
      .values([term('kw 3001', 3), { ...term('schon exakt', 3), amazonTargetId: '3002' }]);
    const [other] = await testDb.db
      .insert(amazonAdsCampaigns)
      .values({
        organizationId: f.org,
        profileId: f.profile,
        amazonCampaignId: '1005',
        adProduct: 'SPONSORED_PRODUCTS',
        name: 'Exakt alt',
        state: 'ENABLED',
      })
      .returning({ id: amazonAdsCampaigns.id });
    await testDb.db.insert(amazonAdsTargets).values({
      organizationId: f.org,
      profileId: f.profile,
      campaignId: other!.id,
      adGroupId: null,
      amazonTargetId: '3009',
      adProduct: 'SPONSORED_PRODUCTS',
      targetType: 'keyword',
      keywordText: 'Schon  Exakt',
      matchType: 'EXACT',
      state: 'ENABLED',
    });
    expect((await compute()).map((x) => x.subject)).toEqual(['kw 3001']);
    await testDb.db.delete(amazonAdsTargets).where(eq(amazonAdsTargets.campaignId, other!.id));
    await testDb.db.delete(amazonAdsCampaigns).where(eq(amazonAdsCampaigns.id, other!.id));
    // Ohne Baustein an der Quelle gibt es keine Vorschläge.
    await testDb.db.delete(campaignBlocks);
    expect(await compute()).toEqual([]);
  });

  it('schlägt einen Preset-Wechsel aus den Kennzahlen der Produkte der Gruppe vor', async () => {
    await addGroup('launch');
    await importMetrics([
      metric('campaign', '1001', '400.00', '1000.00', 40),
      metric('productAd', '4001', '120.00', '900.00', 31),
    ]);
    expect(await compute()).toEqual([
      {
        kind: 'presetSwitch',
        subject: group,
        key: 'muuv-standard',
        detail: {
          productGroupId: group,
          productGroupName: 'Flaschen',
          from: 'launch',
          to: 'muuv-standard',
          orders: 31,
          spend: '120.00',
          sales: '900.00',
          acos: '13.33',
          goalAcos: null,
        },
      },
    ]);
    // Ohne eigenes Preset gilt der Standard „Muuv-Standard“: Von dort gibt es mit diesen Zahlen keinen Wechsel.
    await testDb.db.update(productGroups).set({ presetKey: null });
    expect(await compute()).toEqual([]);
  });
});

describe('Abgleich im Lauf', () => {
  it('hält bestehende, legt neue an, löscht verschwundene, zählt am Lauf und meldet nur neue', async () => {
    await save([graduation('a'), graduation('b')]);
    expect((await stored()).map((x) => x.subject)).toEqual(['a', 'b']);
    const [run] = await testDb.db.select().from(automationRuns);
    expect(run!.counts).toMatchObject({ structure: 2 });
    expect(await structureNotifications()).toMatchObject([
      {
        audience: 'members',
        severity: 'info',
        profileId: f.profile,
        params: { count: 2 },
        link: '/ads/automations?tab=proposals',
      },
    ]);

    const [a] = await stored();
    await dismissStructureProposals(testDb.db, { ...who(), ids: [a!.id] });
    await testDb.db.delete(automationRuns);
    await save([graduation('a'), graduation('c')]);
    const rows = await stored();
    expect(rows.map((x) => [x.subject, x.dismissedAt !== null])).toEqual([
      ['a', true],
      ['c', false],
    ]);
    expect(rows[0]!.id).toBe(a!.id);
    expect((await structureNotifications()).map((n) => n.params.count)).toEqual([2, 1]);

    // Nichts Neues: keine weitere Meldung.
    await testDb.db.delete(automationRuns);
    await save([graduation('a'), graduation('c')]);
    expect(await structureNotifications()).toHaveLength(2);
  });

  it('lässt die Vorschläge unberührt, wenn der Lauf keine mitgibt', async () => {
    await save([graduation('a')]);
    await testDb.db.delete(automationRuns);
    await saveAutomationRun(testDb.db, {
      ...scope(),
      plan: await plan(),
      jobRunId: null,
      counts: {},
      proposals: [],
    });
    expect(await stored()).toHaveLength(1);
  });
});

describe('Liste, Annehmen und Verwerfen', () => {
  it('listet offene bzw. verworfene Vorschläge sichtbarer Profile', async () => {
    await save([graduation('a'), graduation('b')]);
    const open = (await listStructureProposals(testDb.db, { ...who(), status: 'open' }))!;
    expect(open.total).toBe(2);
    expect(open.proposals[0]).toMatchObject({
      kind: 'graduation',
      subject: 'a',
      key: 'SP-AUTO',
      profileId: f.profile,
      accountName: 'Nordwind DE',
      currencyCode: 'EUR',
      dismissedAt: null,
    });
    expect(
      await dismissStructureProposals(testDb.db, { ...who(), ids: [open.proposals[0]!.id] }),
    ).toEqual({ changed: 1, skipped: 0 });
    expect(
      (await listStructureProposals(testDb.db, { ...who(), status: 'dismissed' }))!.proposals.map(
        (x) => x.subject,
      ),
    ).toEqual(['a']);
    expect((await testDb.db.select().from(auditEvents)).map((e) => e.action)).toContain(
      'automation_structure_proposals.dismiss',
    );

    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, f.profile));
    expect(
      (await listStructureProposals(testDb.db, { ...who(f.emil), status: 'open' }))!.proposals,
    ).toEqual([]);
    expect(
      await dismissStructureProposals(testDb.db, { ...who(f.emil), ids: [open.proposals[1]!.id] }),
    ).toEqual({ changed: 0, skipped: 1 });
  });

  it('Annehmen einer Graduation legt den Begriff auf die Merkliste und nimmt den Vorschlag aus der Liste', async () => {
    await testDb.db.insert(amazonAdsSearchTermPeriodMetrics).values(term('Trinkflasche 1L', 3));
    await save([graduation('trinkflasche 1l')]);
    const [row] = await stored();
    expect(await acceptStructureProposals(testDb.db, { ...who(f.emil), ids: [row!.id] })).toEqual({
      changed: 1,
      skipped: 0,
    });
    expect(await stored()).toEqual([]);
    expect(await testDb.db.select().from(searchTermHarvestMarks)).toMatchObject([
      { termKey: 'trinkflasche 1l', profileId: f.profile, createdBy: f.emil, purchases: 3 },
    ]);
    expect((await testDb.db.select().from(auditEvents)).map((e) => e.action).sort()).toEqual([
      'automation_run.create',
      'automation_structure_proposals.accept',
      'search_term_harvest.add',
    ]);
  });

  it('Annehmen eines Preset-Wechsels ändert das Preset der Produktgruppe', async () => {
    await addGroup('launch');
    await save([
      {
        kind: 'presetSwitch',
        subject: group,
        key: 'muuv-standard',
        detail: { productGroupId: group, from: 'launch', to: 'muuv-standard' },
      },
    ]);
    const [row] = await stored();
    expect(await acceptStructureProposals(testDb.db, { ...who(), ids: [row!.id] })).toEqual({
      changed: 1,
      skipped: 0,
    });
    const [after] = await testDb.db
      .select({ presetKey: productGroups.presetKey })
      .from(productGroups)
      .where(and(eq(productGroups.id, group)));
    expect(after!.presetKey).toBe('muuv-standard');
    expect(await stored()).toEqual([]);
    expect((await testDb.db.select().from(auditEvents)).map((e) => e.action)).toContain(
      'product_group.update',
    );
  });

  it('überspringt, was sich nicht mehr annehmen lässt (Begriff nicht mehr im Zeitraum, Preset gelöscht)', async () => {
    await addGroup('launch');
    await save([
      graduation('gibt es nicht'),
      {
        kind: 'presetSwitch',
        subject: group,
        key: 'weg',
        detail: { productGroupId: group, from: 'launch', to: 'weg' },
      },
    ]);
    const ids = (await stored()).map((x) => x.id);
    expect(await acceptStructureProposals(testDb.db, { ...who(), ids })).toEqual({
      changed: 0,
      skipped: 2,
    });
    expect(await stored()).toHaveLength(2);
  });
});
