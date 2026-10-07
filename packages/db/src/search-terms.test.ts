import { DEFAULT_SEARCH_TERM_RULES } from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replaceSearchTermPeriodMetrics, type SearchTermPeriodMetric } from './amazon-ads-metrics';
import {
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsProfiles,
  amazonAdsTargets,
  auditEvents,
  clients,
  members,
  searchTermRules,
  users,
} from './schema';
import {
  getSearchTermRules,
  listSearchTermPeriods,
  querySearchTermPeriod,
  saveSearchTermRules,
} from './search-terms';
import { createTestConnection, createTestOrganization } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/** Suchbegriff-Analyse (2b.2): Lesen je Profil und Datei-Zeitraum über den Access-Layer, Regeln je Organisation. */

let testDb: TestDatabase;
const ids = {
  org: '',
  otherOrg: '',
  admin: '',
  viewer: '',
  outsider: '',
  stranger: '',
  client: '',
  de: '',
  hidden: '',
  foreign: '',
  campaign: '',
  adGroup: '',
  broad: '',
};

const A = { startDate: '2026-08-01', endDate: '2026-09-29' };
const B = { startDate: '2026-09-01', endDate: '2026-09-30' };
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

async function write(
  organizationId: string,
  profileId: string,
  period: typeof A,
  rows: SearchTermPeriodMetric[],
  adProduct = SP,
  now = new Date('2026-10-01T08:00:00Z'),
) {
  await replaceSearchTermPeriodMetrics(testDb.db, {
    organizationId,
    profileId,
    adProduct,
    period,
    currencyCode: 'EUR',
    rows,
    replace: 'period',
    now,
  });
}

