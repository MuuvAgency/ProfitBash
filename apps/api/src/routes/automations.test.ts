import {
  planAutomationRun,
  replaceEntityPeriodMetrics,
  saveAutomationRun,
  schema,
  syncAutomationFindings,
  syncStructureProposals,
} from '@profitbash/db';
import { seedAdChangeFixture, type AdChangeFixture } from '@profitbash/db/testing';
import {
  DEFAULT_AUTOMATION_RULES,
  DEFAULT_CHECK_SETTINGS,
  DEFAULT_GUARDRAILS,
  type AutomationChecks,
  type AutomationProposalsResponse,
  type AutomationRulesResponse,
  type AutomationDatasetsResponse,
  type AutomationRunsResponse,
  type AutomationSettings,
  type ErrorResponse,
} from '@profitbash/shared';
import { and, eq } from 'drizzle-orm';
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
  adChanges,
  amazonAdsEntityPeriodMetrics,
  amazonAdsProfiles,
  auditEvents,
  automationProposals,
  automationRuns,
  automationDefaults,
  automationRules,
  clientAutomationSettings,
  clients,
  orgEntitlements,
} = schema;

/**
 * Einstellungen der Automatik über die API (`phase-5.md` 5.4). Je Endpunkt: Recht `write`, Admin für die
 * Startwerte, fremde Organisation, ausgeblendetes Profil, Entitlement.
 */

let ctx: TestContext;
let f: AdChangeFixture;
let other: AdChangeFixture;
let client = '';
let editorId = '';
let admin = '';
let editor = '';
let viewer = '';
let foreign = '';

async function call<T>(method: string, path: string, cookie?: string, json?: unknown) {
  const res = await request(ctx, `/api/ads/automations${path}`, { method, cookie, json });
  return { status: res.status, body: await readJson<T & ErrorResponse>(res) };
}
const settings = (cookie?: string) => call<AutomationSettings>('GET', '/settings', cookie);
const putDefaults = (cookie: string | undefined, guardrails: unknown = DEFAULT_GUARDRAILS) =>
  call<AutomationSettings>('PUT', '/settings/defaults', cookie, guardrails);
const putClient = (cookie: string | undefined, body: Record<string, unknown> = {}, id = client) =>
  call<AutomationSettings>('PUT', `/settings/clients/${id}`, cookie, {
    mode: 'shadow',
    responsibleUserId: null,
    overrides: {},
    ...body,
  });
const hide = (isHidden: boolean) =>
  ctx.testDb.db
    .update(amazonAdsProfiles)
    .set({ isHidden })
    .where(eq(amazonAdsProfiles.id, f.profile));

beforeAll(async () => {
  ctx = await createTestContext();
  const { db } = ctx.testDb;
  const orgId = ctx.seeded.organizationId;
  const editorUser = await createUser(ctx, {
    email: 'editor@muuv.test',
    org: { id: orgId, role: 'editor' },
  });
  editorId = editorUser.id;
  await createUser(ctx, { email: 'viewer@muuv.test', org: { id: orgId, role: 'viewer' } });
  f = await seedAdChangeFixture(db, 'muuv-api', {
    org: orgId,
    ada: ctx.seeded.userId,
    emil: editorUser.id,
  });
  other = await seedAdChangeFixture(db, 'fremd-automatik');
  await db.insert(orgEntitlements).values({ organizationId: other.org, feature: 'automations' });
  await createUser(ctx, { email: 'fremd@andere.test', org: { id: other.org, role: 'admin' } });
  const [kunde] = await db
    .insert(clients)
    .values({ organizationId: orgId, name: 'Kunde', slug: 'kunde-automatik' })
    .returning({ id: clients.id });
  client = kunde!.id;
  await db
    .update(amazonAdsProfiles)
    .set({ clientId: client })
    .where(eq(amazonAdsProfiles.id, f.profile));
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
  viewer = await signIn(ctx, 'viewer@muuv.test');
  foreign = await signIn(ctx, 'fremd@andere.test');
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.testDb.db.delete(clientAutomationSettings);
  await ctx.testDb.db.delete(automationDefaults);
  await ctx.testDb.db.delete(automationRules);
  await hide(false);
});

