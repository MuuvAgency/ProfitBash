import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import {
  BudgetCapError,
  deleteBudgetCap,
  getBudgetsOverview,
  saveBudgetCap,
  type BudgetCapInput,
} from './budget-caps';
import { replaceEntityPeriodMetrics } from './entity-period-metrics';
import {
  amazonAdsCampaignDailyMetrics,
  amazonAdsCampaigns,
  amazonAdsPortfolios,
  amazonAdsProfiles,
  auditEvents,
  budgetCaps,
  tagAssignments,
  tags,
  users,
} from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

/** Budget-Caps (`phase-5.md` 5.9a): je Profil und Umfang, Pacing aus dem Datenstand der Kampagnen. */

let testDb: TestDatabase;
let f: AdChangeFixture;
let other: AdChangeFixture;
let portfolio = '';
let emptyPortfolio = '';
let otherPortfolio = '';
let tag = '';
let otherTag = '';
let stranger = '';

/** Mitte Oktober in Berlin. */
const NOW = new Date('2026-10-15T10:00:00Z');
const as = (userId: string, orgId = f.org) => ({ userId, orgId, now: NOW });
const cap = (input: Partial<BudgetCapInput> = {}, actor = as(f.ada)) =>
  saveBudgetCap(testDb.db, {
    ...actor,
    profileId: f.profile,
    scope: { type: 'profile', ids: [] },
    amount: '1000',
    monthAmounts: {},
    warnPercents: [80, 100],
    ...input,
  });
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof BudgetCapError) return err.code;
    throw err;
  }
  return null;
};
const capsOf = async (profileId = f.profile, actor = as(f.emil)) =>
  (await getBudgetsOverview(testDb.db, actor))!.profiles.find((p) => p.id === profileId)!.caps;

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  f = await seedAdChangeFixture(db);
  other = await seedAdChangeFixture(db, 'andere');
  const portfolioRow = (x: AdChangeFixture, amazonPortfolioId: string, name: string) => ({
    organizationId: x.org,
    profileId: x.profile,
    amazonPortfolioId,
    name,
  });
  const [mine, empty, foreign] = await db
    .insert(amazonAdsPortfolios)
    .values([
      portfolioRow(f, '501', 'Marke'),
      portfolioRow(f, '502', 'Leer'),
      portfolioRow(other, '503', 'Fremd'),
    ])
    .returning({ id: amazonAdsPortfolios.id });
  portfolio = mine!.id;
  emptyPortfolio = empty!.id;
  otherPortfolio = foreign!.id;
  await db
    .update(amazonAdsCampaigns)
    .set({ portfolioId: portfolio })
    .where(eq(amazonAdsCampaigns.id, f.campaign));
  const [own, alien] = await db
    .insert(tags)
    .values([
      { organizationId: f.org, name: 'Fokus', color: 'violet' },
      { organizationId: other.org, name: 'Fremd', color: 'violet' },
    ])
    .returning({ id: tags.id });
  tag = own!.id;
  otherTag = alien!.id;
  await db.insert(tagAssignments).values({
    tagId: tag,
    organizationId: f.org,
    profileId: f.profile,
    entityType: 'campaign',
    entityId: f.campaign,
  });
  // 300 in den ersten zehn Tagen des Oktobers; das Tagesbudget der Kampagne ist 20.
  await replaceEntityPeriodMetrics(db, {
    organizationId: f.org,
    profileId: f.profile,
    adProduct: 'SPONSORED_PRODUCTS',
    period: { startDate: '2026-10-01', endDate: '2026-10-10' },
    currencyCode: 'EUR',
    rows: [
      {
        level: 'campaign',
        amazonCampaignId: '1001',
        amazonEntityId: '1001',
        impressions: 1000,
        clicks: 100,
        cost: '300',
        sales: '900',
        purchases: 9,
        units: 9,
      },
    ],
    replace: 'period',
    now: new Date('2026-10-11T08:00:00Z'),
  });
  const [niemand] = await db
    .insert(users)
    .values({ name: 'Niemand', email: 'niemand@nirgends.test' })
    .returning({ id: users.id });
  stranger = niemand!.id;
});

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  const { db } = testDb;
  await db.delete(budgetCaps);
  await db.delete(auditEvents);
  await db.delete(amazonAdsCampaignDailyMetrics);
  await db.update(amazonAdsProfiles).set({ isHidden: false });
});