const as = (userId: string, orgId = ids.org) => ({ userId, orgId });

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.org = await createTestOrganization(db, 'muuv');
  ids.otherOrg = await createTestOrganization(db, 'andere');
  const created = await db
    .insert(users)
    .values([
      { name: 'Ada', email: 'ada@muuv.test' },
      { name: 'Vera', email: 'vera@muuv.test' },
      { name: 'Otto', email: 'otto@andere.test' },
      { name: 'Niemand', email: 'niemand@nirgends.test' },
    ])
    .returning({ id: users.id });
  [ids.admin, ids.viewer, ids.outsider, ids.stranger] = created.map((u) => u.id) as [
    string,
    string,
    string,
    string,
  ];
  await db.insert(members).values([
    { organizationId: ids.org, userId: ids.admin, role: 'admin', createdAt: new Date() },
    { organizationId: ids.org, userId: ids.viewer, role: 'viewer', createdAt: new Date() },
    { organizationId: ids.otherOrg, userId: ids.outsider, role: 'admin', createdAt: new Date() },
  ]);
  const [client] = await db
    .insert(clients)
    .values({
      organizationId: ids.org,
      name: 'Nordwind',
      slug: 'nordwind',
      protectedTerms: ['nordwind'],
    })
    .returning({ id: clients.id });
  ids.client = client!.id;

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
      { ...profile(ids.org, connection, '1'), clientId: ids.client },
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
  ids.campaign = campaign!.id;
  const [adGroup] = await db
    .insert(amazonAdsAdGroups)
    .values({
      organizationId: ids.org,
      profileId: ids.de,
      campaignId: ids.campaign,
      amazonAdGroupId: 'AG1',
      adProduct: SP,
      name: 'AG Lampen',
      state: 'ENABLED',
    })
    .returning({ id: amazonAdsAdGroups.id });
  ids.adGroup = adGroup!.id;
  const target = (
    amazonTargetId: string,
    patch: Partial<typeof amazonAdsTargets.$inferInsert>,
  ) => ({
    organizationId: ids.org,
    profileId: ids.de,
    campaignId: ids.campaign,
    adGroupId: ids.adGroup,
    amazonTargetId,
    adProduct: SP,
    targetType: 'keyword',
    state: 'ENABLED',
    ...patch,
  });
  const targets = await db
    .insert(amazonAdsTargets)
    .values([
      target('T-BROAD', { keywordText: 'lampe', matchType: 'BROAD' }),
      target('T-EXACT', { keywordText: 'LED  Lampe', matchType: 'EXACT', state: 'PAUSED' }),
      target('T-PHRASE', { keywordText: 'lampe rot', matchType: 'PHRASE' }),
      target('T-ARCHIVED', { keywordText: 'lampe blau', matchType: 'EXACT', state: 'ARCHIVED' }),
      target('T-REMOVED', {
        keywordText: 'lampe gelb',
        matchType: 'EXACT',
        removedAt: new Date('2026-09-01T00:00:00Z'),
      }),
      target('T-ASIN', {
        targetType: 'product',
        matchType: 'PRODUCT_EXACT',
        expression: { matchType: 'PRODUCT_EXACT', asin: 'B0TEST0001' },
      }),
    ])
    .returning({ id: amazonAdsTargets.id });
  ids.broad = targets[0]!.id;

  await write(ids.org, ids.de, A, [
    term('led lampe', '30.50', { sales: '120', purchases: 4, units: 5, clicks: 40 }),
    term('lampe rot', '12', { clicks: 30 }),
    term('lampe blau', '3'),
    term('lampe gelb', '2'),
    term('b0test0001', '1'),
    term('unbekannt', '50', {
      amazonCampaignId: 'C-FEHLT',
      amazonAdGroupId: 'AG-FEHLT',
      amazonTargetId: 'T-FEHLT',
    }),
  ]);
  await write(
    ids.org,
    ids.de,
    A,
    [term('sb begriff', '7', { amazonTargetId: 'T-SB' })],
    'SPONSORED_BRANDS',
  );
  await write(
    ids.org,
    ids.de,
    B,
    [term('led lampe', '999', { clicks: 999 })],
    SP,
    new Date('2026-10-02T08:00:00Z'),
  );
  await write(ids.org, ids.hidden, A, [term('versteckt', '777')]);

  // Dieselben Amazon-IDs und ein exaktes Keyword in einem fremden und im ausgeblendeten Profil: Die Joins und der
  // Abgleich „schon exakt gebucht“ dürfen nur das eigene Profil treffen.
  for (const [organizationId, profileId] of [
    [ids.otherOrg, ids.foreign],
    [ids.org, ids.hidden],
  ] as const) {
    const [otherCampaign] = await db
      .insert(amazonAdsCampaigns)
      .values({
        organizationId,
        profileId,
        amazonCampaignId: 'C1',
        adProduct: SP,
        name: 'FREMDE KAMPAGNE',
        state: 'ENABLED',
      })
      .returning({ id: amazonAdsCampaigns.id });
    const [otherAdGroup] = await db
      .insert(amazonAdsAdGroups)
      .values({
        organizationId,
        profileId,
        campaignId: otherCampaign!.id,
        amazonAdGroupId: 'AG1',
        adProduct: SP,
        name: 'FREMDE AD GROUP',
        state: 'ENABLED',
      })
      .returning({ id: amazonAdsAdGroups.id });
    const other = { organizationId, profileId, campaignId: otherCampaign!.id, adProduct: SP };
    await db.insert(amazonAdsTargets).values([
      {
        ...other,
        adGroupId: otherAdGroup!.id,
        amazonTargetId: 'T-BROAD',
        targetType: 'keyword',
        keywordText: 'FREMDES KEYWORD',
        matchType: 'PHRASE',
        state: 'ENABLED',
      },
      {
        ...other,
        adGroupId: otherAdGroup!.id,
        amazonTargetId: 'T-FREMD-EXACT',
        targetType: 'keyword',
        keywordText: 'lampe rot',
        matchType: 'EXACT',
        state: 'ENABLED',
      },
    ]);
  }
  await write(ids.otherOrg, ids.foreign, A, [term('fremd', '555')]);
});

afterAll(async () => {
  await testDb?.close();
});

