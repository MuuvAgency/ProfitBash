import { DEFAULT_AUTOMATION_RULES, type AutomationRule } from '@profitbash/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import { AutomationError } from './automation';
import {
  getAutomationRules,
  previewAutomationRules,
  saveAutomationRules,
} from './automation-rules';
import { replaceEntityPeriodMetrics, type EntityPeriodMetric } from './entity-period-metrics';
import { eq } from 'drizzle-orm';
import {
  amazonAdsCampaigns,
  amazonAdsEntityPeriodMetrics,
  amazonAdsProfiles,
  amazonAdsTargets,
  auditEvents,
  automationRules,
  clients,
  fxRates,
  goals,
  users,
} from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

/** Regeln der Automatik (`phase-5.md` 5.6a): eine Liste je Organisation, Startregeln, Version, Audit. */

let testDb: TestDatabase;
let f: AdChangeFixture;
let other: AdChangeFixture;
let client = '';
let otherClient = '';
let stranger = '';

const as = (userId: string, orgId = f.org) => ({ userId, orgId });
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AutomationError) return err.code;
    throw err;
  }
  return null;
};
const rule = (patch: Partial<AutomationRule> = {}): AutomationRule => ({
  ...DEFAULT_AUTOMATION_RULES[0]!,
  id: '00000000-0000-4000-8000-0000000000f1',
  name: 'Eigene Regel',
  ...patch,
});
const save = (rules: AutomationRule[], version = 0, actor = as(f.emil)) =>
  saveAutomationRules(testDb.db, { ...actor, rules, version });

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  f = await seedAdChangeFixture(db);
  other = await seedAdChangeFixture(db, 'andere');
  const [kunde, fremd] = await db
    .insert(clients)
    .values([
      { organizationId: f.org, name: 'Kunde', slug: 'kunde' },
      { organizationId: other.org, name: 'Fremd', slug: 'fremd' },
    ])
    .returning({ id: clients.id });
  client = kunde!.id;
  otherClient = fremd!.id;
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
  await testDb.db.delete(automationRules);
  await testDb.db.delete(auditEvents);
});

describe('Regeln der Automatik', () => {
  it('liefert ohne gespeicherte Regeln die Startregeln mit Version 0', async () => {
    expect(await getAutomationRules(testDb.db, as(f.emil))).toEqual({
      rules: DEFAULT_AUTOMATION_RULES,
      version: 0,
      updatedAt: null,
    });
    expect(await getAutomationRules(testDb.db, as(stranger))).toBeNull();
  });

  it('speichert die Liste in ihrer Reihenfolge, zählt die Version und schreibt ein Audit-Event', async () => {
    const first = [rule({ clientId: client }), ...DEFAULT_AUTOMATION_RULES];
    expect(await save(first)).toMatchObject({ version: 1, rules: first });
    const second = [DEFAULT_AUTOMATION_RULES[1]!];
    expect(await save(second, 1, as(f.ada))).toMatchObject({ version: 2 });

    expect(await getAutomationRules(testDb.db, as(f.emil))).toMatchObject({
      rules: second,
      version: 2,
    });
    // Eine leere Liste bleibt leer (keine Startregeln mehr).
    await save([], 2);
    expect((await getAutomationRules(testDb.db, as(f.emil)))!.rules).toEqual([]);

    const events = await testDb.db.select().from(auditEvents).orderBy(auditEvents.createdAt);
    expect(events.map((e) => [e.action, e.actorUserId])).toEqual([
      ['automation_rules.update', f.emil],
      ['automation_rules.update', f.ada],
      ['automation_rules.update', f.emil],
    ]);
    expect(events[1]!.target).toMatchObject({
      version: 2,
      before: { version: 1, rules: first },
      after: second,
    });
    // Andere Organisationen behalten ihre Regeln.
    expect((await getAutomationRules(testDb.db, as(other.ada, other.org)))!.version).toBe(0);
  });

  it('lehnt eine veraltete Version ab', async () => {
    await save([rule()]);
    expect(await code(save([], 0))).toBe('VERSION_CONFLICT');
    expect(await code(save([], 5))).toBe('VERSION_CONFLICT');
    expect((await getAutomationRules(testDb.db, as(f.emil)))!.rules).toHaveLength(1);
  });

  it('lehnt Regeln für Clients anderer Organisationen ab', async () => {
    expect(await code(save([rule({ clientId: otherClient })]))).toBe('UNKNOWN_CLIENT');
    expect(await testDb.db.select().from(automationRules)).toHaveLength(0);
  });

  it('liefert null für Nicht-Mitglieder', async () => {
    expect(await save([rule()], 0, as(stranger))).toBeNull();
  });
});

