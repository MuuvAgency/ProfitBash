import {
  replaceEntityPeriodMetrics,
  schema,
  type AutomationRunEntities,
  type AutomationRunPlan,
  type Db,
  type EntityPeriodMetric,
} from '@profitbash/db';
import {
  createTestDatabase,
  seedAdChangeFixture,
  type AdChangeFixture,
  type TestDatabase,
} from '@profitbash/db/testing';
import { computePacing } from '@profitbash/engine';
import { DEFAULT_AUTOMATION_RULES, DEFAULT_GUARDRAILS } from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJobRunner } from '../run-job';
import {
  computeAutomationProposals,
  dispatchAutomationRuns,
  runAutomation,
} from './automation-run';

/** Job `automation-run` (`phase-5.md` 5.7): Datenstand → Regeln → Optimizer → Leitplanken → Lauf und Vorschläge. */

const {
  adChanges,
  amazonAdsEntityPeriodMetrics,
  automationProposals,
  automationRuns,
  budgetCaps,
  goals,
  jobRuns,
} = schema;

let testDb: TestDatabase;
let f: AdChangeFixture;
const NOW = new Date('2026-10-10T08:00:00Z');
const PERIOD = { startDate: '2026-09-08', endDate: '2026-10-07' };

const row = (
  level: EntityPeriodMetric['level'],
  amazonEntityId: string,
  clicks: number,
  cost: string,
  sales: string,
  purchases: number,
): EntityPeriodMetric => ({
  level,
  amazonCampaignId: '1001',
  amazonEntityId,
  impressions: clicks * 100,
  clicks,
  cost,
  sales,
  purchases,
  units: purchases,
});
const job = () => ({ organizationId: f.org, profileId: f.profile });
const run = () =>
  runAutomation(
    createJobRunner({ db: testDb.db, logger: () => {} }),
    { db: testDb.db, now: () => NOW },
    job(),
  );

beforeAll(async () => {
  testDb = await createTestDatabase();
  f = await seedAdChangeFixture(testDb.db);
});
afterAll(() => testDb?.close());

beforeEach(async () => {
  const { db } = testDb;
  await db.delete(automationProposals);
  await db.delete(budgetCaps);
  await db.delete(automationRuns);
  await db.delete(adChanges);
  await db.delete(jobRuns);
  await db.delete(goals);
  await db.delete(amazonAdsEntityPeriodMetrics);
  await replaceEntityPeriodMetrics(db, {
    ...job(),
    adProduct: 'SPONSORED_PRODUCTS',
    period: PERIOD,
    currencyCode: 'EUR',
    rows: [
      row('campaign', '1001', 500, '400.00', '1000.00', 40),
      row('adGroup', '2001', 300, '250.00', '700.00', 25),
      // Keyword 0.50: 40 Klicks ohne Bestellung → Startregel „−20 %“.
      row('target', '3001', 40, '12.00', '0', 0),
      // Produkt-Target ohne eigenes Gebot (Standardgebot 0.40): keine Regel passt → Optimizer.
      row('target', '3002', 20, '8.00', '40.00', 2),
    ],
    replace: 'period',
    now: NOW,
  });
  await db
    .insert(goals)
    .values({ organizationId: f.org, profileId: f.profile, metric: 'acos', value: '25' });
});

const proposals = () =>
  testDb.db
    .select({
      entityId: automationProposals.entityId,
      field: automationProposals.field,
      oldAmount: automationProposals.oldAmount,
      newAmount: automationProposals.newAmount,
      source: automationProposals.source,
      ruleName: automationProposals.ruleName,
      limitedBy: automationProposals.limitedBy,
      status: automationProposals.status,
      detail: automationProposals.detail,
    })
    .from(automationProposals)
    .orderBy(automationProposals.source);