describe('Einstellungen der Automatik (/api/ads/automations/settings)', () => {
  it('liefert Startwerte, Clients und Mitglieder mit Schreibrecht; auch für Viewer', async () => {
    const res = await settings(viewer);
    expect(res.status).toBe(200);
    expect(res.body.defaults).toEqual(DEFAULT_GUARDRAILS);
    expect(res.body.canEditDefaults).toBe(false);
    expect(res.body.clients).toEqual([
      { id: client, name: 'Kunde', mode: 'shadow', responsibleUserId: null, overrides: {} },
    ]);
    expect(res.body.members.map((m) => m.userId).sort()).toEqual(
      [ctx.seeded.userId, editorId].sort(),
    );
    expect((await settings()).status).toBe(401);
  });

  it('Startwerte der Organisation ändern nur Admins', async () => {
    const guardrails = { ...DEFAULT_GUARDRAILS, maxBidChangePercent: 10, maxBidEur: '2,50' };
    const saved = await putDefaults(admin, guardrails);
    expect(saved.status).toBe(200);
    expect(saved.body.defaults).toMatchObject({ maxBidChangePercent: 10, maxBidEur: '2.50' });
    expect(saved.body.canEditDefaults).toBe(true);

    const denied = await putDefaults(editor);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('AUTOMATION_DEFAULTS_FORBIDDEN');
    expect((await putDefaults(viewer)).status).toBe(403);
    expect((await settings(editor)).body.defaults.maxBidChangePercent).toBe(10);
    // Die andere Organisation behält ihre Startwerte.
    expect((await settings(foreign)).body.defaults).toEqual(DEFAULT_GUARDRAILS);
  });

  it('prüft die Leitplanken', async () => {
    for (const patch of [{ maxBidChangePercent: 0 }, { maxBidEur: '-1' }, { unbekannt: 1 }]) {
      const res = await putDefaults(admin, { ...DEFAULT_GUARDRAILS, ...patch });
      expect(res.status).toBe(400);
    }
  });

  it('Editoren setzen Modus, zuständigen Nutzer und Werte eines Clients; Viewer nicht', async () => {
    const saved = await putClient(editor, { mode: 'cart', overrides: { minClicks: 30 } });
    expect(saved.status).toBe(200);
    expect(saved.body.clients).toEqual([
      {
        id: client,
        name: 'Kunde',
        mode: 'cart',
        responsibleUserId: editorId,
        overrides: { minClicks: 30 },
      },
    ]);
    expect((await putClient(viewer)).status).toBe(403);
    const events = await ctx.testDb.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, ctx.seeded.organizationId),
          eq(auditEvents.action, 'client_automation.update'),
        ),
      );
    expect(events.length).toBeGreaterThan(0);
  });

  it('lehnt zuständige Nutzer ohne Schreibrecht, fremde Clients und ausgeblendete Profile ab', async () => {
    const invalid = await putClient(editor, { mode: 'cart', responsibleUserId: other.ada });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('AUTOMATION_INVALID_RESPONSIBLE');

    const fromOutside = await putClient(foreign);
    expect(fromOutside.status).toBe(404);
    expect(fromOutside.body.error.code).toBe('CLIENT_NOT_FOUND');

    await hide(true);
    expect((await putClient(editor)).status).toBe(404);
    expect((await settings(editor)).body.clients).toEqual([]);
    expect(await ctx.testDb.db.select().from(clientAutomationSettings)).toHaveLength(0);
  });

  it('braucht das Feature automations', async () => {
    const where = and(
      eq(orgEntitlements.organizationId, ctx.seeded.organizationId),
      eq(orgEntitlements.feature, 'automations'),
    );
    await ctx.testDb.db.delete(orgEntitlements).where(where);
    try {
      expect((await settings(admin)).status).toBe(403);
      expect((await putDefaults(admin)).status).toBe(403);
      expect((await putClient(admin)).status).toBe(403);
    } finally {
      await ctx.testDb.db
        .insert(orgEntitlements)
        .values({ organizationId: ctx.seeded.organizationId, feature: 'automations' });
    }
  });
});