describe('listSearchTermPeriods', () => {
  it('nennt je sichtbarem Profil die Datei-Zeiträume, neuester zuerst', async () => {
    for (const user of [ids.admin, ids.viewer]) {
      const periods = await listSearchTermPeriods(testDb.db, as(user));
      expect(periods).toEqual([
        {
          profileId: ids.de,
          accountName: 'Konto 1',
          countryCode: 'DE',
          currencyCode: 'EUR',
          clientId: ids.client,
          periodStart: B.startDate,
          periodEnd: B.endDate,
          adProducts: [SP],
          rows: 1,
          importedAt: new Date('2026-10-02T08:00:00Z'),
        },
        {
          profileId: ids.de,
          accountName: 'Konto 1',
          countryCode: 'DE',
          currencyCode: 'EUR',
          clientId: ids.client,
          periodStart: A.startDate,
          periodEnd: A.endDate,
          adProducts: ['SPONSORED_BRANDS', SP],
          rows: 7,
          importedAt: new Date('2026-10-01T08:00:00Z'),
        },
      ]);
    }
  });

  it('zeigt fremden Organisationen und Nicht-Mitgliedern nichts von uns', async () => {
    const foreign = await listSearchTermPeriods(testDb.db, as(ids.outsider, ids.otherOrg));
    expect(foreign.map((p) => p.profileId)).toEqual([ids.foreign]);
    expect(await listSearchTermPeriods(testDb.db, as(ids.outsider))).toEqual([]);
    expect(await listSearchTermPeriods(testDb.db, as(ids.stranger))).toEqual([]);
  });
});

describe('querySearchTermPeriod', () => {
  const query = (patch: Partial<Parameters<typeof querySearchTermPeriod>[1]> = {}) =>
    querySearchTermPeriod(testDb.db, {
      ...as(ids.viewer),
      profileId: ids.de,
      periodStart: A.startDate,
      periodEnd: A.endDate,
      ...patch,
    });

  it('liefert nur die Zeilen des gewählten Zeitraums, nie die Summe mehrerer', async () => {
    const result = await query();
    expect(result?.rows.map((r) => [r.searchTerm, r.cost])).toEqual([
      ['unbekannt', '50'],
      ['led lampe', '30.50'],
      ['lampe rot', '12'],
      ['sb begriff', '7'],
      ['lampe blau', '3'],
      ['lampe gelb', '2'],
      ['b0test0001', '1'],
    ]);
    const other = await query({ periodStart: B.startDate, periodEnd: B.endDate });
    expect(other?.rows.map((r) => [r.searchTerm, r.cost, r.clicks])).toEqual([
      ['led lampe', '999', '999'],
    ]);
  });

  it('nennt Profil, Client-Begriffe und den letzten Import', async () => {
    const result = await query();
    expect(result?.profile).toEqual({
      id: ids.de,
      accountName: 'Konto 1',
      countryCode: 'DE',
      currencyCode: 'EUR',
      clientId: ids.client,
    });
    expect(result?.protectedTerms).toEqual(['nordwind']);
    expect(result?.importedAt).toEqual(new Date('2026-10-01T08:00:00Z'));
  });

  it('verbindet über die Amazon-IDs mit Kampagne, Ad Group und Target; Zähler als Text', async () => {
    const result = await query();
    expect(result?.rows.find((r) => r.searchTerm === 'led lampe')).toMatchObject({
      adProduct: SP,
      amazonCampaignId: 'C1',
      amazonAdGroupId: 'AG1',
      amazonTargetId: 'T-BROAD',
      campaignId: ids.campaign,
      campaignName: 'SP Lampen',
      adGroupId: ids.adGroup,
      adGroupName: 'AG Lampen',
      targetId: ids.broad,
      keywordText: 'lampe',
      matchType: 'BROAD',
      impressions: '1000',
      clicks: '40',
      cost: '30.50',
      sales: '120',
      purchases: '4',
      units: '5',
    });
  });

  it('verbindet nie mit gleichnamigen Amazon-IDs anderer Profile (keine fremden Namen, keine doppelten Zeilen)', async () => {
    const result = await query();
    expect(result?.rows).toHaveLength(7);
    expect(JSON.stringify(result)).not.toContain('FREMD');
  });

  it('hält fehlende Entities aus (Datei als Teilmenge)', async () => {
    const result = await query();
    expect(result?.rows.find((r) => r.searchTerm === 'unbekannt')).toMatchObject({
      amazonCampaignId: 'C-FEHLT',
      campaignId: null,
      campaignName: null,
      adGroupId: null,
      adGroupName: null,
      targetId: null,
      keywordText: null,
      matchType: null,
      expression: null,
      alreadyTargeted: false,
    });
  });

  it('erkennt vorhandene exakte Targets (ohne Groß-/Kleinschreibung und doppelte Leerzeichen, auch pausiert und als ASIN)', async () => {
    const result = await query();
    const targeted = Object.fromEntries(result!.rows.map((r) => [r.searchTerm, r.alreadyTargeted]));
    expect(targeted).toEqual({
      'led lampe': true,
      b0test0001: true,
      // nur als Wortgruppe gebucht (exakt nur in einem anderen Profil), archiviert oder entfernt: noch kein Target
      'lampe rot': false,
      'lampe blau': false,
      'lampe gelb': false,
      unbekannt: false,
      'sb begriff': false,
    });
  });

  it('filtert nach Ad-Typ', async () => {
    const result = await query({ adProducts: ['SPONSORED_BRANDS'] });
    expect(result?.rows.map((r) => r.searchTerm)).toEqual(['sb begriff']);
  });

  it('liefert für einen Zeitraum ohne Daten keine Zeilen', async () => {
    const result = await query({ periodStart: '2026-01-01', periodEnd: '2026-01-31' });
    expect(result?.rows).toEqual([]);
    expect(result?.importedAt).toBeNull();
  });

  it('verweigert ausgeblendete und fremde Profile und Nicht-Mitglieder', async () => {
    expect(await query({ profileId: ids.hidden })).toBeNull();
    expect(await query({ profileId: ids.hidden, userId: ids.admin })).toBeNull();
    expect(await query({ profileId: ids.foreign })).toBeNull();
    expect(await query({ userId: ids.outsider })).toBeNull();
    expect(await query({ userId: ids.outsider, orgId: ids.otherOrg })).toBeNull();
    expect(await query({ userId: ids.stranger })).toBeNull();
  });
});