describe('runAutomation', () => {
  it('rechnet je Target Regel bzw. Optimizer mit Leitplanken und protokolliert Lauf und Vorschläge', async () => {
    const result = (await run())!;
    expect(result.status).toBe('success');

    expect(await proposals()).toEqual([
      {
        entityId: f.productTarget,
        field: 'bid',
        oldAmount: '0.4',
        // Wert je Klick 2.1202 × 25 % = 0.53, der Wochenrahmen (+25 %) hält bei 0.50.
        newAmount: '0.5',
        source: 'optimizer',
        ruleName: null,
        limitedBy: ['weeklyChange'],
        status: 'open',
        detail: expect.objectContaining({
          clicks: 20,
          spend: '8.00',
          sales: '40.00',
          orders: 2,
          goalAcos: '25',
          desired: '0.53',
          valuePerClick: '2.1202',
          hasOwnBid: false,
        }),
      },
      {
        entityId: f.keyword,
        field: 'bid',
        oldAmount: '0.5',
        newAmount: '0.4',
        source: 'rule',
        ruleName: 'Viele Klicks ohne Bestellung',
        limitedBy: [],
        status: 'open',
        detail: expect.objectContaining({ clicks: 40, orders: 0, desired: '0.4', hasOwnBid: true }),
      },
    ]);
    const [jobRun] = await testDb.db.select().from(jobRuns);
    expect(jobRun).toMatchObject({
      job: 'automation-run',
      status: 'success',
      organizationId: f.org,
      scope: f.profile,
      counters: { targets: 2, campaigns: 1, proposals: 2, staged: 0 },
    });
    const [stored] = await testDb.db.select().from(automationRuns);
    expect(stored).toMatchObject({
      jobRunId: result.runId,
      mode: 'shadow',
      counts: { targets: 2, campaigns: 1, proposals: 2, noRule: 1 },
    });
  });

  it('tut ohne neue Daten nichts: kein zweiter Lauf, kein job_run', async () => {
    await run();
    expect(await run()).toBeNull();
    expect(await testDb.db.select().from(automationRuns)).toHaveLength(1);
    expect(await testDb.db.select().from(jobRuns)).toHaveLength(1);
  });

  it('hält einen Fehler beim Planen als fehlgeschlagenen Lauf fest (sichtbar im Sync-Status)', async () => {
    const broken = {
      select: () => {
        throw new Error('Datenbank nicht erreichbar.');
      },
    } as unknown as Db;
    const result = await runAutomation(
      createJobRunner({ db: testDb.db, logger: () => {} }),
      { db: broken, now: () => NOW },
      job(),
    );
    expect(result).toMatchObject({ status: 'failed' });
    expect(await testDb.db.select().from(jobRuns)).toMatchObject([
      { job: 'automation-run', status: 'failed', scope: f.profile },
    ]);
  });

  it('macht keinen Vorschlag für Entities mit einer händischen offenen Änderung', async () => {
    await testDb.db.insert(adChanges).values({
      organizationId: f.org,
      profileId: f.profile,
      origin: 'explorer',
      operation: 'update',
      entityType: 'target',
      entityId: f.keyword,
      campaignId: f.campaign,
      adGroupId: f.adGroup,
      field: 'state',
      oldValue: 'ENABLED',
      newValue: 'PAUSED',
      createdBy: f.ada,
    });
    await run();
    expect((await proposals()).map((x) => x.entityId)).toEqual([f.productTarget]);
    const [stored] = await testDb.db.select().from(automationRuns);
    expect(stored!.counts).toMatchObject({ manualPending: 1 });
    // Die händische Änderung bleibt unberührt.
    expect(
      await testDb.db.select().from(adChanges).where(eq(adChanges.origin, 'explorer')),
    ).toHaveLength(1);
  });
});

describe('runAutomation mit Budget-Cap (5.9b)', () => {
  it('legt bei Prognose über dem Cap einen Vorschlag mit Herkunft budget_cap ins Protokoll', async () => {
    // Kampagne 1001: ≈ 93,33 im Oktober, Prognose 413,33 bei einem Cap von 200; Tagesbudget 20, höchstens −20 %.
    await testDb.db.insert(budgetCaps).values({
      organizationId: f.org,
      profileId: f.profile,
      scopeType: 'profile',
      scopeIds: [],
      amount: '200',
      monthAmounts: {},
      warnPercents: [80, 100],
    });
    await run();

    const rows = (await proposals()).filter((x) => x.entityId === f.campaign);
    expect(rows).toMatchObject([{ field: 'budget', source: 'budget_cap', ruleName: null }]);
    expect([Number(rows[0]!.oldAmount), Number(rows[0]!.newAmount)]).toEqual([20, 16]);
  });
});