describe('Regeln der Automatik (/api/ads/automations/rules)', () => {
  const rules = (cookie?: string) => call<AutomationRulesResponse>('GET', '/rules', cookie);
  const putRules = (cookie: string | undefined, list: unknown, version = 0) =>
    call<AutomationRulesResponse>('PUT', '/rules', cookie, { rules: list, version });
  const own = { ...DEFAULT_AUTOMATION_RULES[0]!, name: 'Eigene Regel' };

  it('liefert die Startregeln; Editoren speichern, Viewer lesen nur', async () => {
    const initial = await rules(viewer);
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({ rules: DEFAULT_AUTOMATION_RULES, version: 0, updatedAt: null });

    const saved = await putRules(editor, [{ ...own, clientId: client }]);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ version: 1, rules: [{ name: 'Eigene Regel' }] });
    expect(typeof saved.body.updatedAt).toBe('string');
    expect((await putRules(viewer, [], 1)).status).toBe(403);
    expect((await rules()).status).toBe(401);
    // Die andere Organisation sieht ihre eigenen (Start-)Regeln.
    expect((await rules(foreign)).body.version).toBe(0);
  });

  it('meldet veraltete Versionen, fremde Clients und ungültige Regeln', async () => {
    await putRules(admin, [own]);
    const stale = await putRules(editor, [], 0);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('AUTOMATION_RULES_VERSION_CONFLICT');

    const fromOutside = await putRules(foreign, [{ ...own, clientId: client }]);
    expect(fromOutside.status).toBe(400);
    expect(fromOutside.body.error.code).toBe('AUTOMATION_RULES_UNKNOWN_CLIENT');

    expect((await putRules(admin, [{ ...own, conditions: [] }], 1)).status).toBe(400);
    expect((await putRules(admin, [{ ...own, level: 'campaign' }], 1)).status).toBe(400);
  });

  it('Vorschau: zählt je Regel, speichert nichts und braucht nur „view“', async () => {
    const res = await call<{ counts: { ruleId: string; entities: number }[] }>(
      'POST',
      '/rules/preview',
      viewer,
      { rules: [own] },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      counts: [{ ruleId: own.id, entities: 0 }],
      targets: 0,
      campaigns: 0,
    });
    expect(await ctx.testDb.db.select().from(automationRules)).toHaveLength(0);
    expect(
      (await call('POST', '/rules/preview', viewer, { rules: [{ ...own, name: '' }] })).status,
    ).toBe(400);
    expect((await call('POST', '/rules/preview', undefined, { rules: [] })).status).toBe(401);
  });
});

