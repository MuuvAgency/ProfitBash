import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { replaceSearchTermPeriodMetrics, type SearchTermPeriodMetric } from './amazon-ads-metrics';
import {
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsProfiles,
  amazonAdsTargets,
  auditEvents,
  members,
  organizations,
  searchTermHarvestMarks,
  users,
} from './schema';
import {
  listHarvestMarks,
  loadHarvestMarkSources,
  listMarkedHarvestTermKeys,
  markSearchTermsForHarvest,
  removeHarvestMarks,
} from './search-term-harvest';
import { createTestConnection, createTestOrganization } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/** Harvest-Merkliste (`phase-3.md` 3.8, F9): Suchbegriffe je Profil vormerken, ansehen, entfernen; nur über den Access-Layer. */

let testDb: TestDatabase;
const ids = {
  org: '',
  otherOrg: '',
  ada: '',
  otto: '',
  stranger: '',
  de: '',
  hidden: '',
  foreign: '',
};

const A = { startDate: '2026-09-01', endDate: '2026-09-30' };
const SP = 'SPONSORED_PRODUCTS';

const term = (
  searchTerm: string,
  cost: string,
  patch: Partial<SearchTermPeriodMetric> = {},
): SearchTermPeriodMetric => ({
  amazonCampaignId: 'C1',
  amazonAdGroupId: 'AG1',
  amazonTargetId: 'T-BROAD',
  searchTerm,
  impressions: 1000,
  clicks: 10,
  cost,
  sales: '0',
  purchases: 0,
  units: 0,
  ...patch,
});

async function write(organizationId: string, profileId: string, rows: SearchTermPeriodMetric[]) {
  await replaceSearchTermPeriodMetrics(testDb.db, {
    organizationId,
    profileId,
    adProduct: SP,
    period: A,
    currencyCode: 'EUR',
    rows,
    replace: 'period',
    now: new Date('2026-10-01T08:00:00Z'),
  });
}

const as = (userId: string, orgId = ids.org) => ({ userId, orgId });
const mark = (userId: string, profileId: string, searchTerms: string[], orgId = ids.org) =>
  markSearchTermsForHarvest(testDb.db, {
    userId,
    orgId,
    profileId,
    periodStart: A.startDate,
    periodEnd: A.endDate,
    searchTerms,
  });

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.org = await createTestOrganization(db, 'muuv');
  ids.otherOrg = await createTestOrganization(db, 'andere');
  const created = await db
    .insert(users)
    .values([
      { name: 'Ada', email: 'ada@muuv.test' },
      { name: 'Otto', email: 'otto@andere.test' },
      { name: 'Niemand', email: 'niemand@nirgends.test' },
    ])
    .returning({ id: users.id });
  [ids.ada, ids.otto, ids.stranger] = created.map((u) => u.id) as [string, string, string];
  await db.insert(members).values([
    { organizationId: ids.org, userId: ids.ada, role: 'admin', createdAt: new Date() },
    { organizationId: ids.otherOrg, userId: ids.otto, role: 'admin', createdAt: new Date() },
  ]);
  const connection = await createTestConnection(db, ids.org, 'amzn1.account.MUUV');
  const otherConnection = await createTestConnection(db, ids.otherOrg, 'amzn1.account.OTHER');
  const profile = (organizationId: string, connectionId: string, amazonProfileId: string) => ({
    organizationId,
    connectionId,
    amazonProfileId,
    accountName: `Konto ${amazonProfileId}`,
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    accountType: 'seller',
  });
  const [de, hidden, foreign] = await db
    .insert(amazonAdsProfiles)
    .values([
      profile(ids.org, connection, '1'),
      { ...profile(ids.org, connection, '2'), isHidden: true },
      profile(ids.otherOrg, otherConnection, '3'),
    ])
    .returning({ id: amazonAdsProfiles.id });
  ids.de = de!.id;
  ids.hidden = hidden!.id;
  ids.foreign = foreign!.id;

  const [campaign] = await db
    .insert(amazonAdsCampaigns)
    .values({
      organizationId: ids.org,
      profileId: ids.de,
      amazonCampaignId: 'C1',
      adProduct: SP,
      name: 'SP Lampen',
      state: 'ENABLED',
    })
    .returning({ id: amazonAdsCampaigns.id });
  const [adGroup] = await db
    .insert(amazonAdsAdGroups)
    .values({
      organizationId: ids.org,
      profileId: ids.de,
      campaignId: campaign!.id,
      amazonAdGroupId: 'AG1',
      adProduct: SP,
      name: 'AG Lampen',
      state: 'ENABLED',
    })
    .returning({ id: amazonAdsAdGroups.id });
  await db.insert(amazonAdsTargets).values({
    organizationId: ids.org,
    profileId: ids.de,
    campaignId: campaign!.id,
    adGroupId: adGroup!.id,
    amazonTargetId: 'T-BROAD',
    adProduct: SP,
    targetType: 'keyword',
    keywordText: 'lampe',
    matchType: 'BROAD',
    state: 'ENABLED',
  });

  await write(ids.org, ids.de, [
    term('led lampe', '12.50', { clicks: 30, sales: '80.00', purchases: 4, units: 5 }),
    term('LED  Lampe', '2.25', {
      amazonTargetId: 'T-PHRASE',
      clicks: 5,
      sales: '19.90',
      purchases: 1,
      units: 1,
    }),
    term('lampe holz', '3.00', { amazonCampaignId: 'C-FEHLT', amazonAdGroupId: 'AG-FEHLT' }),
  ]);
  await write(ids.org, ids.hidden, [term('versteckt', '1.00')]);
  await write(ids.otherOrg, ids.foreign, [term('fremd', '1.00')]);
});

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  await testDb.db.delete(searchTermHarvestMarks);
  await testDb.db.delete(auditEvents);
});

