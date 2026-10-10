import { DEFAULT_AUTOMATION_RULES, DEFAULT_GUARDRAILS } from '@profitbash/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import {
  listAutomationRunProfiles,
  loadAutomationRunEntities,
  planAutomationRun,
  saveAutomationRun,
  type AutomationProposalInput,
  type AutomationRunPlan,
} from './automation-runs';
import { replaceEntityPeriodMetrics, type EntityPeriodMetric } from './entity-period-metrics';
import {
  adChangeSubmissions,
  adChanges,
  amazonAdsEntityPeriodMetrics,
  amazonAdsProfiles,
  auditEvents,
  automationProposals,
  automationRules,
  automationRuns,
  clientAutomationSettings,
  clients,
  goals,
  members,
  notifications,
  productGroupItems,
  productGroups,
} from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

/** Läufe der Automatik (`phase-5.md` 5.7): Plan, Entities mit Datenstand, Speichern von Lauf und Vorschlägen. */

let testDb: TestDatabase;
let f: AdChangeFixture;
let client = '';
const NOW = new Date('2026-10-10T08:00:00Z');
const OCTOBER = { startDate: '2026-09-08', endDate: '2026-10-07' };
const SEPTEMBER = { startDate: '2026-09-01', endDate: '2026-09-30' };

const scope = () => ({ organizationId: f.org, profileId: f.profile });
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
const importMetrics = (rows: EntityPeriodMetric[], period = OCTOBER, now = NOW) =>
  replaceEntityPeriodMetrics(testDb.db, {
    ...scope(),
    adProduct: 'SPONSORED_PRODUCTS',
    period,
    currencyCode: 'EUR',
    rows,
    replace: 'period',
    now,
  });
const standardMetrics = () =>
  importMetrics([
    row('campaign', '1001', 500, '400.00', '1000.00', 40),
    row('adGroup', '2001', 300, '250.00', '700.00', 25),
    row('target', '3001', 40, '40.00', '100.00', 4),
    row('target', '3002', 10, '6.00', '0', 0),
  ]);
async function plan(): Promise<AutomationRunPlan> {
  const result = await planAutomationRun(testDb.db, scope());
  if (result.skip !== null) throw new Error(`Kein Plan: ${result.skip}`);
  return result;
}
const setClient = (values: Partial<typeof clientAutomationSettings.$inferInsert>) =>
  testDb.db
    .insert(clientAutomationSettings)
    .values({ clientId: client, organizationId: f.org, mode: 'shadow', overrides: {}, ...values });
const bid = (patch: Partial<AutomationProposalInput> = {}): AutomationProposalInput => ({
  entityType: 'target',
  entityId: f.keyword,
  campaignId: f.campaign,
  adGroupId: f.adGroup,
  field: 'bid',
  before: '0.50',
  after: '0.40',
  source: 'rule',
  ruleId: DEFAULT_AUTOMATION_RULES[0]!.id,
  limitedBy: ['bidFloor'],
  detail: { clicks: 40 },
  ...patch,
});
const save = async (proposals: AutomationProposalInput[], counts = { targets: 2 }) =>
  saveAutomationRun(testDb.db, {
    ...scope(),
    plan: await plan(),
    jobRunId: null,
    counts,
    proposals,
  });
const proposalRows = () =>
  testDb.db
    .select({
      entityId: automationProposals.entityId,
      field: automationProposals.field,
      status: automationProposals.status,
      adChangeId: automationProposals.adChangeId,
      newAmount: automationProposals.newAmount,
      newValue: automationProposals.newValue,
      ruleName: automationProposals.ruleName,
    })
    .from(automationProposals)
    .orderBy(automationProposals.createdAt, automationProposals.field);
const cartRows = () =>
  testDb.db
    .select({
      id: adChanges.id,
      origin: adChanges.origin,
      createdBy: adChanges.createdBy,
      field: adChanges.field,
      oldAmount: adChanges.oldAmount,
      newAmount: adChanges.newAmount,
      newValue: adChanges.newValue,
      currencyCode: adChanges.currencyCode,
    })
    .from(adChanges)
    .where(eq(adChanges.status, 'pending'));