describe('saveBudgetCap und getBudgetsOverview', () => {
  it('legt einen Cap fürs ganze Profil an und rechnet das Pacing des laufenden Monats', async () => {
    const created = (await cap())!;
    const overview = (await getBudgetsOverview(testDb.db, as(f.emil)))!;
    const profile = overview.profiles.find((p) => p.id === f.profile)!;
    expect(profile).toMatchObject({
      accountName: 'Nordwind DE',
      currencyCode: 'EUR',
      month: '2026-10',
      dataState: { periodStart: '2026-10-01', periodEnd: '2026-10-10' },
      portfolios: [
        { id: emptyPortfolio, name: 'Leer' },
        { id: portfolio, name: 'Marke' },
      ],
    });
    expect(profile.caps).toHaveLength(1);
    expect(profile.caps[0]).toMatchObject({
      id: created.id,
      scope: { type: 'profile', ids: [] },
      scopeLabels: [],
      amount: '1000.00',
      effectiveAmount: '1000.00',
      monthAmounts: {},
      warnPercents: [80, 100],
      pacing: {
        exact: true,
        dataThrough: '2026-10-10',
        actual: { value: '300' },
        planned: '322.58',
        forecast: { value: '720' },
        warnLevel: null,
        forecastOver: false,
      },
      campaignCount: 1,
      campaigns: [
        {
          id: f.campaign,
          name: 'Kampagne 1001',
          state: 'ENABLED',
          dailyBudget: '20',
          actual: '300',
          exact: true,
        },
      ],
    });
    expect(overview.tags).toEqual([{ id: tag, name: 'Fokus' }]);
    // Profil ohne Cap und ohne Kennzahlen.
    expect(overview.profiles.find((p) => p.id === f.fileProfile)).toMatchObject({
      dataState: null,
      caps: [],
    });
    const [event] = await testDb.db.select().from(auditEvents);
    expect(event).toMatchObject({ action: 'budget_cap.create', actorUserId: f.ada });
    expect(event!.target).toMatchObject({
      type: 'budget_cap',
      id: created.id,
      profileId: f.profile,
      after: { amount: '1000.00', scope: { type: 'profile', ids: [] } },
    });
  });

  it('der Betrag eines einzelnen Monats gewinnt in diesem Monat', async () => {
    await cap({ monthAmounts: { '2026-10': '350', '2026-11': '5000' } });
    const [row] = await capsOf();
    expect(row).toMatchObject({
      amount: '1000.00',
      effectiveAmount: '350',
      monthAmounts: { '2026-10': '350', '2026-11': '5000' },
      // 300 von 350 sind über 80 %; die Prognose 720 liegt über dem Cap.
      pacing: { planned: '112.9', warnLevel: 80, forecastOver: true },
    });
  });

  it('Umfang Portfolios und Tags: nur deren Kampagnen zählen', async () => {
    await cap({ scope: { type: 'portfolios', ids: [portfolio] } });
    await cap({ scope: { type: 'portfolios', ids: [emptyPortfolio] } });
    await cap({ scope: { type: 'tags', ids: [tag] } });
    const caps = await capsOf();
    expect(caps).toHaveLength(3);
    const by = (label: string) => caps.find((c) => c.scopeLabels.includes(label))!;
    expect(by('Marke')).toMatchObject({ campaignCount: 1, pacing: { actual: { value: '300' } } });
    expect(by('Leer')).toMatchObject({
      campaignCount: 0,
      campaigns: [],
      pacing: { actual: { value: '0' }, dataThrough: null },
    });
    expect(by('Fokus')).toMatchObject({ campaignCount: 1, pacing: { actual: { value: '300' } } });
  });

  it('lehnt Portfolios anderer Profile und Tags anderer Organisationen ab', async () => {
    expect(await code(cap({ scope: { type: 'portfolios', ids: [otherPortfolio] } }))).toBe(
      'INVALID_SCOPE',
    );
    expect(await code(cap({ scope: { type: 'tags', ids: [tag, otherTag] } }))).toBe(
      'INVALID_SCOPE',
    );
    expect(await testDb.db.select().from(budgetCaps)).toHaveLength(0);
  });

  it('ändert einen Cap (Audit mit vorher/nachher), ohne Änderung kein Audit', async () => {
    const created = (await cap())!;
    const updated = (await cap(
      { id: created.id, amount: '1200', warnPercents: [90] },
      as(f.emil),
    ))!;
    expect(updated.id).toBe(created.id);
    await cap({ id: created.id, amount: '1200', warnPercents: [90] });
    expect(await capsOf()).toMatchObject([{ amount: '1200.00', warnPercents: [90] }]);
    const events = await testDb.db.select().from(auditEvents).orderBy(auditEvents.createdAt);
    expect(events.map((e) => [e.action, e.actorUserId])).toEqual([
      ['budget_cap.create', f.ada],
      ['budget_cap.update', f.emil],
    ]);
    expect(events[1]!.target).toMatchObject({
      before: { amount: '1000.00', warnPercents: [80, 100] },
      after: { amount: '1200.00', warnPercents: [90] },
    });
  });

  it('Tageswerte im Monat: Ist exakt bis zum letzten importierten Tag', async () => {
    await testDb.db.insert(amazonAdsCampaignDailyMetrics).values(
      ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'].map((date) => ({
        organizationId: f.org,
        profileId: f.fileProfile,
        campaignId: f.fileCampaign,
        adProduct: 'SPONSORED_PRODUCTS',
        date,
        currencyCode: 'EUR',
        impressions: 100,
        clicks: 10,
        cost: '10',
        importedAt: NOW,
      })),
    );
    await cap({ profileId: f.fileProfile });
    const profile = (await getBudgetsOverview(testDb.db, as(f.emil)))!.profiles.find(
      (p) => p.id === f.fileProfile,
    )!;
    expect(profile.dataState).toEqual({ periodStart: '2026-10-01', periodEnd: '2026-10-03' });
    expect(profile.caps[0]).toMatchObject({
      // 10 je Tag (unter dem Tagesbudget 20) für die übrigen 28 Tage.
      pacing: {
        exact: true,
        dataThrough: '2026-10-03',
        actual: { value: '30', low: '30', high: '30' },
        forecast: { value: '310' },
      },
      campaigns: [{ id: f.fileCampaign, actual: '30', exact: true }],
    });
  });

  it('höchstens 20 Caps je Profil', async () => {
    for (let i = 0; i < 20; i++) await cap();
    expect(await code(cap())).toBe('LIMIT_REACHED');
  });
});