describe('previewAutomationRules', () => {
  const metric = (
    level: EntityPeriodMetric['level'],
    amazonEntityId: string,
    clicks: number,
    cost: string,
    sales: string,
    amazonCampaignId = '1001',
  ): EntityPeriodMetric => ({
    level,
    amazonCampaignId,
    amazonEntityId,
    impressions: clicks * 100,
    clicks,
    cost,
    sales,
    purchases: sales === '0' ? 0 : 2,
    units: 0,
  });
  const importMetrics = (profileId: string, currencyCode: string, rows: EntityPeriodMetric[]) =>
    replaceEntityPeriodMetrics(testDb.db, {
      organizationId: f.org,
      profileId,
      adProduct: 'SPONSORED_PRODUCTS',
      period: { startDate: '2026-09-01', endDate: '2026-09-30' },
      currencyCode,
      rows,
      replace: 'period',
      now: new Date('2026-10-01T08:00:00Z'),
    });
  const preview = (rules: AutomationRule[], actor = as(f.emil)) =>
    previewAutomationRules(testDb.db, { ...actor, rules });
  const noOrders = rule({ id: '00000000-0000-4000-8000-0000000000f1' });
  const overGoal = rule({
    id: '00000000-0000-4000-8000-0000000000f2',
    conditions: [{ metric: 'acos', comparator: 'gte', value: '150', relativeToGoal: true }],
  });
  const budget = rule({
    id: '00000000-0000-4000-8000-0000000000f3',
    level: 'campaign',
    conditions: [{ metric: 'spend', comparator: 'gte', value: '50' }],
    action: { type: 'changePercent', field: 'budget', value: '-10' },
  });

  beforeEach(async () => {
    const { db } = testDb;
    await db.delete(amazonAdsEntityPeriodMetrics);
    await db.delete(goals);
    await db.delete(fxRates);
    await db
      .update(amazonAdsProfiles)
      .set({ isHidden: false, currencyCode: 'EUR', clientId: null });
    await db.update(amazonAdsTargets).set({ state: 'ENABLED' });
    await db
      .insert(goals)
      .values({ organizationId: f.org, profileId: f.profile, metric: 'acos', value: '20' });
    await importMetrics(f.profile, 'EUR', [
      metric('campaign', '1001', 75, '60.00', '100.00'),
      metric('target', '3001', 40, '36.00', '0'), // 40 Klicks ohne Bestellung
      metric('target', '3002', 35, '24.00', '100.00'), // ACoS 24 %, Ziel 20 %
    ]);
  });

  it('zählt je Regel die Entities, für die sie als erste greift', async () => {
    expect(await preview([noOrders, overGoal, budget])).toEqual({
      counts: [
        { ruleId: noOrders.id, entities: 1 },
        { ruleId: overGoal.id, entities: 0 },
        { ruleId: budget.id, entities: 1 },
      ],
      targets: 2,
      campaigns: 1,
    });
    // Reihenfolge entscheidet: Ausgaben ohne Umsatz liegen auch über jedem Ziel.
    expect((await preview([overGoal, noOrders]))!.counts).toEqual([
      { ruleId: overGoal.id, entities: 1 },
      { ruleId: noOrders.id, entities: 0 },
    ]);
  });

  it('nimmt das Ziel von Profil bzw. Client und die Gültigkeit je Client', async () => {
    await testDb.db.delete(goals);
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ clientId: client })
      .where(eq(amazonAdsProfiles.id, f.profile));
    expect((await preview([overGoal]))!.counts[0]!.entities).toBe(0);
    await testDb.db
      .insert(goals)
      .values({ organizationId: f.org, clientId: client, metric: 'acos', value: '10' });
    // Ziel 10 %: beide Targets liegen über 150 % davon.
    expect((await preview([overGoal]))!.counts[0]!.entities).toBe(2);
    expect((await preview([{ ...overGoal, clientId: client }]))!.counts[0]!.entities).toBe(2);
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ clientId: null })
      .where(eq(amazonAdsProfiles.id, f.profile));
    expect((await preview([{ ...noOrders, clientId: client }]))!.counts[0]!.entities).toBe(0);
  });

  it('zählt nur aktive Entities sichtbarer Profile', async () => {
    await testDb.db
      .update(amazonAdsTargets)
      .set({ state: 'PAUSED' })
      .where(eq(amazonAdsTargets.id, f.keyword));
    expect(await preview([noOrders])).toMatchObject({ counts: [{ entities: 0 }], targets: 1 });
    await testDb.db.update(amazonAdsTargets).set({ state: 'ENABLED' });
    // vCPM-Gebote gelten je 1000 Impressions: Gebotsregeln lassen sie aus, Budgetregeln nicht.
    await testDb.db.update(amazonAdsCampaigns).set({ extra: { costType: 'VCPM' } });
    expect(await preview([noOrders, budget])).toMatchObject({ targets: 0, campaigns: 1 });
    await testDb.db.update(amazonAdsCampaigns).set({ extra: {} });
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, f.profile));
    expect(await preview([noOrders])).toMatchObject({ counts: [{ entities: 0 }], targets: 0 });
    expect(await preview([noOrders], as(other.ada, other.org))).toMatchObject({ targets: 0 });
    expect(await preview([noOrders], as(stranger))).toBeNull();
  });

  it('rechnet Beträge der Regeln in die Währung des Profils um; ohne Kurs zählt das Profil nicht', async () => {
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ currencyCode: 'SEK' })
      .where(eq(amazonAdsProfiles.id, f.profile));
    expect(await preview([budget])).toMatchObject({ counts: [{ entities: 0 }], campaigns: 0 });
    await testDb.db.insert(fxRates).values({ date: '2026-10-01', quote: 'SEK', rate: '11.5' });
    // 50 EUR = 575 SEK, die Kampagne hat 60 SEK ausgegeben.
    expect(await preview([budget])).toMatchObject({ counts: [{ entities: 0 }], campaigns: 1 });
    const cheap = {
      ...budget,
      conditions: [{ metric: 'spend', comparator: 'gte', value: '5' } as const],
    };
    expect((await preview([cheap]))!.counts[0]!.entities).toBe(1);
  });
});