describe('markSearchTermsForHarvest', () => {
  it('merkt einen Suchbegriff mit den Summen über alle seine Zeilen und der Quelle mit dem höchsten Spend vor', async () => {
    const result = await mark(ids.ada, ids.de, ['LED Lampe']);

    expect(result).toMatchObject({ counts: { added: 1, alreadyMarked: 0, notFound: 0 } });
    expect(result!.results[0]).toMatchObject({ outcome: 'added' });
    const list = await listHarvestMarks(testDb.db, { ...as(ids.ada), profileId: ids.de });
    expect(list).toHaveLength(1);
    expect(list![0]).toMatchObject({
      profileId: ids.de,
      searchTerm: 'led lampe',
      adProduct: SP,
      amazonCampaignId: 'C1',
      campaignName: 'SP Lampen',
      adGroupName: 'AG Lampen',
      amazonTargetId: 'T-BROAD',
      keywordText: 'lampe',
      matchType: 'BROAD',
      periodStart: A.startDate,
      periodEnd: A.endDate,
      sourceRows: 2,
      impressions: '2000',
      clicks: '35',
      cost: '14.75',
      sales: '99.9',
      purchases: '5',
      units: '6',
      currencyCode: 'EUR',
      createdByName: 'Ada',
    });
  });

  it('merkt einen Begriff nur einmal je Profil vor (ohne Groß/Klein und Leerraum) und behält die ersten Kennzahlen', async () => {
    await mark(ids.ada, ids.de, ['led lampe']);

    const again = await mark(ids.ada, ids.de, ['Led  Lampe', 'lampe holz', 'led lampe']);

    expect(again!.results.map((r) => r.outcome)).toEqual([
      'alreadyMarked',
      'added',
      'alreadyMarked',
    ]);
    expect(await listHarvestMarks(testDb.db, as(ids.ada))).toHaveLength(2);
  });

  it('meldet Begriffe ohne Zeile im Zeitraum als `notFound`', async () => {
    const result = await mark(ids.ada, ids.de, ['gibt es nicht', 'lampe holz']);

    expect(result!.results.map((r) => r.outcome)).toEqual(['notFound', 'added']);
    expect(result!.counts).toEqual({ added: 1, alreadyMarked: 0, notFound: 1 });
  });

  it('zeigt die Quelle auch ohne bekannte Entities (nur Amazon-IDs)', async () => {
    await mark(ids.ada, ids.de, ['lampe holz']);

    const [entry] = (await listHarvestMarks(testDb.db, as(ids.ada)))!;
    expect(entry).toMatchObject({
      amazonCampaignId: 'C-FEHLT',
      campaignId: null,
      campaignName: null,
      adGroupName: null,
    });
  });

  it('liefert `null` für fremde und ausgeblendete Profile und für Nicht-Mitglieder', async () => {
    expect(await mark(ids.ada, ids.foreign, ['fremd'])).toBeNull();
    expect(await mark(ids.ada, ids.hidden, ['versteckt'])).toBeNull();
    expect(await mark(ids.stranger, ids.de, ['led lampe'])).toBeNull();
    expect(await mark(ids.otto, ids.de, ['led lampe'], ids.otherOrg)).toBeNull();
    expect(await testDb.db.select().from(searchTermHarvestMarks)).toHaveLength(0);
  });

  it('schreibt ein Audit-Event nur, wenn etwas vorgemerkt wurde', async () => {
    await mark(ids.ada, ids.de, ['led lampe', 'gibt es nicht']);
    await mark(ids.ada, ids.de, ['led lampe']);

    const events = await testDb.db.select().from(auditEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: ids.org,
      actorUserId: ids.ada,
      action: 'search_term_harvest.add',
      target: { type: 'search_term_harvest', profileId: ids.de, added: 1 },
    });
  });
});