describe('Läufe und Vorschläge (/api/ads/automations/runs, /proposals)', () => {
  const NOW = new Date('2026-10-10T08:00:00Z');
  const proposals = (cookie?: string, status = 'open') =>
    call<AutomationProposalsResponse>('GET', `/proposals?status=${status}`, cookie);
  const act = (action: 'stage' | 'dismiss', cookie: string | undefined, ids: string[]) =>
    call<{ changed: number; skipped: number }>('POST', `/proposals/${action}`, cookie, { ids });

  beforeEach(async () => {
    const { db } = ctx.testDb;
    await db.delete(automationProposals);
    await db.delete(automationRuns);
    await db.delete(adChanges);
    await db.delete(amazonAdsEntityPeriodMetrics);
    const scope = { organizationId: f.org, profileId: f.profile };
    await replaceEntityPeriodMetrics(db, {
      ...scope,
      adProduct: 'SPONSORED_PRODUCTS',
      period: { startDate: '2026-09-08', endDate: '2026-10-07' },
      currencyCode: 'EUR',
      rows: [
        {
          level: 'target',
          amazonCampaignId: '1001',
          amazonEntityId: '3001',
          impressions: 4000,
          clicks: 40,
          cost: '12.00',
          sales: '0',
          purchases: 0,
          units: 0,
        },
      ],
      replace: 'period',
      now: NOW,
    });
    const plan = await planAutomationRun(db, scope);
    if (plan.skip !== null) throw new Error(plan.skip);
    await saveAutomationRun(db, {
      ...scope,
      plan,
      jobRunId: null,
      counts: { targets: 1, campaigns: 0 },
      proposals: [
        {
          entityType: 'target',
          entityId: f.keyword,
          campaignId: f.campaign,
          adGroupId: f.adGroup,
          field: 'bid',
          before: '0.50',
          after: '0.40',
          source: 'rule',
          ruleId: DEFAULT_AUTOMATION_RULES[0]!.id,
          limitedBy: [],
          detail: { clicks: 40, orders: 0, spend: '12.00', sales: '0', goalAcos: null },
        },
      ],
    });
  });

  it('liefert je sichtbarem Profil die Datensätze der Automatik, auch für Viewer', async () => {
    const response = await call<AutomationDatasetsResponse>('GET', '/datasets', viewer);
    expect(response.status).toBe(200);
    expect(response.body.profiles.find((x) => x.profileId === f.profile)).toMatchObject({
      accountName: 'Nordwind DE',
      expectedAdProducts: ['SPONSORED_PRODUCTS'],
      metrics: {
        periodStart: '2026-09-08',
        periodEnd: '2026-10-07',
        periodDays: 30,
        importedAt: NOW.toISOString(),
        adProducts: ['SPONSORED_PRODUCTS'],
        searchTermAdProducts: [],
      },
    });
    expect(response.body.profiles.map((x) => x.profileId)).not.toContain(other.profile);
    expect((await call('GET', '/datasets')).status).toBe(401);
  });

  it('liefert Läufe und Vorschläge der sichtbaren Profile, auch für Viewer', async () => {
    const runs = await call<AutomationRunsResponse>('GET', '/runs', viewer);
    expect(runs.status).toBe(200);
    expect(runs.body.runs).toMatchObject([
      {
        profileId: f.profile,
        accountName: 'Nordwind DE',
        mode: 'shadow',
        periodStart: '2026-09-08',
        periodEnd: '2026-10-07',
        metricsImportedAt: NOW.toISOString(),
        counts: { targets: 1, proposals: 1 },
        warnings: [],
      },
    ]);
    const list = await proposals(viewer);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      total: 1,
      proposals: [
        {
          entityType: 'target',
          campaignName: 'Kampagne 1001',
          adGroupName: 'AG 2001',
          target: { keywordText: 'kw 3001' },
          field: 'bid',
          before: '0.50',
          after: '0.40',
          currencyCode: 'EUR',
          source: 'rule',
          ruleName: 'Viele Klicks ohne Bestellung',
          limitedBy: [],
          detail: { clicks: 40, spend: '12.00' },
          status: 'open',
        },
      ],
    });
    expect((await proposals(viewer, 'staged')).body.proposals).toEqual([]);
    expect((await proposals(viewer, 'unbekannt')).status).toBe(400);
  });

  it('zeigt fremden Organisationen und bei ausgeblendetem Profil nichts; ohne Anmeldung 401', async () => {
    expect((await call<AutomationRunsResponse>('GET', '/runs', foreign)).body.runs).toEqual([]);
    expect((await proposals(foreign)).body).toEqual({ proposals: [], total: 0 });
    const { id } = (await proposals(editor)).body.proposals[0]!;
    await hide(true);
    expect((await call<AutomationRunsResponse>('GET', '/runs', editor)).body.runs).toEqual([]);
    expect((await proposals(editor)).body.total).toBe(0);
    const datasets = await call<AutomationDatasetsResponse>('GET', '/datasets', editor);
    expect(datasets.body.profiles.map((x) => x.profileId)).not.toContain(f.profile);
    for (const action of ['stage', 'dismiss'] as const) {
      expect((await act(action, editor, [id])).body).toEqual({ changed: 0, skipped: 1 });
    }
    expect((await call('GET', '/runs')).status).toBe(401);
    expect((await proposals()).status).toBe(401);
  });

  it('Editoren übernehmen in den eigenen Warenkorb und verwerfen; Viewer und Fremde nicht', async () => {
    const { id } = (await proposals(editor)).body.proposals[0]!;
    expect((await act('stage', viewer, [id])).status).toBe(403);
    expect((await act('stage', undefined, [id])).status).toBe(401);
    expect((await act('stage', foreign, [id])).body).toEqual({ changed: 0, skipped: 1 });
    expect((await act('stage', editor, [])).status).toBe(400);

    await ctx.testDb.db.delete(auditEvents);
    expect((await act('stage', editor, [id])).body).toEqual({ changed: 1, skipped: 0 });
    expect(await ctx.testDb.db.select().from(adChanges)).toMatchObject([
      { origin: 'automation', createdBy: editorId, status: 'pending', newAmount: '0.40' },
    ]);
    expect((await proposals(editor, 'staged')).body.total).toBe(1);

    expect((await act('dismiss', viewer, [id])).status).toBe(403);
    expect((await act('dismiss', foreign, [id])).body).toEqual({ changed: 0, skipped: 1 });
    expect((await act('dismiss', admin, [id])).body).toEqual({ changed: 1, skipped: 0 });
    expect(await ctx.testDb.db.select().from(adChanges)).toEqual([]);
    expect((await proposals(editor, 'dismissed')).body.total).toBe(1);
    expect(
      (await ctx.testDb.db.select({ action: auditEvents.action }).from(auditEvents)).map(
        (event) => event.action,
      ),
    ).toEqual(['automation_proposals.stage', 'automation_proposals.dismiss']);
  });
});

