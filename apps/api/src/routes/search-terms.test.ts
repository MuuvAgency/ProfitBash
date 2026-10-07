import {
  replaceSearchTermPeriodMetrics,
  schema,
  type SearchTermPeriodMetric,
} from '@profitbash/db';
import {
  clientSchema,
  DEFAULT_SEARCH_TERM_RULES,
  MAX_PROTECTED_TERMS,
  searchTermAnalysisResponseSchema,
  searchTermPeriodsResponseSchema,
  searchTermRulesResponseSchema,
  type Client,
  type ErrorResponse,
  type SearchTermAnalysisResponse,
} from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  type TestContext,
} from '../testing';

const { amazonAdsProfiles, auditEvents, clients, connections, orgEntitlements, searchTermRules } =
  schema;

/**
 * Suchbegriff-Analyse über die API (2b.2): Zeiträume, Analyse eines Datei-Zeitraums mit Einstufung und N-Grammen,
 * Regeln je Organisation, geschützte Begriffe am Client. Je Endpunkt: fremde Organisation, ausgeblendetes Profil,
 * Entitlement.
 */

let ctx: TestContext;
let orgId = '';
let admin = '';
let editor = '';
let viewer = '';
let foreign = '';
const ids = { client: '', visible: '', hidden: '', big: '' };

const A = { periodStart: '2026-08-01', periodEnd: '2026-09-29' };
const SP = 'SPONSORED_PRODUCTS';

type Periods = z.infer<typeof searchTermPeriodsResponseSchema>;
type Rules = z.infer<typeof searchTermRulesResponseSchema>;

async function call<T>(method: string, path: string, cookie?: string, json?: unknown) {
  const res = await request(ctx, `/api${path}`, { method, cookie, json });
  return { status: res.status, body: await readJson<T & ErrorResponse>(res) };
}
const analysis = (cookie: string | undefined, body: Record<string, unknown> = {}) =>
  call<SearchTermAnalysisResponse>('POST', '/ads/search-terms/analysis', cookie, {
    profileId: ids.visible,
    ...A,
    ...body,
  });

const term = (
  searchTerm: string,
  patch: Partial<SearchTermPeriodMetric> = {},
): SearchTermPeriodMetric => ({
  amazonCampaignId: 'C1',
  amazonAdGroupId: 'AG1',
  amazonTargetId: 'T1',
  searchTerm,
  impressions: 1000,
  clicks: 3,
  cost: '1',
  sales: '0',
  purchases: 0,
  units: 0,
  ...patch,
});