/** Ändert die Regeln, damit ein weiterer Lauf mit demselben Datenstand fällig ist. */
const changeRules = (version: number) =>
  testDb.db
    .insert(automationRules)
    .values({
      organizationId: f.org,
      version,
      rules: [{ ...DEFAULT_AUTOMATION_RULES[0]!, name: `Regel v${version}` }],
    })
    .onConflictDoUpdate({
      target: automationRules.organizationId,
      set: {
        version,
        rules: [{ ...DEFAULT_AUTOMATION_RULES[0]!, name: `Regel v${version}` }],
      },
    });

beforeAll(async () => {
  testDb = await createTestDatabase();
  f = await seedAdChangeFixture(testDb.db);
  const [kunde] = await testDb.db
    .insert(clients)
    .values({
      organizationId: f.org,
      name: 'Kunde',
      slug: 'kunde',
      protectedTerms: ['kw 3001'],
    })
    .returning({ id: clients.id });
  client = kunde!.id;
});

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  const { db } = testDb;
  await db.delete(automationProposals);
  await db.delete(automationRuns);
  await db.delete(adChanges);
  await db.delete(notifications);
  await db.delete(auditEvents);
  await db.delete(amazonAdsEntityPeriodMetrics);
  await db.delete(goals);
  await db.delete(productGroups);
  await db.delete(clientAutomationSettings);
  await db.delete(automationRules);
  await db
    .update(amazonAdsProfiles)
    .set({ clientId: null, isHidden: false })
    .where(eq(amazonAdsProfiles.id, f.profile));
  await db
    .update(members)
    .set({ role: 'editor' })
    .where(and(eq(members.userId, f.emil), eq(members.organizationId, f.org)));
});

const assignClient = () =>
  testDb.db
    .update(amazonAdsProfiles)
    .set({ clientId: client })
    .where(eq(amazonAdsProfiles.id, f.profile));

describe('planAutomationRun', () => {
  it('ohne Kennzahlen kein Lauf; ein Profil ohne Client läuft im Schattenmodus mit den Startwerten', async () => {
    expect(await planAutomationRun(testDb.db, scope())).toEqual({ skip: 'noMetrics' });
    await standardMetrics();
    await testDb.db
      .insert(goals)
      .values({ organizationId: f.org, profileId: f.profile, metric: 'acos', value: '25' });

    expect(await plan()).toMatchObject({
      profile: { id: f.profile, clientId: null, currencyCode: 'EUR', countryCode: 'DE' },
      mode: 'shadow',
      responsibleUserId: null,
      responsibleMissing: false,
      guardrails: DEFAULT_GUARDRAILS,
      eurRate: '1',
      rules: DEFAULT_AUTOMATION_RULES,
      goals: [{ scope: 'profile', scopeId: f.profile, metric: 'acos', value: '25.00' }],
      protectedTerms: [],
      state: { period: OCTOBER, importedAt: NOW },
      warnings: [],
    });
  });

  it('nimmt Modus, Zuständigen, überschriebene Leitplanken, Ziele und geschützte Begriffe des Clients', async () => {
    await standardMetrics();
    await assignClient();
    await setClient({ mode: 'cart', responsibleUserId: f.emil, overrides: { minClicks: 30 } });
    const [group] = await testDb.db
      .insert(productGroups)
      .values({ organizationId: f.org, profileId: f.profile, name: 'Jacken' })
      .returning({ id: productGroups.id });
    await testDb.db.insert(goals).values([
      { organizationId: f.org, clientId: client, metric: 'acos', value: '30' },
      { organizationId: f.org, productGroupId: group!.id, metric: 'roas', value: '5' },
    ]);

    const result = await plan();
    expect(result).toMatchObject({
      mode: 'cart',
      responsibleUserId: f.emil,
      responsibleMissing: false,
      guardrails: { ...DEFAULT_GUARDRAILS, minClicks: 30 },
      protectedTerms: ['kw 3001'],
    });
    expect(result.goals).toEqual(
      expect.arrayContaining([
        { scope: 'client', scopeId: client, metric: 'acos', value: '30.00' },
        { scope: 'productGroup', scopeId: group!.id, metric: 'roas', value: '5.00' },
      ]),
    );
    expect(result.goals).toHaveLength(2);
  });

  it('Modus „aus“ läuft nicht; ohne Schreibrecht des Zuständigen fällt „Warenkorb“ auf den Schattenmodus', async () => {
    await standardMetrics();
    await assignClient();
    await setClient({ mode: 'off' });
    expect(await planAutomationRun(testDb.db, scope())).toEqual({ skip: 'off' });

    await testDb.db
      .update(clientAutomationSettings)
      .set({ mode: 'cart', responsibleUserId: f.emil });
    await testDb.db.update(members).set({ role: 'viewer' }).where(eq(members.userId, f.emil));
    expect(await plan()).toMatchObject({
      mode: 'shadow',
      responsibleUserId: null,
      responsibleMissing: true,
    });
  });

  it('entfernte und ausgeblendete Profile laufen nicht', async () => {
    await standardMetrics();
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, f.profile));
    expect(await planAutomationRun(testDb.db, scope())).toEqual({ skip: 'profileGone' });
    expect(await listAutomationRunProfiles(testDb.db)).toEqual([]);
    expect(await planAutomationRun(testDb.db, { organizationId: f.org, profileId: f.org })).toEqual(
      { skip: 'profileGone' },
    );
  });

  it('nach einem Lauf ist erst wieder einer fällig, wenn Kennzahlen, Regeln, Ziele oder Einstellungen neu sind', async () => {
    await standardMetrics();
    expect(await listAutomationRunProfiles(testDb.db)).toEqual([scope()]);
    await save([]);
    expect(await planAutomationRun(testDb.db, scope())).toEqual({ skip: 'unchanged' });

    await changeRules(1);
    await save([]);
    expect(await planAutomationRun(testDb.db, scope())).toEqual({ skip: 'unchanged' });

    await testDb.db
      .insert(goals)
      .values({ organizationId: f.org, profileId: f.profile, metric: 'acos', value: '25' });
    await save([]);
    expect(await planAutomationRun(testDb.db, scope())).toEqual({ skip: 'unchanged' });

    // Eine ältere Datei, nachträglich hochgeladen: neuer Datenstand, mit Hinweis.
    await importMetrics(
      [row('target', '3001', 5, '5.00', '0', 0)],
      SEPTEMBER,
      new Date('2026-10-11T08:00:00Z'),
    );
    expect(await plan()).toMatchObject({ state: { period: SEPTEMBER }, warnings: ['olderPeriod'] });
  });
});