describe('deleteBudgetCap', () => {
  it('löscht mit Audit-Event', async () => {
    const created = (await cap())!;
    await testDb.db.delete(auditEvents);
    expect(await deleteBudgetCap(testDb.db, { ...as(f.emil), id: created.id })).toBe(true);
    expect(await testDb.db.select().from(budgetCaps)).toHaveLength(0);
    const [event] = await testDb.db.select().from(auditEvents);
    expect(event).toMatchObject({ action: 'budget_cap.delete', actorUserId: f.emil });
    expect(event!.target).toMatchObject({ id: created.id, before: { amount: '1000.00' } });
  });
});

describe('Zugriff', () => {
  it('fremde Organisation: weder sehen noch ändern noch löschen', async () => {
    const created = (await cap())!;
    const foreign = as(other.ada, other.org);
    expect(await capsOf(other.profile, foreign)).toEqual([]);
    expect(
      (await getBudgetsOverview(testDb.db, foreign))!.profiles.some((p) => p.id === f.profile),
    ).toBe(false);
    expect(await code(cap({}, foreign))).toBe('NOT_FOUND');
    expect(await code(cap({ id: created.id, profileId: other.profile }, foreign))).toBe(
      'NOT_FOUND',
    );
    expect(await code(deleteBudgetCap(testDb.db, { ...foreign, id: created.id }))).toBe(
      'NOT_FOUND',
    );
    expect(await testDb.db.select().from(budgetCaps)).toHaveLength(1);
  });

  it('ausgeblendetes Profil: Cap unsichtbar und nicht änderbar', async () => {
    const created = (await cap())!;
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, f.profile));
    const overview = (await getBudgetsOverview(testDb.db, as(f.ada)))!;
    expect(overview.profiles.some((p) => p.id === f.profile)).toBe(false);
    expect(await code(cap())).toBe('NOT_FOUND');
    expect(await code(cap({ id: created.id, amount: '5' }))).toBe('NOT_FOUND');
    expect(await code(deleteBudgetCap(testDb.db, { ...as(f.ada), id: created.id }))).toBe(
      'NOT_FOUND',
    );
  });

  it('kein Mitglied: null', async () => {
    expect(await getBudgetsOverview(testDb.db, as(stranger))).toBeNull();
    expect(await cap({}, as(stranger))).toBeNull();
    expect(await deleteBudgetCap(testDb.db, { ...as(stranger), id: f.profile })).toBeNull();
  });
});