async function write(organizationId: string, profileId: string, rows: SearchTermPeriodMetric[]) {
  await replaceSearchTermPeriodMetrics(ctx.testDb.db, {
    organizationId,
    profileId,
    adProduct: SP,
    period: { startDate: A.periodStart, endDate: A.periodEnd },
    currencyCode: 'EUR',
    rows,
    replace: 'period',
    now: new Date('2026-10-01T08:00:00Z'),
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  orgId = ctx.seeded.organizationId;
  const { db } = ctx.testDb;
  await createUser(ctx, { email: 'editor@muuv.test', org: { id: orgId, role: 'editor' } });
  await createUser(ctx, { email: 'viewer@muuv.test', org: { id: orgId, role: 'viewer' } });
  const [other] = await db
    .insert(schema.organizations)
    .values({ name: 'Fremd', slug: 'fremd-suchbegriffe', type: 'internal', createdAt: new Date() })
    .returning({ id: schema.organizations.id });
  await db.insert(orgEntitlements).values({ organizationId: other!.id, feature: 'sp-explorer' });
  await createUser(ctx, { email: 'fremd@andere.test', org: { id: other!.id, role: 'admin' } });
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
  viewer = await signIn(ctx, 'viewer@muuv.test');
  foreign = await signIn(ctx, 'fremd@andere.test');

  const [client] = await db
    .insert(clients)
    .values({ organizationId: orgId, name: 'Nordwind', slug: 'nordwind' })
    .returning({ id: clients.id });
  ids.client = client!.id;
  const [connection] = await db
    .insert(connections)
    .values({
      organizationId: orgId,
      provider: 'amazon_ads',
      region: 'eu',
      externalAccountId: 'amzn1.account.MUUV',
      refreshTokenEncrypted: 'v1:k1:nicht-benutzt',
    })
    .returning({ id: connections.id });
  const profile = (amazonProfileId: string, patch: Record<string, unknown> = {}) => ({
    organizationId: orgId,
    connectionId: connection!.id,
    amazonProfileId,
    accountName: `Konto ${amazonProfileId}`,
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    accountType: 'seller',
    ...patch,
  });
  const [visible, hidden, big] = await db
    .insert(amazonAdsProfiles)
    .values([
      profile('1', { clientId: ids.client }),
      profile('2', { isHidden: true }),
      profile('3'),
    ])
    .returning({ id: amazonAdsProfiles.id });
  ids.visible = visible!.id;
  ids.hidden = hidden!.id;
  ids.big = big!.id;

  await write(orgId, ids.visible, [
    term('led lampe', { clicks: 40, cost: '20', sales: '100', purchases: 4, units: 5 }),
    term('lampe billig', { clicks: 30, cost: '25' }),
    term('Nordwind Lampe', { clicks: 30, cost: '26' }),
    term('lampe rot'),
  ]);
  await write(orgId, ids.hidden, [term('versteckt', { cost: '777' })]);
});

afterAll(async () => {
  await ctx?.close();
});

describe('geschützte Begriffe am Client (PATCH /api/clients/{id})', () => {
  it('speichert sie normalisiert, mit Audit-Event, und liefert sie in der Liste', async () => {
    const res = await call<Client>('PATCH', `/clients/${ids.client}`, admin, {
      protectedTerms: ['  Nordwind ', 'nordwind', 'Hero  Lampe'],
    });
    expect(res.status).toBe(200);
    expect(clientSchema.safeParse(res.body).error).toBeUndefined();
    expect(res.body.protectedTerms).toEqual(['hero lampe', 'nordwind']);

    const list = await call<{ clients: Client[] }>('GET', '/clients', admin);
    expect(list.body.clients.find((c) => c.id === ids.client)?.protectedTerms).toEqual([
      'hero lampe',
      'nordwind',
    ]);
    const events = await ctx.testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'client.update'));
    expect(events.at(-1)?.target).toMatchObject({
      id: ids.client,
      before: { protectedTerms: [] },
      after: { protectedTerms: ['hero lampe', 'nordwind'] },
    });
  });

  it('lässt Name und Slug stehen und lehnt zu viele Begriffe und Nicht-Admins ab', async () => {
    const list = await call<{ clients: Client[] }>('GET', '/clients', admin);
    expect(list.body.clients.find((c) => c.id === ids.client)).toMatchObject({
      name: 'Nordwind',
      slug: 'nordwind',
    });
    const tooMany = await call('PATCH', `/clients/${ids.client}`, admin, {
      protectedTerms: Array.from({ length: MAX_PROTECTED_TERMS + 1 }, (_, i) => `t${i}`),
    });
    expect(tooMany.status).toBe(400);
    const asEditor = await call('PATCH', `/clients/${ids.client}`, editor, {
      protectedTerms: ['x'],
    });
    expect(asEditor.status).toBe(403);
  });
});

describe('POST /api/ads/search-terms/periods', () => {
  it('nennt die Datei-Zeiträume sichtbarer Profile (alle Rollen), nie ausgeblendete', async () => {
    for (const cookie of [admin, viewer]) {
      const res = await call<Periods>('POST', '/ads/search-terms/periods', cookie, {});
      expect(res.status).toBe(200);
      expect(searchTermPeriodsResponseSchema.safeParse(res.body).error).toBeUndefined();
      expect(res.body.periods).toEqual([
        {
          profileId: ids.visible,
          accountName: 'Konto 1',
          countryCode: 'DE',
          currencyCode: 'EUR',
          clientId: ids.client,
          ...A,
          adProducts: [SP],
          rows: 4,
          importedAt: '2026-10-01T08:00:00.000Z',
        },
      ]);
    }
  });

  it('zeigt einer fremden Organisation nichts', async () => {
    const res = await call<Periods>('POST', '/ads/search-terms/periods', foreign, {});
    expect(res.status).toBe(200);
    expect(res.body.periods).toEqual([]);
  });
});