describe('Prüfungen (/api/ads/automations/checks)', () => {
  const checks = (cookie?: string, status?: string) =>
    call<AutomationChecks>('GET', `/checks${status ? `?status=${status}` : ''}`, cookie);
  const acknowledge = (cookie: string | undefined, ids: string[]) =>
    call<{ changed: number; skipped: number }>('POST', '/checks/acknowledge', cookie, { ids });
  const putSettings = (cookie: string | undefined, body: unknown = DEFAULT_CHECK_SETTINGS) =>
    call<AutomationChecks>('PUT', '/checks/settings', cookie, body);

  beforeEach(async () => {
    const { db } = ctx.testDb;
    await db.delete(schema.automationFindings);
    await db.delete(schema.automationCheckSettings);
    await hide(false);
    await syncAutomationFindings(db, {
      organizationId: f.org,
      profileId: f.profile,
      now: new Date('2026-10-10T08:00:00Z'),
      findings: [
        {
          kind: 'spendNoOrders',
          entityType: 'target',
          entityId: f.keyword,
          campaignId: f.campaign,
          key: '',
          detail: { spend: '40', clicks: 80 },
        },
      ],
    });
  });

  it('liefert Einstellungen und Befunde der sichtbaren Profile, auch für Viewer', async () => {
    const res = await checks(viewer);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      settings: DEFAULT_CHECK_SETTINGS,
      canEditSettings: false,
      total: 1,
      findings: [
        {
          kind: 'spendNoOrders',
          severity: 'warning',
          profileId: f.profile,
          campaignName: 'Kampagne 1001',
          detail: { spend: '40' },
          firstSeenAt: '2026-10-10T08:00:00.000Z',
          acknowledgedAt: null,
        },
      ],
    });
    expect((await checks(admin)).body.canEditSettings).toBe(true);
    expect((await checks(viewer, 'acknowledged')).body.findings).toEqual([]);
    expect((await checks(viewer, 'alle')).status).toBe(400);
    expect((await checks(foreign)).body.findings).toEqual([]);
    const { id } = (await checks(editor)).body.findings[0]!;
    await hide(true);
    expect((await checks(editor)).body.total).toBe(0);
    expect((await acknowledge(editor, [id])).body).toEqual({ changed: 0, skipped: 1 });
    expect((await checks()).status).toBe(401);
  });

  it('Editoren quittieren; Viewer und Fremde nicht', async () => {
    const { id } = (await checks(editor)).body.findings[0]!;
    expect((await acknowledge(viewer, [id])).status).toBe(403);
    expect((await acknowledge(undefined, [id])).status).toBe(401);
    expect((await acknowledge(editor, [])).status).toBe(400);
    expect((await acknowledge(foreign, [id])).body).toEqual({ changed: 0, skipped: 1 });

    expect((await acknowledge(editor, [id])).body).toEqual({ changed: 1, skipped: 0 });
    expect((await checks(editor)).body.total).toBe(0);
    expect((await checks(editor, 'acknowledged')).body.findings).toMatchObject([
      { id, acknowledgedAt: expect.any(String) },
    ]);
  });

  it('die Einstellungen ändern nur Admins; ungültige Werte werden abgelehnt', async () => {
    const settings = { ...DEFAULT_CHECK_SETTINGS, spendNoOrdersMinEur: '35,50' };
    const denied = await putSettings(editor, settings);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('AUTOMATION_DEFAULTS_FORBIDDEN');
    expect((await putSettings(viewer, settings)).status).toBe(403);

    const saved = await putSettings(admin, settings);
    expect(saved.status).toBe(200);
    expect(saved.body.settings.spendNoOrdersMinEur).toBe('35.50');
    expect((await checks(viewer)).body.settings.spendNoOrdersMinEur).toBe('35.50');
    expect((await checks(foreign)).body.settings).toEqual(DEFAULT_CHECK_SETTINGS);

    expect((await putSettings(admin, { ...settings, placementMinPercent: 0 })).status).toBe(400);
    expect((await putSettings(admin, { ...settings, spendNoOrdersMinEur: '0' })).status).toBe(400);
    expect((await putSettings(admin, { placementMinPercent: 50 })).status).toBe(400);
  });
});