describe('listHarvestMarks', () => {
  it('zeigt nur Einträge sichtbarer Profile, neueste zuerst', async () => {
    await mark(ids.ada, ids.de, ['lampe holz']);
    await mark(ids.otto, ids.foreign, ['fremd'], ids.otherOrg);
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: false })
      .where(eq(amazonAdsProfiles.id, ids.hidden));
    await mark(ids.ada, ids.hidden, ['versteckt']);
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, ids.hidden));

    const list = await listHarvestMarks(testDb.db, as(ids.ada));

    expect(list!.map((entry) => entry.searchTerm)).toEqual(['lampe holz']);
    expect(await listHarvestMarks(testDb.db, { ...as(ids.ada), profileId: ids.foreign })).toEqual(
      [],
    );
    expect(await listHarvestMarks(testDb.db, as(ids.stranger))).toBeNull();
  });

  it('nennt die vorgemerkten Begriffe eines Profils in Vergleichsform', async () => {
    await mark(ids.ada, ids.de, ['LED  Lampe']);

    expect(await listMarkedHarvestTermKeys(testDb.db, ids.de)).toEqual(new Set(['led lampe']));
  });
});

describe('loadHarvestMarkSources (4.6)', () => {
  it('liefert je Eintrag Quelle, Kennzahlen und ob der Begriff dort schon negativ exakt ist', async () => {
    await mark(ids.ada, ids.de, ['LED Lampe', 'lampe holz']);
    const before = await loadHarvestMarkSources(testDb.db, { profileId: ids.de });
    const byTerm = new Map(before.map((entry) => [entry.searchTerm, entry]));
    expect(byTerm.get('led lampe')).toMatchObject({
      adProduct: SP,
      amazonCampaignId: 'C1',
      amazonAdGroupId: 'AG1',
      campaignName: 'SP Lampen',
      adGroupName: 'AG Lampen',
      sourceKeyword: { text: 'lampe', matchType: 'BROAD' },
      clicks: 35,
      cost: '14.75',
      currencyCode: 'EUR',
      alreadyNegative: false,
    });
    expect(byTerm.get('lampe holz')).toMatchObject({
      campaignName: null,
      adGroupName: null,
      sourceKeyword: null,
    });

    const [adGroup] = await testDb.db
      .select({ id: amazonAdsAdGroups.id, campaignId: amazonAdsAdGroups.campaignId })
      .from(amazonAdsAdGroups)
      .where(eq(amazonAdsAdGroups.amazonAdGroupId, 'AG1'));
    await testDb.db.insert(amazonAdsNegativeTargets).values({
      organizationId: ids.org,
      profileId: ids.de,
      level: 'ad_group',
      campaignId: adGroup!.campaignId,
      adGroupId: adGroup!.id,
      amazonTargetId: 'N1',
      adProduct: SP,
      targetType: 'keyword',
      keywordText: 'LED Lampe',
      matchType: 'EXACT',
      state: 'ENABLED',
    });
    const after = await loadHarvestMarkSources(testDb.db, { profileId: ids.de });
    expect(after.find((entry) => entry.searchTerm === 'led lampe')?.alreadyNegative).toBe(true);
    await testDb.db.delete(amazonAdsNegativeTargets);
  });

  it('erkennt auch Negatives exakt auf Ebene der Quell-Kampagne', async () => {
    await mark(ids.ada, ids.de, ['LED Lampe']);
    const [campaign] = await testDb.db
      .select({ id: amazonAdsCampaigns.id })
      .from(amazonAdsCampaigns)
      .where(eq(amazonAdsCampaigns.amazonCampaignId, 'C1'));
    await testDb.db.insert(amazonAdsNegativeTargets).values({
      organizationId: ids.org,
      profileId: ids.de,
      level: 'campaign',
      campaignId: campaign!.id,
      adGroupId: null,
      amazonTargetId: 'N2',
      adProduct: SP,
      targetType: 'keyword',
      keywordText: 'led lampe',
      matchType: 'EXACT',
      state: 'ENABLED',
    });
    try {
      const [loaded] = await loadHarvestMarkSources(testDb.db, { profileId: ids.de });
      expect(loaded?.alreadyNegative).toBe(true);
    } finally {
      await testDb.db.delete(amazonAdsNegativeTargets);
    }
  });

  it('liest nur die genannten Einträge des Profils', async () => {
    const result = await mark(ids.ada, ids.de, ['LED Lampe', 'lampe holz']);
    const first = result!.results[0]!;
    if (first.outcome !== 'added') throw new Error('nicht vorgemerkt');
    const loaded = await loadHarvestMarkSources(testDb.db, {
      profileId: ids.de,
      markIds: [first.id],
    });
    expect(loaded.map((entry) => entry.id)).toEqual([first.id]);
    expect(
      await loadHarvestMarkSources(testDb.db, { profileId: ids.hidden, markIds: [first.id] }),
    ).toEqual([]);
  });
});