describe('loadAutomationRunEntities', () => {
  const load = async () =>
    loadAutomationRunEntities(testDb.db, scope(), await plan(), new Date('2026-10-10T09:00:00Z'));

  it('liefert Entities mit Kennzahlen des Datenstands, Produktgruppen je Ad Group und geschützte Begriffe', async () => {
    await standardMetrics();
    await assignClient();
    const [group] = await testDb.db
      .insert(productGroups)
      .values({ organizationId: f.org, profileId: f.profile, name: 'Jacken' })
      .returning({ id: productGroups.id });
    await testDb.db
      .insert(productGroupItems)
      .values({ productGroupId: group!.id, position: 0, asin: 'B0TEST0001' });

    const entities = await load();
    expect(entities.campaigns).toEqual([
      {
        id: f.campaign,
        adProduct: 'SPONSORED_PRODUCTS',
        state: 'ENABLED',
        costType: null,
        budget: '20',
        metrics: { impressions: 50000, clicks: 500, orders: 40, spend: '400.00', sales: '1000.00' },
      },
    ]);
    expect(entities.adGroups).toEqual([
      {
        id: f.adGroup,
        state: 'ENABLED',
        defaultBid: '0.40',
        metrics: { impressions: 30000, clicks: 300, orders: 25, spend: '250.00', sales: '700.00' },
        productGroupIds: [group!.id],
      },
    ]);
    expect(entities.targets).toEqual(
      expect.arrayContaining([
        {
          id: f.keyword,
          campaignId: f.campaign,
          adGroupId: f.adGroup,
          adProduct: 'SPONSORED_PRODUCTS',
          state: 'ENABLED',
          bid: '0.50',
          protectedTerm: true,
          metrics: { impressions: 4000, clicks: 40, orders: 4, spend: '40.00', sales: '100.00' },
        },
        expect.objectContaining({ id: f.productTarget, bid: null, protectedTerm: false }),
      ]),
    );
    expect(entities.targets).toHaveLength(2);
    expect(entities.manualPending.size).toBe(0);
    expect(entities.bases.size).toBe(0);
  });

  it('lässt Entities aus, deren Kennzahlen älter sind als die neueste Datei des Profils', async () => {
    await importMetrics(
      [row('target', '3002', 99, '50.00', '0', 0)],
      SEPTEMBER,
      new Date('2026-10-01T08:00:00Z'),
    );
    await importMetrics([row('target', '3001', 40, '40.00', '100.00', 4)]);
    expect((await load()).targets.map((target) => target.id)).toEqual([f.keyword]);
  });

  it('sperrt Entities mit händischer offener Änderung und liest Ausgangsgebot und Wert zu Beginn der 7 Tage', async () => {
    await standardMetrics();
    const change = (patch: Partial<typeof adChanges.$inferInsert>) => ({
      organizationId: f.org,
      profileId: f.profile,
      origin: 'explorer',
      operation: 'update',
      entityType: 'target',
      entityId: f.keyword,
      campaignId: f.campaign,
      adGroupId: f.adGroup,
      field: 'bid',
      currencyCode: 'EUR',
      createdBy: f.ada,
      ...patch,
    });
    const [submission] = await testDb.db
      .insert(adChangeSubmissions)
      .values({ organizationId: f.org, profileId: f.profile, channel: 'bulk_file' })
      .returning({ id: adChangeSubmissions.id });
    const sent = { submissionId: submission!.id };
    await testDb.db.insert(adChanges).values([
      // Vor dem Fenster angewendet: zählt nicht mehr.
      change({
        ...sent,
        status: 'applied',
        oldAmount: '0.90',
        newAmount: '0.80',
        createdAt: new Date('2026-09-20T08:00:00Z'),
      }),
      change({
        ...sent,
        status: 'applied',
        oldAmount: '0.80',
        newAmount: '0.60',
        createdAt: new Date('2026-10-05T08:00:00Z'),
      }),
      change({
        ...sent,
        status: 'submitted',
        oldAmount: '0.60',
        newAmount: '0.55',
        createdAt: new Date('2026-10-08T08:00:00Z'),
      }),
      // Fehlgeschlagen: zählt nicht.
      change({
        ...sent,
        status: 'failed',
        oldAmount: '0.55',
        newAmount: '0.10',
        createdAt: new Date('2026-10-09T08:00:00Z'),
      }),
      // Von Hand im Warenkorb: sperrt die Kampagne.
      change({
        entityType: 'campaign',
        entityId: f.campaign,
        adGroupId: null,
        field: 'budget',
        status: 'pending',
        oldAmount: '20',
        newAmount: '25',
      }),
      // Eigene offene Zeile der Automatik: sperrt nicht.
      change({
        entityId: f.productTarget,
        origin: 'automation',
        status: 'pending',
        newAmount: '0.30',
      }),
    ]);

    const entities = await load();
    expect([...entities.manualPending]).toEqual([f.campaign]);
    expect(Object.fromEntries(entities.bases)).toEqual({
      [`${f.keyword}:bid`]: { base: '0.55', windowStart: '0.80' },
    });
  });
});