describe('Graduation- und Preset-Vorschläge (/api/ads/automations/structure-proposals)', () => {
  type List = {
    total: number;
    proposals: { id: string; kind: string; subject: string; dismissedAt: string | null }[];
  };
  const list = (cookie?: string, status?: string) =>
    call<List>('GET', `/structure-proposals${status ? `?status=${status}` : ''}`, cookie);
  const act = (action: 'accept' | 'dismiss', cookie: string | undefined, ids: string[]) =>
    call<{ changed: number; skipped: number }>('POST', `/structure-proposals/${action}`, cookie, {
      ids,
    });
  const PERIOD = { periodStart: '2026-09-08', periodEnd: '2026-10-07' };

  beforeEach(async () => {
    const { db } = ctx.testDb;
    await db.delete(schema.automationStructureProposals);
    await db.delete(schema.searchTermHarvestMarks);
    await db.delete(schema.amazonAdsSearchTermPeriodMetrics);
    await hide(false);
    await db.insert(schema.amazonAdsSearchTermPeriodMetrics).values({
      organizationId: f.org,
      profileId: f.profile,
      adProduct: 'SPONSORED_PRODUCTS',
      ...PERIOD,
      amazonCampaignId: '1001',
      amazonAdGroupId: '2001',
      amazonTargetId: '3001',
      searchTerm: 'trinkflasche 1l',
      currencyCode: 'EUR',
      impressions: 500,
      clicks: 40,
      cost: '10.00',
      sales: '100.00',
      purchases: 3,
      units: 3,
      importedAt: new Date('2026-10-10T08:00:00Z'),
    });
    await syncStructureProposals(db, {
      organizationId: f.org,
      profileId: f.profile,
      now: new Date('2026-10-10T08:00:00Z'),
      proposals: [
        {
          kind: 'graduation',
          subject: 'trinkflasche 1l',
          key: 'SP-AUTO',
          detail: {
            searchTerm: 'trinkflasche 1l',
            toBlocks: ['SP-KW-EXACT'],
            orders: 3,
            ...PERIOD,
          },
        },
      ],
    });
  });

  it('liefert die Vorschläge der sichtbaren Profile, auch für Viewer', async () => {
    const res = await list(viewer);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 1,
      proposals: [
        {
          kind: 'graduation',
          subject: 'trinkflasche 1l',
          key: 'SP-AUTO',
          profileId: f.profile,
          accountName: 'Nordwind DE',
          detail: { orders: 3 },
          firstSeenAt: '2026-10-10T08:00:00.000Z',
          dismissedAt: null,
        },
      ],
    });
    expect((await list(viewer, 'dismissed')).body.proposals).toEqual([]);
    expect((await list(viewer, 'alle')).status).toBe(400);
    expect((await list(foreign)).body.proposals).toEqual([]);
    const { id } = (await list(editor)).body.proposals[0]!;
    await hide(true);
    expect((await list(editor)).body.total).toBe(0);
    for (const action of ['accept', 'dismiss'] as const) {
      expect((await act(action, editor, [id])).body).toEqual({ changed: 0, skipped: 1 });
    }
    expect((await list()).status).toBe(401);
  });

  it('Editoren verwerfen und nehmen an (Merkliste); Viewer und Fremde nicht', async () => {
    const { id } = (await list(editor)).body.proposals[0]!;
    for (const action of ['accept', 'dismiss'] as const) {
      expect((await act(action, viewer, [id])).status).toBe(403);
      expect((await act(action, undefined, [id])).status).toBe(401);
      expect((await act(action, editor, [])).status).toBe(400);
      expect((await act(action, foreign, [id])).body).toEqual({ changed: 0, skipped: 1 });
    }
    expect((await act('accept', editor, [id])).body).toEqual({ changed: 1, skipped: 0 });
    expect((await list(editor)).body.total).toBe(0);
    expect(await ctx.testDb.db.select().from(schema.searchTermHarvestMarks)).toMatchObject([
      { termKey: 'trinkflasche 1l', profileId: f.profile },
    ]);
  });
});