describe('computeAutomationProposals', () => {
  const metrics = { impressions: 9000, clicks: 100, orders: 0, spend: '1600.00', sales: '0' };
  const plan = (patch: Partial<AutomationRunPlan> = {}): AutomationRunPlan => ({
    profile: { id: 'p1', clientId: null, currencyCode: 'SEK', countryCode: 'SE' },
    mode: 'shadow',
    responsibleUserId: null,
    responsibleMissing: false,
    guardrails: { ...DEFAULT_GUARDRAILS, maxBidChangePercent: 100, maxBidEur: '0.80' },
    eurRate: '10',
    rules: [],
    goals: [{ scope: 'profile', scopeId: 'p1', metric: 'acos', value: '20' }],
    protectedTerms: [],
    state: { period: PERIOD, importedAt: NOW, source: 'file' },
    caps: [],
    fingerprint: 'x',
    warnings: [],
    ...patch,
  });
  const entities = (patch: Partial<AutomationRunEntities> = {}): AutomationRunEntities => ({
    campaigns: [
      {
        id: 'c1',
        adProduct: 'SPONSORED_PRODUCTS',
        state: 'ENABLED',
        costType: null,
        budget: '200.00',
        metrics,
      },
    ],
    adGroups: [
      { id: 'g1', state: 'ENABLED', defaultBid: '5.00', metrics: null, productGroupIds: ['pg1'] },
    ],
    targets: [
      {
        id: 't1',
        campaignId: 'c1',
        adGroupId: 'g1',
        adProduct: 'SPONSORED_PRODUCTS',
        state: 'ENABLED',
        bid: '5.00',
        protectedTerm: false,
        metrics: { impressions: 4000, clicks: 50, orders: 10, spend: '100.00', sales: '5000.00' },
      },
    ],
    manualPending: new Set(),
    bases: new Map(),
    ...patch,
  });

  it('rechnet die Leitplanken von EUR in die Währung des Profils um', () => {
    // Zielgebot 16.13 SEK; Wochenrahmen +100 % = 10 SEK, Höchstgebot 0,80 € = 8 SEK.
    const { proposals } = computeAutomationProposals(plan(), entities());
    expect(proposals).toMatchObject([
      {
        entityId: 't1',
        field: 'bid',
        before: '5',
        after: '8',
        limitedBy: ['weeklyChange', 'maxBid'],
      },
    ]);
  });

  it('nimmt das strengste Ziel der Produktgruppen der Ad Group und das Ausgangsgebot aus Änderungen', () => {
    const strict = plan({
      goals: [
        { scope: 'profile', scopeId: 'p1', metric: 'acos', value: '20' },
        { scope: 'productGroup', scopeId: 'pg1', metric: 'acos', value: '5' },
      ],
    });
    // 100 SEK × 5 % = 5 SEK = Gebot: kein Vorschlag. Mit Ausgangsgebot 8 aus einer Änderung: Senkung auf 5.
    const alone = entities();
    alone.campaigns[0]!.metrics = null;
    expect(computeAutomationProposals(strict, alone).proposals).toEqual([]);
    const withBase = entities({
      campaigns: alone.campaigns,
      bases: new Map([['t1:bid', { base: '8.00', windowStart: '8.00' }]]),
    });
    expect(computeAutomationProposals(strict, withBase).proposals).toMatchObject([
      { before: '8', after: '5', detail: { goalAcos: '5' } },
    ]);
  });

  it('Kampagnen: Budget per Regel mit Leitplanke; ohne Kennzahlen im Datenstand nichts', () => {
    const budgetRule = { ...DEFAULT_AUTOMATION_RULES[2]!, enabled: true };
    const withRule = plan({ rules: [budgetRule] });
    const result = computeAutomationProposals(withRule, entities());
    expect(result.proposals).toContainEqual(
      expect.objectContaining({
        entityType: 'campaign',
        entityId: 'c1',
        campaignId: 'c1',
        adGroupId: null,
        field: 'budget',
        before: '200',
        after: '180',
        ruleId: budgetRule.id,
      }),
    );
    expect(result.counts).toMatchObject({ targets: 1, campaigns: 1 });
    const stale = entities();
    stale.campaigns[0]!.metrics = null;
    expect(
      computeAutomationProposals(withRule, stale).proposals.filter((x) => x.field === 'budget'),
    ).toEqual([]);
  });

  describe('Budget-Caps (5.9b)', () => {
    // c1: 1600 in 30 Tagen bis 07.10., davon 7 im Oktober (≈ 373,33, untere Schätzung 186,67); je Tag 53,33.
    const cap = (id: string, amount: string): AutomationRunPlan['caps'][number] => ({
      id,
      month: '2026-10',
      amount,
      warnPercents: [80, 100],
      pacing: computePacing({
        month: '2026-10',
        cap: amount,
        warnPercents: [80, 100],
        campaigns: [input],
      }),
      campaigns: [{ id: 'c1', input }],
    });
    const input = {
      cost: '1600.00',
      periodStart: PERIOD.startDate,
      periodEnd: PERIOD.endDate,
      active: true,
      dailyBudget: '200.00',
    };
    const budgetRule = { ...DEFAULT_AUTOMATION_RULES[2]!, enabled: true };
    const campaignProposals = (caps: AutomationRunPlan['caps'], patch = {}) =>
      computeAutomationProposals(plan({ rules: [budgetRule], caps }), entities(patch));

    it('Prognose über dem Cap: der Enforcer senkt das Tagesbudget, die Budget-Regel ruht', () => {
      const { proposals } = campaignProposals([cap('cap1', '500')]);
      expect(proposals.filter((x) => x.entityType === 'campaign')).toMatchObject([
        {
          entityId: 'c1',
          campaignId: 'c1',
          adGroupId: null,
          field: 'budget',
          before: '200',
          after: '160',
          source: 'budget_cap',
          ruleId: null,
          limitedBy: ['budgetDecrease'],
          detail: {
            capId: 'cap1',
            capAmount: '500',
            month: '2026-10',
            actual: '373.33',
            forecast: '1653.33',
            desired: '5.28',
            spend: '1600.00',
          },
        },
      ]);
    });

    it('Prognose unter dem Cap: die Regel gilt wie bisher', () => {
      const { proposals } = campaignProposals([cap('cap1', '5000')]);
      expect(proposals.filter((x) => x.entityType === 'campaign')).toMatchObject([
        { field: 'budget', after: '180', source: 'rule', ruleId: budgetRule.id },
      ]);
    });

    it('untere Schätzung über dem Cap: pausieren; bei mehreren Caps gilt der strengste Vorschlag', () => {
      const { proposals } = campaignProposals([cap('cap1', '500'), cap('cap2', '100')]);
      expect(proposals.filter((x) => x.entityType === 'campaign')).toMatchObject([
        {
          field: 'state',
          before: 'ENABLED',
          after: 'PAUSED',
          source: 'budget_cap',
          limitedBy: [],
          detail: { capId: 'cap2', actualLow: '186.67', dataThrough: '2026-10-07' },
        },
      ]);
    });

    it('rechnet mit dem Budget aus einer übermittelten Änderung und lässt händisch belegte Kampagnen aus', () => {
      const lowered = campaignProposals([cap('cap1', '500')], {
        bases: new Map([['c1:budget', { base: '150.00', windowStart: '200.00' }]]),
      });
      expect(lowered.proposals.filter((x) => x.entityType === 'campaign')).toMatchObject([
        { before: '150', after: '120', source: 'budget_cap' },
      ]);
      const manual = campaignProposals([cap('cap1', '500')], { manualPending: new Set(['c1']) });
      expect(manual.proposals.filter((x) => x.entityType === 'campaign')).toEqual([]);
      expect(manual.counts.manualPending).toBe(1);
    });

    it('nichts zu senken (Budget schon am Minimum): kein Vorschlag, gezählt als budgetCap', () => {
      const atMinimum = entities();
      atMinimum.campaigns[0]!.budget = '0.01';
      const result = computeAutomationProposals(
        plan({ rules: [budgetRule], caps: [cap('cap1', '500')] }),
        atMinimum,
      );
      expect(result.proposals.filter((x) => x.entityType === 'campaign')).toEqual([]);
      expect(result.counts.budgetCap).toBe(1);
    });
  });
});

describe('dispatchAutomationRuns', () => {
  it('plant für jedes Profil mit Kennzahlen einen Lauf ein', async () => {
    const queued: unknown[] = [];
    const outcome = await dispatchAutomationRuns({
      db: testDb.db,
      enqueue: async (data) => {
        queued.push(data);
        return true;
      },
    });
    expect(queued).toEqual([job()]);
    expect(outcome).toEqual({ counters: { profiles: 1, queued: 1 } });
  });
});