describe('saveAutomationRun', () => {
  it('Schattenmodus: Lauf und Vorschläge im Protokoll, nichts im Warenkorb, Audit', async () => {
    await standardMetrics();
    const result = await save([
      bid(),
      bid({ entityId: f.productTarget, field: 'state', before: 'ENABLED', after: 'PAUSED' }),
    ]);

    expect(result).toMatchObject({ proposals: 2, staged: 0, dismissed: 0 });
    const [run] = await testDb.db.select().from(automationRuns);
    expect(run).toMatchObject({
      id: result.runId,
      profileId: f.profile,
      mode: 'shadow',
      periodStart: OCTOBER.startDate,
      periodEnd: OCTOBER.endDate,
      metricsImportedAt: NOW,
      counts: { targets: 2, proposals: 2, staged: 0, dismissed: 0 },
      warnings: [],
    });
    expect(await proposalRows()).toEqual([
      {
        entityId: f.keyword,
        field: 'bid',
        status: 'open',
        adChangeId: null,
        newAmount: '0.40',
        newValue: null,
        ruleName: 'Viele Klicks ohne Bestellung',
      },
      expect.objectContaining({ field: 'state', newValue: 'PAUSED', newAmount: null }),
    ]);
    expect(await cartRows()).toEqual([]);
    expect(await testDb.db.select().from(notifications)).toEqual([]);
    const [audit] = await testDb.db.select().from(auditEvents);
    expect(audit).toMatchObject({
      action: 'automation_run.create',
      actorUserId: null,
      target: { type: 'automation_run', id: result.runId, mode: 'shadow', proposals: 2 },
    });
  });

  it('Warenkorb: Vorschläge als Änderungen des Zuständigen, mit Benachrichtigung; der nächste Lauf ersetzt sie', async () => {
    await standardMetrics();
    await assignClient();
    await setClient({ mode: 'cart', responsibleUserId: f.emil });
    const first = await save([bid()]);

    expect(first).toMatchObject({ proposals: 1, staged: 1 });
    const [staged] = await cartRows();
    expect(staged).toMatchObject({
      origin: 'automation',
      createdBy: f.emil,
      field: 'bid',
      oldAmount: '0.50',
      newAmount: '0.40',
      currencyCode: 'EUR',
    });
    expect(await proposalRows()).toMatchObject([{ status: 'staged', adChangeId: staged!.id }]);
    expect(await testDb.db.select().from(notifications)).toMatchObject([
      {
        kind: 'automation_proposals',
        audience: 'recipient',
        recipientUserId: f.emil,
        profileId: f.profile,
        params: { count: 1 },
        link: '/ads/changes',
      },
    ]);

    await changeRules(1);
    await save([bid({ after: '0.45' })]);
    expect(await cartRows()).toMatchObject([{ newAmount: '0.45', createdBy: f.emil }]);
    expect((await proposalRows()).map((x) => [x.status, x.newAmount])).toEqual([
      ['superseded', '0.40'],
      ['staged', '0.45'],
    ]);
  });

  it('meldet den Admins, wenn der Zuständige fehlt, und legt dann nichts in den Warenkorb', async () => {
    await standardMetrics();
    await assignClient();
    await setClient({ mode: 'cart', responsibleUserId: null });
    await save([bid()]);

    expect(await cartRows()).toEqual([]);
    expect(await proposalRows()).toMatchObject([{ status: 'open' }]);
    expect(await testDb.db.select().from(notifications)).toMatchObject([
      { kind: 'automation_responsible_missing', audience: 'admins', severity: 'warning' },
    ]);
    const [run] = await testDb.db.select().from(automationRuns);
    expect(run!.warnings).toEqual(['responsibleMissing']);
  });

  it('Verworfenes kommt erst mit neuen Kennzahlen wieder, auch wenn es im Warenkorb verworfen wurde', async () => {
    await standardMetrics();
    await assignClient();
    await setClient({ mode: 'cart', responsibleUserId: f.emil });
    await save([bid(), bid({ entityId: f.productTarget, before: '0.40', after: '0.30' })]);
    // Emil wirft den einen Vorschlag aus dem Warenkorb, den anderen verwirft er in der Liste (5.8).
    const [first, second] = await cartRows();
    await testDb.db.delete(adChanges).where(eq(adChanges.id, first!.id));
    await testDb.db.delete(adChanges).where(eq(adChanges.id, second!.id));
    await testDb.db
      .update(automationProposals)
      .set({ status: 'dismissed' })
      .where(eq(automationProposals.entityId, f.productTarget));

    await changeRules(1);
    const again = await save([bid(), bid({ entityId: f.productTarget })]);
    expect(again).toMatchObject({ proposals: 0, staged: 0, dismissed: 2 });
    expect(await cartRows()).toEqual([]);
    expect((await proposalRows()).map((x) => x.status)).toEqual(['dismissed', 'dismissed']);

    await importMetrics(
      [row('target', '3001', 60, '60.00', '120.00', 5)],
      { startDate: '2026-09-15', endDate: '2026-10-14' },
      new Date('2026-10-15T08:00:00Z'),
    );
    expect(await save([bid()])).toMatchObject({ proposals: 1, staged: 1, dismissed: 0 });
  });

  it('lässt eine schon übermittelte Änderung der Automatik stehen', async () => {
    await standardMetrics();
    await assignClient();
    await setClient({ mode: 'cart', responsibleUserId: f.emil });
    await save([bid()]);
    const [submission] = await testDb.db
      .insert(adChangeSubmissions)
      .values({ organizationId: f.org, profileId: f.profile, channel: 'bulk_file' })
      .returning({ id: adChangeSubmissions.id });
    await testDb.db.update(adChanges).set({ status: 'submitted', submissionId: submission!.id });

    await changeRules(1);
    await save([]);
    expect(await testDb.db.select({ status: adChanges.status }).from(adChanges)).toEqual([
      { status: 'submitted' },
    ]);
    expect((await proposalRows()).map((x) => x.status)).toEqual(['staged']);
  });
});