describe('removeHarvestMarks', () => {
  it('entfernt genannte Einträge sichtbarer Profile mit Audit-Event', async () => {
    await mark(ids.ada, ids.de, ['led lampe', 'lampe holz']);
    const list = (await listHarvestMarks(testDb.db, as(ids.ada)))!;
    await testDb.db.delete(auditEvents);

    const removed = await removeHarvestMarks(testDb.db, { ...as(ids.ada), ids: [list[0]!.id] });

    expect(removed).toBe(1);
    expect(await listHarvestMarks(testDb.db, as(ids.ada))).toHaveLength(1);
    const events = await testDb.db.select().from(auditEvents);
    expect(events.map((event) => event.action)).toEqual(['search_term_harvest.remove']);
  });

  it('entfernt nichts aus fremden Organisationen und schreibt dann kein Audit-Event', async () => {
    await mark(ids.otto, ids.foreign, ['fremd'], ids.otherOrg);
    const [foreign] = await testDb.db.select().from(searchTermHarvestMarks);
    await testDb.db.delete(auditEvents);

    expect(await removeHarvestMarks(testDb.db, { ...as(ids.ada), ids: [foreign!.id] })).toBe(0);
    expect(
      await removeHarvestMarks(testDb.db, { ...as(ids.stranger), ids: [foreign!.id] }),
    ).toBeNull();
    expect(await testDb.db.select().from(searchTermHarvestMarks)).toHaveLength(1);
    expect(await testDb.db.select().from(auditEvents)).toHaveLength(0);
  });
});

describe('Schema', () => {
  it('löscht die Merkliste mit der Organisation', async () => {
    await mark(ids.otto, ids.foreign, ['fremd'], ids.otherOrg);

    await testDb.db.delete(organizations).where(eq(organizations.id, ids.otherOrg));

    expect(await testDb.db.select().from(searchTermHarvestMarks)).toHaveLength(0);
  });
});