describe('POST /api/ads/search-terms/analysis', () => {
  it('stuft die Zeilen nach den Regeln ein und schützt die Begriffe des Clients', async () => {
    const res = await analysis(viewer);
    expect(res.status).toBe(200);
    expect(searchTermAnalysisResponseSchema.safeParse(res.body).error).toBeUndefined();
    expect(
      res.body.rows.map((r) => [r.searchTerm, r.classification, r.reason, r.protected]),
    ).toEqual([
      ['Nordwind Lampe', 'watch', 'protected', true],
      ['lampe billig', 'negate', null, false],
      ['led lampe', 'harvest', null, false],
      ['lampe rot', 'watch', 'tooFewData', false],
    ]);
    expect(res.body.counts).toEqual({ harvest: 1, negate: 1, watch: 2 });
    expect(res.body.meta).toMatchObject({
      profileId: ids.visible,
      accountName: 'Konto 1',
      currency: 'EUR',
      clientId: ids.client,
      ...A,
      importedAt: '2026-10-01T08:00:00.000Z',
      rules: DEFAULT_SEARCH_TERM_RULES,
      rulesAreDefault: true,
      protectedTerms: ['hero lampe', 'nordwind'],
      totalRows: 4,
      truncated: false,
      ngramsTruncated: false,
    });
  });

  it('rechnet Summen und abgeleitete Kennzahlen exakt (Zeile, Summe, N-Gramm)', async () => {
    const { body } = await analysis(viewer);
    expect(body.rows.find((r) => r.searchTerm === 'led lampe')).toMatchObject({
      impressions: '1000',
      clicks: '40',
      cost: '20',
      sales: '100',
      purchases: '4',
      units: '5',
      ctr: '0.04',
      cpc: '0.5',
      cvr: '0.1',
      acos: '0.2',
      roas: '5',
    });
    expect(body.total).toMatchObject({
      impressions: '4000',
      clicks: '103',
      cost: '72',
      sales: '100',
      purchases: '4',
      acos: '0.72',
    });
    expect(body.ngrams[0]).toMatchObject({
      size: 1,
      gram: 'lampe',
      searchTerms: 4,
      cost: '72',
      sales: '100',
      acos: '0.72',
    });
    expect(body.ngrams.find((n) => n.gram === 'nordwind lampe')).toMatchObject({
      size: 2,
      searchTerms: 1,
      cost: '26',
      acos: null,
    });
    expect(body.meta.totalNgrams).toBe(body.ngrams.length);
  });

  it('liefert für einen Zeitraum ohne Daten eine leere Analyse', async () => {
    const res = await analysis(viewer, { periodStart: '2026-01-01', periodEnd: '2026-01-31' });
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.ngrams).toEqual([]);
    expect(res.body.total).toMatchObject({ cost: '0', acos: null });
    expect(res.body.meta.importedAt).toBeNull();
  });

  it('kürzt Zeilen und N-Gramme, Summe und Zähler gelten für alle Zeilen', async () => {
    const rows = Array.from({ length: 10_001 }, (_, i) =>
      term(`w${i} lampe`, { amazonTargetId: `T${i}`, cost: i === 0 ? '5' : '1' }),
    );
    await write(orgId, ids.big, rows);
    const { body } = await analysis(viewer, { profileId: ids.big });
    expect(body.meta).toMatchObject({
      totalRows: 10_001,
      truncated: true,
      maxRows: 10_000,
      ngramsTruncated: true,
      maxNgrams: 5_000,
      totalNgrams: 20_003,
      protectedTerms: [],
    });
    expect(body.rows).toHaveLength(10_000);
    expect(body.rows[0]?.searchTerm).toBe('w0 lampe');
    expect(body.ngrams).toHaveLength(5_000);
    expect(body.ngrams[0]).toMatchObject({ gram: 'lampe', searchTerms: 10_001, cost: '10005' });
    expect(body.total.cost).toBe('10005');
    expect(body.counts).toEqual({ harvest: 0, negate: 0, watch: 10_001 });
  });

  it('verweigert ausgeblendete Profile (auch Admins) und fremde Organisationen mit 404', async () => {
    for (const [cookie, profileId] of [
      [viewer, ids.hidden],
      [admin, ids.hidden],
      [foreign, ids.visible],
    ] as const) {
      const res = await analysis(cookie, { profileId });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PROFILE_NOT_FOUND');
      expect(JSON.stringify(res.body)).not.toContain('versteckt');
    }
  });

  it('prüft die Eingabe', async () => {
    const res = await analysis(viewer, { periodStart: '2026-10-01' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Regeln (GET/PUT /api/ads/search-terms/rules)', () => {
  it('liefert die Startwerte; Viewer dürfen lesen, aber nicht ändern', async () => {
    const res = await call<Rules>('GET', '/ads/search-terms/rules', viewer);
    expect(res.status).toBe(200);
    expect(searchTermRulesResponseSchema.safeParse(res.body).error).toBeUndefined();
    expect(res.body).toEqual({
      rules: DEFAULT_SEARCH_TERM_RULES,
      isDefault: true,
      updatedAt: null,
    });
    const put = await call('PUT', '/ads/search-terms/rules', viewer, DEFAULT_SEARCH_TERM_RULES);
    expect(put.status).toBe(403);
    expect(put.body.error.code).toBe('FEATURE_FORBIDDEN');
  });

  it('lehnt ungültige Regeln ab', async () => {
    const res = await call('PUT', '/ads/search-terms/rules', editor, {
      ...DEFAULT_SEARCH_TERM_RULES,
      harvestMaxAcos: '0',
    });
    expect(res.status).toBe(400);
    expect(await ctx.testDb.db.select().from(searchTermRules)).toEqual([]);
  });

  it('Editoren ändern die Regeln; die Analyse stuft danach neu ein', async () => {
    const rules = {
      harvestMinPurchases: 5,
      harvestMaxAcos: '0.25',
      negateMinClicks: 3,
      negateMinCost: '1',
    };
    const put = await call<Rules>('PUT', '/ads/search-terms/rules', editor, rules);
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ rules, isDefault: false });
    expect(put.body.updatedAt).toEqual(expect.any(String));

    const { body } = await analysis(viewer);
    expect(body.meta).toMatchObject({ rules, rulesAreDefault: false });
    expect(Object.fromEntries(body.rows.map((r) => [r.searchTerm, r.classification]))).toEqual({
      'Nordwind Lampe': 'watch',
      'lampe billig': 'negate',
      'led lampe': 'watch',
      'lampe rot': 'negate',
    });
    // Die fremde Organisation behält ihre Startwerte.
    const other = await call<Rules>('GET', '/ads/search-terms/rules', foreign);
    expect(other.body.isDefault).toBe(true);
  });
});

describe('Rechte je Endpunkt', () => {
  const endpoints = (): [string, string, unknown][] => [
    ['POST', '/ads/search-terms/periods', {}],
    ['POST', '/ads/search-terms/analysis', { profileId: ids.visible, ...A }],
    ['GET', '/ads/search-terms/rules', undefined],
    ['PUT', '/ads/search-terms/rules', DEFAULT_SEARCH_TERM_RULES],
  ];

  it('verlangt eine Session', async () => {
    for (const [method, path, body] of endpoints()) {
      const res = await call(method, path, undefined, body);
      expect(res.status, path).toBe(401);
    }
  });

  it('verlangt das Feature „sp-explorer“', async () => {
    const set = (enabled: boolean) =>
      ctx.testDb.db
        .update(orgEntitlements)
        .set({ enabled })
        .where(eq(orgEntitlements.organizationId, orgId));
    await set(false);
    try {
      for (const [method, path, body] of endpoints()) {
        const res = await call(method, path, admin, body);
        expect(res.status, path).toBe(403);
        expect(res.body.error.code, path).toBe('FEATURE_FORBIDDEN');
      }
    } finally {
      await set(true);
    }
  });
});