describe('Regeln je Organisation', () => {
  it('liefert die Startwerte, solange nichts gespeichert ist', async () => {
    expect(await getSearchTermRules(testDb.db, as(ids.viewer))).toEqual({
      rules: DEFAULT_SEARCH_TERM_RULES,
      isDefault: true,
      updatedAt: null,
    });
  });

  it('speichert Regeln mit Audit-Event und überschreibt sie beim nächsten Mal', async () => {
    const rules = {
      harvestMinPurchases: 2,
      harvestMaxAcos: '0.3',
      negateMinClicks: 15,
      negateMinCost: '10.50',
    };
    const saved = await saveSearchTermRules(testDb.db, { ...as(ids.admin), rules });
    expect(saved).toMatchObject({ rules, isDefault: false });
    expect(saved?.updatedAt).toBeInstanceOf(Date);
    expect(await getSearchTermRules(testDb.db, as(ids.viewer))).toMatchObject({
      rules,
      isDefault: false,
    });

    const next = { ...rules, negateMinClicks: 40 };
    await saveSearchTermRules(testDb.db, { ...as(ids.admin), rules: next });
    expect((await getSearchTermRules(testDb.db, as(ids.viewer)))?.rules).toEqual(next);
    expect(await testDb.db.select().from(searchTermRules)).toHaveLength(1);

    const events = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'search_term_rules.update'));
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      organizationId: ids.org,
      actorUserId: ids.admin,
      target: { type: 'search_term_rules', id: ids.org, before: rules, after: next },
    });
  });

  it('trennt Organisationen und weist Nicht-Mitglieder ab', async () => {
    expect(await getSearchTermRules(testDb.db, as(ids.outsider, ids.otherOrg))).toMatchObject({
      isDefault: true,
    });
    expect(await getSearchTermRules(testDb.db, as(ids.outsider))).toBeNull();
    expect(
      await saveSearchTermRules(testDb.db, {
        ...as(ids.outsider),
        rules: DEFAULT_SEARCH_TERM_RULES,
      }),
    ).toBeNull();
  });
});
