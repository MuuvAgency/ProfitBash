import { setupServer } from 'msw/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RefreshTokenStore } from './access-token';
import type { AmazonAdsClient } from './client';
import { applyCreates, type AmazonAdsCreateOperation } from './creates';
import { decodeGzipJson } from './download';
import { noopLogger } from './logger';
import {
  AmazonAdsDuplicateReportError,
  AmazonAdsHttpError,
  AmazonAdsReauthRequiredError,
} from './errors';
import {
  createExportRowSchema,
  type AmazonAdsExportRows,
  type AmazonAdsExportType,
} from './exports';
import {
  createMockAmazonAdsClient,
  type MockAmazonAdsSimulation,
  MOCK_AMAZON_ADS_AUTHORIZATION_CODE,
  MOCK_AMAZON_ADS_IDENTITY,
  renderMockConsentPage,
} from './mock';
import {
  createReportRowSchema,
  REPORT_DEFINITIONS,
  type AmazonAdsReportRows,
  type AmazonAdsReportType,
} from './reports';

// Ohne Handler: Jeder echte Netzwerkaufruf würde den Test scheitern lassen.
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const REDIRECT_URI = 'http://localhost:5173/api/amazon/oauth/callback';
const CONSENT_URL = 'http://localhost:5173/api/amazon/mock/consent';
const connection = { id: 'conn-1', organizationId: 'org-1', region: 'eu' as const };

function storeWith(refreshToken: string): RefreshTokenStore {
  return {
    async withRefreshToken(_id, refresh) {
      return (await refresh(refreshToken)).result;
    },
  };
}

function setup(refreshToken = 'unused') {
  return createMockAmazonAdsClient({
    redirectUri: REDIRECT_URI,
    consentUrl: CONSENT_URL,
    store: storeWith(refreshToken),
  });
}

describe('Mock-Anbieter', () => {
  it('leitet die Einwilligung auf die simulierte Seite statt zu Amazon', () => {
    const url = new URL(setup().buildAuthorizeUrl({ region: 'eu', state: 'abc' }));
    expect(`${url.origin}${url.pathname}`).toBe(CONSENT_URL);
    expect(url.searchParams.get('state')).toBe('abc');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
  });

  it('spielt den kompletten Ablauf durch: Code tauschen, Identität, Profile', async () => {
    const client = setup();
    const tokens = await client.exchangeCode({
      region: 'eu',
      code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE,
    });
    expect(tokens.refreshToken).toMatch(/^Atzr\|mock-/);
    expect(tokens.accessToken).toMatch(/^Atza\|mock-/);

    const identity = await client.getAccountIdentity({
      region: 'eu',
      accessToken: tokens.accessToken,
    });
    expect(identity).toEqual(MOCK_AMAZON_ADS_IDENTITY);

    const withStoredToken = createMockAmazonAdsClient({
      redirectUri: REDIRECT_URI,
      consentUrl: CONSENT_URL,
      store: storeWith(tokens.refreshToken),
    });
    const profiles = await withStoredToken.listProfiles(connection);
    expect(profiles.length).toBeGreaterThanOrEqual(3);
    expect(new Set(profiles.map((p) => p.accountType))).toEqual(
      new Set(['seller', 'vendor', 'agency']),
    );
    const bigId = profiles.find((p) => p.amazonProfileId === '9007199254740993');
    expect(bigId).toBeDefined();
    expect(BigInt(bigId?.amazonProfileId ?? '0') > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('lehnt einen falschen Code wie Amazon mit invalid_grant ab', async () => {
    const error = await setup()
      .exchangeCode({ region: 'eu', code: 'falsch' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmazonAdsHttpError);
    expect(error).toMatchObject({ status: 400, code: 'invalid_grant' });
  });

  it('meldet einen nicht vom Mock ausgestellten Refresh-Token als Neu-Verbinden-Fall', async () => {
    await expect(setup('Atzr|revoked').listProfiles(connection)).rejects.toBeInstanceOf(
      AmazonAdsReauthRequiredError,
    );
  });

  it('liefert in NA und FE eigene Profile (Region wird respektiert)', async () => {
    const client = setup('Atzr|mock-refresh');
    const na = await client.listProfiles({ id: 'c', organizationId: 'org-1', region: 'na' });
    expect(na.map((p) => p.countryCode)).toEqual(['US']);
    await expect(
      client.listProfiles({ id: 'c', organizationId: 'org-1', region: 'fe' }),
    ).resolves.toEqual([]);
  });
});

describe('renderMockConsentPage', () => {
  it('verlinkt Erlauben und Ablehnen nur auf die konfigurierte Redirect-URI', () => {
    const html = renderMockConsentPage({ redirectUri: REDIRECT_URI, state: 'st-1' });
    const allow = new URL(
      `${REDIRECT_URI}?code=${MOCK_AMAZON_ADS_AUTHORIZATION_CODE}&scope=advertising%3A%3Acampaign_management+profile&state=st-1`,
    );
    expect(html).toContain(allow.toString().replaceAll('&', '&amp;'));
    expect(html).toContain('error=access_denied');
    expect(html).toContain('Mock');
  });

  it('escaped den state (kein HTML aus der Query)', () => {
    const html = renderMockConsentPage({
      redirectUri: REDIRECT_URI,
      state: '"><script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>');
  });
});

describe('Mock-Anbieter: Entities und Reports', () => {
  const DE = '9007199254740993';
  const UK_VENDOR = '2345678901234567';
  const FR = '1234567890123456';
  const SB = 'SPONSORED_BRANDS';
  const SD = 'SPONSORED_DISPLAY';
  const START = Date.parse('2026-09-27T06:00:00Z');

  function simulated(simulation: MockAmazonAdsSimulation = {}) {
    let now = START;
    const client = createMockAmazonAdsClient({
      redirectUri: REDIRECT_URI,
      consentUrl: CONSENT_URL,
      store: storeWith('Atzr|mock-refresh'),
      rateLimit: { requestsPerSecond: 100 },
      simulation: { now: () => now, processingMs: 60_000, ...simulation },
    });
    return {
      client,
      advance(ms: number) {
        now += ms;
      },
    };
  }

  async function download(client: AmazonAdsClient, url: string | null): Promise<unknown[]> {
    expect(url).not.toBeNull();
    const file = await client.downloadFile(url ?? '');
    if (file.status !== 'ok') throw new Error('Datei fehlt');
    return (await decodeGzipJson(file.body, { maxBytes: 10 * 1024 * 1024 })) as unknown[];
  }

  async function exportRows<T extends AmazonAdsExportType>(
    amazonProfileId: string,
    exportType: T,
    adProduct = 'SPONSORED_PRODUCTS',
  ): Promise<AmazonAdsExportRows[T][]> {
    const { client, advance } = simulated();
    const { exportId } = await client.requestExport(connection, {
      amazonProfileId,
      exportType,
      adProduct,
    });
    const ref = { amazonProfileId, exportType, exportId };
    await expect(client.getExport(connection, ref)).resolves.toEqual({ status: 'PROCESSING' });
    advance(60_000);
    const state = await client.getExport(connection, ref);
    expect(state.status).toBe('COMPLETED');
    const rows = await download(client, state.status === 'COMPLETED' ? state.url : null);
    const schema = createExportRowSchema(exportType, { adProduct, logger: () => {} });
    return rows.map((row) => schema.parse(row));
  }

  it('liefert Portfolios mit exakten Beträgen über mehrere Seiten', async () => {
    const { client } = simulated();
    const portfolios = await client.listPortfolios(connection, DE);
    expect(portfolios.length).toBeGreaterThanOrEqual(3);
    expect(portfolios.map((p) => p.budgetAmount)).toContain('1234.56789012345678');
  });

  it('exportiert Kampagnen mit großen IDs, exakten Budgets und einer archivierten Kampagne', async () => {
    const campaigns = await exportRows(DE, 'campaigns');
    expect(campaigns.map((c) => c.state)).toEqual(
      expect.arrayContaining(['ENABLED', 'PAUSED', 'ARCHIVED']),
    );
    for (const campaign of campaigns) {
      expect(BigInt(campaign.amazonCampaignId) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
      expect(campaign.budgetCurrencyCode).toBe('EUR');
    }
    expect(campaigns.map((c) => c.budgetAmount)).toContain('10.005');
  });

  it('exportiert Negatives auf Kampagnen- und Ad-Group-Ebene', async () => {
    const targets = await exportRows(DE, 'targets');
    const levels = targets.flatMap((t) => (t.kind === 'negative' ? [t.target.level] : []));
    expect(new Set(levels)).toEqual(new Set(['campaign', 'ad_group']));
    expect(targets.some((t) => t.kind === 'target' && t.target.targetType === 'auto')).toBe(true);
  });

  it('exportiert Product Ads mit SKU für Seller, ohne SKU für Vendoren', async () => {
    const sellerAds = await exportRows(DE, 'ads');
    expect(sellerAds.every((ad) => ad.sku !== null && ad.asin !== null)).toBe(true);
    const vendorAds = await exportRows(UK_VENDOR, 'ads');
    expect(vendorAds.length).toBeGreaterThan(0);
    expect(vendorAds.every((ad) => ad.sku === null && ad.asin !== null)).toBe(true);
  });

  it('meldet unbekannte Export- und Report-IDs als NOT_FOUND', async () => {
    const { client } = simulated();
    await expect(
      client.getExport(connection, { amazonProfileId: DE, exportType: 'ads', exportId: 'x' }),
    ).resolves.toEqual({ status: 'NOT_FOUND' });
    await expect(
      client.getReport(connection, { amazonProfileId: DE, reportId: 'x' }),
    ).resolves.toEqual({ status: 'NOT_FOUND' });
  });

  async function reportRows<T extends AmazonAdsReportType>(
    sim: ReturnType<typeof simulated>,
    reportType: T,
    range = { startDate: '2026-09-20', endDate: '2026-09-26' },
  ): Promise<AmazonAdsReportRows[T][]> {
    const { client, advance } = sim;
    const { reportId } = await client.requestReport(connection, {
      amazonProfileId: DE,
      reportType,
      ...range,
    });
    const ref = { amazonProfileId: DE, reportId };
    await expect(client.getReport(connection, ref)).resolves.toEqual({ status: 'PENDING' });
    advance(60_000);
    const state = await client.getReport(connection, ref);
    expect(state.status).toBe('COMPLETED');
    const rows = await download(client, state.status === 'COMPLETED' ? state.url : null);
    // Wie Amazon: nur die angeforderten Spalten.
    const columns = new Set<string>(REPORT_DEFINITIONS[reportType].columns);
    for (const row of rows) {
      expect(Object.keys(row as object).filter((key) => !columns.has(key))).toEqual([]);
    }
    const schema = createReportRowSchema(reportType);
    return rows.map((row) => schema.parse(row));
  }

  it('liefert Reports als gzip-JSON: nur Tage im Zeitraum, Kampagnen = Summe der Ad Groups', async () => {
    const sim = simulated();
    const campaigns = await reportRows(sim, 'spCampaigns');
    const adGroups = await reportRows(sim, 'spAdGroups');
    expect(campaigns.length).toBeGreaterThan(0);
    expect(campaigns.every((r) => r.date >= '2026-09-20' && r.date <= '2026-09-26')).toBe(true);
    for (const row of campaigns) {
      const parts = adGroups.filter(
        (g) => g.date === row.date && g.amazonCampaignId === row.amazonCampaignId,
      );
      expect(parts.reduce((sum, g) => sum + g.clicks, 0)).toBe(row.clicks);
      const costMilli = (value: string) => Math.round(Number(value) * 1000);
      expect(parts.reduce((sum, g) => sum + costMilli(g.cost), 0)).toBe(costMilli(row.cost));
    }
    expect(campaigns.map((r) => r.sales7d)).toContain('1234567.89');
    expect(adGroups.map((r) => r.cost)).toContain('0.005');
  });

  it('liefert Target-, Product-Ad- und Suchbegriff-Reports', async () => {
    const sim = simulated();
    expect((await reportRows(sim, 'spTargeting')).length).toBeGreaterThan(0);
    expect((await reportRows(sim, 'spAdvertisedProduct')).length).toBeGreaterThan(0);
    const terms = await reportRows(sim, 'spSearchTerm');
    expect(terms.every((row) => row.searchTerm.length > 0)).toBe(true);
  });

  it('exportiert SB-Entities nur für das DE-Profil, getrennt von SP (1.9)', async () => {
    const campaigns = await exportRows(DE, 'campaigns', SB);
    expect(campaigns.length).toBeGreaterThan(0);
    expect(campaigns.every((c) => c.adProduct === SB)).toBe(true);
    const spCampaigns = await exportRows(DE, 'campaigns');
    expect(spCampaigns.every((c) => c.adProduct === 'SPONSORED_PRODUCTS')).toBe(true);
    expect(await exportRows(FR, 'campaigns', SB)).toEqual([]);

    // SB-Targets tragen wie im gemeinsamen Modell keine Kampagne; dazu Themen und ein Negative.
    const targets = await exportRows(DE, 'targets', SB);
    expect(targets.every((t) => t.target.amazonCampaignId === null)).toBe(true);
    expect(new Set(targets.map((t) => t.target.targetType))).toEqual(
      new Set(['keyword', 'theme', 'product']),
    );
    expect(targets.some((t) => t.kind === 'negative')).toBe(true);

    const ads = await exportRows(DE, 'ads', SB);
    expect(ads.map((ad) => [ad.extra.adType, ad.asin, ad.sku])).toEqual([
      ['VIDEO', 'B0MOCK0001', null],
      ['PRODUCT_COLLECTION', null, null],
    ]);
    expect(ads[1]?.extra.asins).toHaveLength(3);
  });

  it('liefert SB-Reports: Klick + View, Klick-Anteil, Kampagnen = Summe der Ad Groups (1.9)', async () => {
    const sim = simulated();
    const campaigns = await reportRows(sim, 'sbCampaigns');
    const adGroups = await reportRows(sim, 'sbAdGroup');
    expect(campaigns.length).toBeGreaterThan(0);
    for (const row of campaigns) {
      const parts = adGroups.filter(
        (g) => g.date === row.date && g.amazonCampaignId === row.amazonCampaignId,
      );
      expect(parts.reduce((sum, g) => sum + g.clicks, 0)).toBe(row.clicks);
      expect(row.sales7d).toBeNull();
      expect(Number(row.sales14d)).toBeGreaterThanOrEqual(Number(row.salesClicks14d));
      expect(row.purchases14d!).toBeGreaterThanOrEqual(row.purchasesClicks14d!);
    }
    // Views machen einen Unterschied, sonst prüfte der Mock die Trennung nicht.
    expect(campaigns.some((r) => r.purchases14d! > r.purchasesClicks14d!)).toBe(true);

    const targets = await reportRows(sim, 'sbTargeting');
    expect(targets.length).toBeGreaterThan(0);
    expect((await reportRows(sim, 'sbAds')).length).toBeGreaterThan(0);
    const terms = await reportRows(sim, 'sbSearchTerm');
    expect(terms.every((row) => row.searchTerm.length > 0 && row.unitsClicks14d === null)).toBe(
      true,
    );
  });

  it('exportiert SD-Entities nur für das DE-Profil: Taktik, Kostenart, Zielgruppen, Ads mit ASIN oder SKU (1.9)', async () => {
    const campaigns = await exportRows(DE, 'campaigns', SD);
    expect(campaigns.map((c) => [c.adProduct, c.targetingType, c.extra.costType])).toEqual([
      [SD, 'T00030', 'VCPM'],
      [SD, 'T00020', 'CPC'],
    ]);
    expect(await exportRows(FR, 'campaigns', SD)).toEqual([]);

    const adGroups = await exportRows(DE, 'adGroups', SD);
    expect(adGroups.every((g) => g.defaultBid !== null)).toBe(true);

    // SD-Targets tragen wie SB keine Kampagne; Zielgruppe, Produkt, Kategorie und ein Negative.
    const targets = await exportRows(DE, 'targets', SD);
    expect(targets.every((t) => t.target.amazonCampaignId === null)).toBe(true);
    expect(new Set(targets.map((t) => t.target.targetType))).toEqual(
      new Set(['audience', 'product', 'category']),
    );
    expect(targets.some((t) => t.kind === 'negative')).toBe(true);

    // Seller bewerben SD-Product-Ads per SKU (ohne ASIN); das Bild-Ad zeigt zwei ASINs.
    const ads = await exportRows(DE, 'ads', SD);
    expect(ads.map((ad) => [ad.extra.adType, ad.asin, ad.sku])).toEqual([
      ['PRODUCT_AD', null, 'MOCK-SKU-0001'],
      ['IMAGE', null, null],
    ]);
    expect(ads[1]?.extra.asins).toHaveLength(2);
  });

  it('liefert SD-Reports: Klick + View, Same-SKU nach Klick, sichtbare Impressionen (1.9)', async () => {
    const sim = simulated();
    const campaigns = await reportRows(sim, 'sdCampaigns');
    const adGroups = await reportRows(sim, 'sdAdGroup');
    expect(campaigns.length).toBeGreaterThan(0);
    for (const row of [...campaigns, ...adGroups]) {
      expect(row.sales7d).toBeNull();
      expect(Number(row.sales14d)).toBeGreaterThanOrEqual(Number(row.salesClicks14d));
      expect(Number(row.salesClicks14d)).toBeGreaterThanOrEqual(Number(row.salesSameSku14d));
      expect(row.viewableImpressions).not.toBeNull();
      expect(row.viewableImpressions!).toBeLessThanOrEqual(row.impressions);
    }
    for (const row of campaigns) {
      const parts = adGroups.filter(
        (g) => g.date === row.date && g.amazonCampaignId === row.amazonCampaignId,
      );
      expect(parts.reduce((sum, g) => sum + g.clicks, 0)).toBe(row.clicks);
      expect(parts.reduce((sum, g) => sum + g.viewableImpressions!, 0)).toBe(
        row.viewableImpressions,
      );
    }
    expect(campaigns.some((r) => r.purchases14d! > r.purchasesClicks14d!)).toBe(true);

    // Target-IDs wie im Export (`targetingId` = `targetId`), Negatives ohne Kennzahlen.
    const exported = await exportRows(DE, 'targets', SD);
    const positive = exported.flatMap((t) =>
      t.kind === 'target' ? [t.target.amazonTargetId] : [],
    );
    const targets = await reportRows(sim, 'sdTargeting');
    expect(new Set(targets.map((t) => t.amazonTargetId))).toEqual(new Set(positive));

    // Der Report nennt ASIN und SKU, auch wenn der Export nur die SKU trägt.
    const ads = await reportRows(sim, 'sdAdvertisedProduct');
    expect(ads.length).toBeGreaterThan(0);
    expect(ads.every((ad) => ad.asin !== null && ad.sku !== null)).toBe(true);
  });

  it('antwortet auf eine identische Anfrage während der Verarbeitung mit 425 und der ID', async () => {
    const { client } = simulated();
    const input = {
      amazonProfileId: DE,
      reportType: 'spCampaigns' as const,
      startDate: '2026-09-01',
      endDate: '2026-09-26',
    };
    const { reportId } = await client.requestReport(connection, input);
    const error = await client.requestReport(connection, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmazonAdsDuplicateReportError);
    expect(error).toMatchObject({ duplicateOfReportId: reportId });
  });

  it('lässt 425 auf Wunsch ohne ID und Reports auf Wunsch scheitern', async () => {
    const sim = simulated({ duplicatesWithoutId: true, failingReportTypes: ['spSearchTerm'] });
    const input = {
      amazonProfileId: DE,
      reportType: 'spSearchTerm' as const,
      startDate: '2026-09-01',
      endDate: '2026-09-26',
    };
    const { reportId } = await sim.client.requestReport(connection, input);
    await expect(sim.client.requestReport(connection, input)).rejects.toMatchObject({
      duplicateOfReportId: null,
    });
    sim.advance(60_000);
    await expect(
      sim.client.getReport(connection, { amazonProfileId: DE, reportId }),
    ).resolves.toMatchObject({ status: 'FAILURE' });
  });

  it('holt einen laufenden Report auch aus einem neuen Mock-Prozess ab (Neustart)', async () => {
    const first = simulated();
    const { reportId } = await first.client.requestReport(connection, {
      amazonProfileId: DE,
      reportType: 'spCampaigns',
      startDate: '2026-09-20',
      endDate: '2026-09-26',
    });
    const second = simulated();
    second.advance(60_000);
    const state = await second.client.getReport(connection, { amazonProfileId: DE, reportId });
    expect(state.status).toBe('COMPLETED');
  });

  it('prüft den Content-Type wie Amazon (415)', async () => {
    const { client } = simulated();
    const error = await client
      .request(connection, {
        operation: 'test',
        method: 'POST',
        path: '/reporting/reports',
        amazonProfileId: DE,
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        schema: z.unknown(),
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 415 });
  });
});

describe('Mock-Anbieter: Änderungen (3.2a)', () => {
  const DE_PROFILE = '9007199254740993';
  const SP = 'SPONSORED_PRODUCTS';

  function setupWrites(simulation: MockAmazonAdsSimulation = {}) {
    return createMockAmazonAdsClient({
      redirectUri: REDIRECT_URI,
      consentUrl: CONSENT_URL,
      store: storeWith('Atzr|mock-refresh-test'),
      simulation,
      rateLimit: { requestsPerSecond: 1000 },
    });
  }

  it('nimmt Änderungen aller Arten an und vergibt für neue Negatives IDs', async () => {
    const outcome = await setupWrites().applyChanges(connection, {
      amazonProfileId: DE_PROFILE,
      adProduct: SP,
      operations: [
        {
          ref: 'c',
          type: 'update',
          entity: 'campaign',
          amazonId: '101',
          dailyBudget: '25',
          state: 'PAUSED',
        },
        { ref: 'k', type: 'update', entity: 'keyword', amazonId: '201', bid: '0.75' },
        { ref: 'a', type: 'archive', entity: 'negativeKeyword', amazonId: '301' },
        {
          ref: 'n1',
          type: 'createNegative',
          amazonCampaignId: '101',
          amazonAdGroupId: '111',
          negative: { type: 'keyword', keywordText: 'gebraucht', matchType: 'EXACT' },
        },
        {
          ref: 'n2',
          type: 'createNegative',
          amazonCampaignId: '101',
          amazonAdGroupId: null,
          negative: { type: 'product', asin: 'B0FREMD001' },
        },
      ],
    });

    expect(outcome.retryAfterMs).toBeNull();
    expect(outcome.results.slice(0, 3)).toEqual([
      { ref: 'c', status: 'applied', amazonId: '101' },
      { ref: 'k', status: 'applied', amazonId: '201' },
      { ref: 'a', status: 'applied', amazonId: '301' },
    ]);
    const created = outcome.results.slice(3);
    expect(created.map((r) => r.status)).toEqual(['applied', 'applied']);
    const newIds = created.map((r) => (r.status === 'applied' ? r.amazonId : null));
    expect(newIds.every((id) => id !== null && /^\d+$/.test(id))).toBe(true);
    expect(new Set(newIds).size).toBe(2);
  });

  it('lehnt Gebote und Budgets außerhalb der Grenzen des Marktplatzes je Änderung ab (Teilfehler)', async () => {
    const outcome = await setupWrites().applyChanges(connection, {
      amazonProfileId: DE_PROFILE,
      adProduct: SP,
      operations: [
        { ref: 'ok', type: 'update', entity: 'keyword', amazonId: '201', bid: '0.02' },
        { ref: 'low', type: 'update', entity: 'keyword', amazonId: '202', bid: '0.01' },
        { ref: 'high', type: 'update', entity: 'adGroup', amazonId: '111', defaultBid: '1000.01' },
        { ref: 'budget', type: 'update', entity: 'campaign', amazonId: '101', dailyBudget: '0.50' },
      ],
    });

    expect(outcome.results).toEqual([
      { ref: 'ok', status: 'applied', amazonId: '201' },
      {
        ref: 'low',
        status: 'failed',
        code: 'BID_OUT_OF_MARKET_PLACE_RANGE',
        message: expect.any(String),
      },
      {
        ref: 'high',
        status: 'failed',
        code: 'BID_OUT_OF_MARKET_PLACE_RANGE',
        message: expect.any(String),
      },
      {
        ref: 'budget',
        status: 'failed',
        code: 'BUDGET_OUT_OF_MARKET_PLACE_RANGE',
        message: expect.any(String),
      },
    ]);
  });

  it('lehnt Schreiben für Sponsored Brands und Sponsored Display mit klarem Grund ab (3.2c)', async () => {
    for (const adProduct of ['SPONSORED_BRANDS', 'SPONSORED_DISPLAY']) {
      const outcome = await setupWrites().applyChanges(connection, {
        amazonProfileId: DE_PROFILE,
        adProduct,
        operations: [
          { ref: 'c', type: 'update', entity: 'campaign', amazonId: '101', state: 'PAUSED' },
        ],
      });

      expect(outcome.results, adProduct).toEqual([
        {
          ref: 'c',
          status: 'failed',
          code: 'MOCK_NOT_SUPPORTED',
          message: expect.stringContaining('nur für Sponsored Products'),
        },
      ]);
    }
  });

  it('drosselt auf Wunsch die ersten Schreibaufrufe (429 mit Retry-After)', async () => {
    const outcome = await setupWrites({ throttledWrites: 1 }).applyChanges(connection, {
      amazonProfileId: DE_PROFILE,
      adProduct: SP,
      operations: [{ ref: 'k', type: 'update', entity: 'keyword', amazonId: '201', bid: '0.75' }],
    });

    expect(outcome).toEqual({
      results: [{ ref: 'k', status: 'unsent' }],
      throttled: true,
      retryAfterMs: 120_000,
    });
  });

  it('verlangt den Content-Type des Endpunkts und ein Profil, auf das das Token Zugriff hat', async () => {
    const client = setupWrites();
    await expect(
      client.applyChanges(connection, {
        amazonProfileId: '42',
        adProduct: SP,
        operations: [{ ref: 'k', type: 'update', entity: 'keyword', amazonId: '201', bid: '0.75' }],
      }),
    ).rejects.toMatchObject({ cause: { status: 403 }, results: [{ ref: 'k', status: 'unsent' }] });

    await expect(
      client.request(connection, {
        operation: 'test',
        method: 'PUT',
        path: '/sp/keywords',
        amazonProfileId: DE_PROFILE,
        headers: { 'Content-Type': 'application/json' },
        body: '{"keywords":[]}',
        schema: z.unknown(),
      }),
    ).rejects.toMatchObject({ status: 415 });
  });
});

describe('Mock-Anbieter: merkt sich Änderungen im laufenden Prozess (3.3)', () => {
  const DE = '9007199254740993';
  const SP = 'SPONSORED_PRODUCTS';
  const START = Date.parse('2026-09-27T06:00:00Z');

  function setup() {
    let now = START;
    const client = createMockAmazonAdsClient({
      redirectUri: REDIRECT_URI,
      consentUrl: CONSENT_URL,
      store: storeWith('Atzr|mock-refresh'),
      rateLimit: { requestsPerSecond: 1000 },
      simulation: { now: () => now, processingMs: 60_000 },
    });
    async function exportRows<T extends AmazonAdsExportType>(
      exportType: T,
      adProduct = SP,
    ): Promise<AmazonAdsExportRows[T][]> {
      const { exportId } = await client.requestExport(connection, {
        amazonProfileId: DE,
        exportType,
        adProduct,
      });
      now += 60_000;
      const state = await client.getExport(connection, {
        amazonProfileId: DE,
        exportType,
        exportId,
      });
      if (state.status !== 'COMPLETED') throw new Error('Export nicht fertig');
      const file = await client.downloadFile(state.url ?? '');
      if (file.status !== 'ok') throw new Error('Datei fehlt');
      const rows = (await decodeGzipJson(file.body, { maxBytes: 10 * 1024 * 1024 })) as unknown[];
      const schema = createExportRowSchema(exportType, { adProduct, logger: () => {} });
      return rows.map((row) => schema.parse(row));
    }
    return { client, exportRows };
  }

  it('liefert angenommene Änderungen im nächsten Export mit', async () => {
    const { client, exportRows } = setup();
    const campaign = (await exportRows('campaigns')).find((c) => c.state === 'ENABLED')!;
    const adGroup = (await exportRows('adGroups')).find(
      (g) => g.amazonCampaignId === campaign.amazonCampaignId,
    )!;
    const targets = await exportRows('targets');
    const keyword = targets.flatMap((t) =>
      t.kind === 'target' && t.target.targetType === 'keyword' ? [t.target] : [],
    )[0]!;
    const negative = targets.flatMap((t) => (t.kind === 'negative' ? [t.target] : []))[0]!;
    const ad = (await exportRows('ads'))[0]!;

    const outcome = await client.applyChanges(connection, {
      amazonProfileId: DE,
      adProduct: SP,
      operations: [
        {
          ref: 'campaign',
          type: 'update',
          entity: 'campaign',
          amazonId: campaign.amazonCampaignId,
          state: 'PAUSED',
          dailyBudget: '33.50',
          bidding: {
            strategy: 'NONE',
            placements: [
              { placement: 'PLACEMENT_TOP', percentage: '40' },
              { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: '15' },
            ],
          },
        },
        {
          ref: 'adGroup',
          type: 'update',
          entity: 'adGroup',
          amazonId: adGroup.amazonAdGroupId,
          defaultBid: '0.66',
        },
        {
          ref: 'keyword',
          type: 'update',
          entity: 'keyword',
          amazonId: keyword.amazonTargetId,
          bid: '0.77',
          state: 'PAUSED',
        },
        {
          ref: 'ad',
          type: 'update',
          entity: 'productAd',
          amazonId: ad.amazonAdId,
          state: 'PAUSED',
        },
        {
          ref: 'archive',
          type: 'archive',
          entity: negative.level === 'campaign' ? 'campaignNegativeKeyword' : 'negativeKeyword',
          amazonId: negative.amazonTargetId,
        },
        {
          ref: 'new',
          type: 'createNegative',
          amazonCampaignId: campaign.amazonCampaignId,
          amazonAdGroupId: adGroup.amazonAdGroupId,
          negative: { type: 'keyword', keywordText: 'gebraucht kaufen', matchType: 'PHRASE' },
        },
        {
          ref: 'newAsin',
          type: 'createNegative',
          amazonCampaignId: campaign.amazonCampaignId,
          amazonAdGroupId: null,
          negative: { type: 'product', asin: 'B0FREMD001' },
        },
      ],
    });
    expect(outcome.results.map((r) => r.status)).toEqual(Array(7).fill('applied'));
    const created = outcome.results.flatMap((r) =>
      r.ref.startsWith('new') && r.status === 'applied' ? [r.amazonId] : [],
    );

    const after = (await exportRows('campaigns')).find(
      (c) => c.amazonCampaignId === campaign.amazonCampaignId,
    )!;
    expect(after).toMatchObject({
      state: 'PAUSED',
      // Der Export normalisiert Beträge (33.50 → 33.5).
      budgetAmount: '33.5',
      biddingStrategy: 'NONE',
    });
    expect(after.extra.placementBidAdjustments).toEqual([
      { placement: 'PLACEMENT_TOP', percentage: 40 },
      { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 15 },
    ]);
    expect(
      (await exportRows('adGroups')).find((g) => g.amazonAdGroupId === adGroup.amazonAdGroupId),
    ).toMatchObject({ defaultBid: '0.66' });
    const targetsAfter = await exportRows('targets');
    const byId = new Map(targetsAfter.map((t) => [t.target.amazonTargetId, t]));
    expect(byId.get(keyword.amazonTargetId)!.target).toMatchObject({
      bid: '0.77',
      state: 'PAUSED',
    });
    expect(byId.get(negative.amazonTargetId)!.target).toMatchObject({ state: 'ARCHIVED' });
    expect(byId.get(created[0]!)).toMatchObject({
      kind: 'negative',
      target: {
        level: 'ad_group',
        targetType: 'keyword',
        keywordText: 'gebraucht kaufen',
        matchType: 'PHRASE',
        state: 'ENABLED',
      },
    });
    expect(byId.get(created[1]!)).toMatchObject({
      kind: 'negative',
      target: { level: 'campaign', targetType: 'product', state: 'ENABLED' },
    });
    expect((await exportRows('ads')).find((a) => a.amazonAdId === ad.amazonAdId)).toMatchObject({
      state: 'PAUSED',
    });

    // Nur im Speicher: Ein neuer Prozess liefert wieder die erzeugten Daten.
    const fresh = (await setup().exportRows('campaigns')).find(
      (c) => c.amazonCampaignId === campaign.amazonCampaignId,
    )!;
    expect(fresh).toMatchObject({ state: 'ENABLED', biddingStrategy: 'SALES_DOWN_ONLY' });
  });

  it('merkt sich abgelehnte Änderungen nicht', async () => {
    const { client, exportRows } = setup();
    const keyword = (await exportRows('targets')).flatMap((t) =>
      t.kind === 'target' && t.target.targetType === 'keyword' ? [t.target] : [],
    )[0]!;

    const outcome = await client.applyChanges(connection, {
      amazonProfileId: DE,
      adProduct: SP,
      operations: [
        {
          ref: 'zu-hoch',
          type: 'update',
          entity: 'keyword',
          amazonId: keyword.amazonTargetId,
          bid: '99999',
        },
      ],
    });

    expect(outcome.results[0]).toMatchObject({ status: 'failed' });
    const after = (await exportRows('targets')).find(
      (t) => t.target.amazonTargetId === keyword.amazonTargetId,
    )!;
    expect(after.target).toMatchObject({ bid: keyword.bid });
  });

  /** Eine vollständige SP-Struktur wie aus einem Preset (4.4). */
  const STRUCTURE: AmazonAdsCreateOperation[] = [
    {
      ref: 'c',
      entity: 'campaign',
      name: 'SP | Mock | Neu',
      targetingType: 'MANUAL',
      state: 'ENABLED',
      dailyBudget: '12.34',
      startDate: '2026-11-01',
      biddingStrategy: 'SALES_UP_AND_DOWN',
      placements: [{ placement: 'PLACEMENT_TOP', percentage: '50' }],
      amazonPortfolioId: null,
      offAmazon: 'limitSpend',
    },
    {
      ref: 'g',
      entity: 'adGroup',
      campaignRef: 'c',
      name: 'Neue Gruppe',
      defaultBid: '0.55',
      state: 'ENABLED',
    },
    {
      ref: 'ad',
      entity: 'productAd',
      campaignRef: 'c',
      adGroupRef: 'g',
      sku: 'NEU-SKU-1',
      asin: null,
      state: 'ENABLED',
    },
    {
      ref: 'kw',
      entity: 'keyword',
      campaignRef: 'c',
      adGroupRef: 'g',
      keywordText: 'neue laufschuhe',
      matchType: 'PHRASE',
      bid: '0.90',
      state: 'ENABLED',
    },
    {
      ref: 'pt',
      entity: 'target',
      campaignRef: 'c',
      adGroupRef: 'g',
      expression: { type: 'ASIN_SAME_AS', value: 'B0ZIEL0001' },
      bid: null,
      state: 'PAUSED',
    },
    {
      ref: 'cat',
      entity: 'target',
      campaignRef: 'c',
      adGroupRef: 'g',
      expression: { type: 'ASIN_CATEGORY_SAME_AS', value: '12345678901' },
      bid: '0.40',
      state: 'ENABLED',
    },
    {
      ref: 'nk',
      entity: 'negativeKeyword',
      campaignRef: 'c',
      adGroupRef: 'g',
      keywordText: 'gebraucht',
      matchType: 'NEGATIVE_EXACT',
    },
    { ref: 'nt', entity: 'negativeTarget', campaignRef: 'c', adGroupRef: 'g', asin: 'B0FREMD002' },
  ];

  it('legt neue Strukturen an und liefert sie im nächsten Export mit (4.4)', async () => {
    const { client, exportRows } = setup();

    const outcome = await applyCreates(
      { request: client.request, logger: noopLogger },
      connection,
      { amazonProfileId: DE, operations: STRUCTURE },
    );

    expect(outcome.results.map((r) => r.status)).toEqual(Array(STRUCTURE.length).fill('applied'));
    const id = Object.fromEntries(
      outcome.results.map((r) => [r.ref, r.status === 'applied' ? r.amazonId! : '']),
    );
    expect(new Set(Object.values(id)).size).toBe(STRUCTURE.length);

    expect((await exportRows('campaigns')).find((c) => c.amazonCampaignId === id.c)).toMatchObject({
      name: 'SP | Mock | Neu',
      state: 'ENABLED',
      targetingType: 'MANUAL',
      budgetAmount: '12.34',
      biddingStrategy: 'SALES_UP_AND_DOWN',
      startDate: '2026-11-01',
      amazonPortfolioId: null,
    });
    expect((await exportRows('adGroups')).find((g) => g.amazonAdGroupId === id.g)).toMatchObject({
      amazonCampaignId: id.c,
      name: 'Neue Gruppe',
      defaultBid: '0.55',
      state: 'ENABLED',
    });
    expect((await exportRows('ads')).find((a) => a.amazonAdId === id.ad)).toMatchObject({
      amazonAdGroupId: id.g,
      sku: 'NEU-SKU-1',
      state: 'ENABLED',
    });
    const targets = new Map(
      (await exportRows('targets')).map((t) => [t.target.amazonTargetId, t] as const),
    );
    expect(targets.get(id.kw!)).toMatchObject({
      kind: 'target',
      target: {
        amazonCampaignId: id.c,
        amazonAdGroupId: id.g,
        targetType: 'keyword',
        keywordText: 'neue laufschuhe',
        matchType: 'PHRASE',
        bid: '0.9',
        state: 'ENABLED',
      },
    });
    expect(targets.get(id.pt!)).toMatchObject({
      kind: 'target',
      target: {
        targetType: 'product',
        expression: { matchType: 'PRODUCT_EXACT', asin: 'B0ZIEL0001' },
        bid: null,
        state: 'PAUSED',
      },
    });
    expect(targets.get(id.cat!)).toMatchObject({
      kind: 'target',
      target: { targetType: 'category', expression: { productCategoryId: '12345678901' } },
    });
    expect(targets.get(id.nk!)).toMatchObject({
      kind: 'negative',
      target: { level: 'ad_group', keywordText: 'gebraucht', matchType: 'EXACT' },
    });
    expect(targets.get(id.nt!)).toMatchObject({
      kind: 'negative',
      target: { level: 'ad_group', targetType: 'product', expression: { asin: 'B0FREMD002' } },
    });

    // Neue Entities lassen sich danach ändern wie bestehende.
    await client.applyChanges(connection, {
      amazonProfileId: DE,
      adProduct: SP,
      operations: [
        { ref: 'p', type: 'update', entity: 'campaign', amazonId: id.c!, state: 'PAUSED' },
      ],
    });
    expect((await exportRows('campaigns')).find((c) => c.amazonCampaignId === id.c)).toMatchObject({
      state: 'PAUSED',
    });
  });

  it('legt Sponsored Display an und liefert es im nächsten Export mit (4.9)', async () => {
    const { client, exportRows } = setup();
    const SD_STRUCTURE: AmazonAdsCreateOperation[] = [
      {
        ref: 'c',
        entity: 'sdCampaign',
        name: 'SD | Mock | Neu',
        state: 'ENABLED',
        dailyBudget: '11.00',
        startDate: '2099-11-01',
        tactic: 'T00030',
        costType: 'cpc',
        amazonPortfolioId: null,
      },
      {
        ref: 'g',
        entity: 'sdAdGroup',
        campaignRef: 'c',
        name: 'SD Gruppe',
        defaultBid: '0.55',
        bidOptimization: 'conversions',
        state: 'ENABLED',
      },
      {
        ref: 'ad',
        entity: 'sdProductAd',
        campaignRef: 'c',
        adGroupRef: 'g',
        sku: 'NEU-SKU-1',
        asin: null,
        state: 'ENABLED',
      },
      {
        ref: 'v',
        entity: 'sdTarget',
        campaignRef: 'c',
        adGroupRef: 'g',
        expression: { type: 'views', lookbackDays: 30 },
        bid: '0.60',
        state: 'ENABLED',
      },
      {
        ref: 'cat',
        entity: 'sdTarget',
        campaignRef: 'c',
        adGroupRef: 'g',
        expression: { type: 'asinCategorySameAs', value: '12345678901' },
        bid: null,
        state: 'ENABLED',
      },
      { ref: 'n', entity: 'sdNegativeTarget', campaignRef: 'c', adGroupRef: 'g', asin: 'B0FREMD002' },
    ];

    const outcome = await applyCreates(
      { request: client.request, logger: noopLogger },
      connection,
      { amazonProfileId: DE, operations: SD_STRUCTURE },
    );
    expect(outcome.results.map((r) => r.status)).toEqual(Array(SD_STRUCTURE.length).fill('applied'));
    const id = Object.fromEntries(
      outcome.results.map((r) => [r.ref, r.status === 'applied' ? r.amazonId! : '']),
    );

    expect((await exportRows('campaigns', 'SPONSORED_DISPLAY')).find((c) => c.amazonCampaignId === id.c)).toMatchObject({
      adProduct: 'SPONSORED_DISPLAY',
      name: 'SD | Mock | Neu',
      budgetAmount: '11',
      startDate: '2099-11-01',
    });
    expect((await exportRows('adGroups', 'SPONSORED_DISPLAY')).find((g) => g.amazonAdGroupId === id.g)).toMatchObject({
      amazonCampaignId: id.c,
      defaultBid: '0.55',
    });
    expect((await exportRows('ads', 'SPONSORED_DISPLAY')).find((a) => a.amazonAdId === id.ad)).toMatchObject({
      amazonAdGroupId: id.g,
      sku: 'NEU-SKU-1',
    });
    const targets = new Map(
      (await exportRows('targets', 'SPONSORED_DISPLAY')).map((t) => [t.target.amazonTargetId, t] as const),
    );
    expect(targets.get(id.v!)).toMatchObject({
      kind: 'target',
      target: { targetType: 'audience', expression: { event: 'VIEWS', lookback: 30 }, bid: '0.6' },
    });
    expect(targets.get(id.cat!)).toMatchObject({
      kind: 'target',
      target: { targetType: 'category', expression: { productCategoryId: '12345678901' } },
    });
    expect(targets.get(id.n!)).toMatchObject({
      kind: 'negative',
      target: { level: 'ad_group', targetType: 'product', expression: { asin: 'B0FREMD002' } },
    });
  });

  it('prüft Grenzen und Produkt-IDs je Anlage und merkt sich Abgelehntes nicht (4.4)', async () => {
    const { client, exportRows } = setup();
    const before = (await exportRows('campaigns')).length;

    const outcome = await applyCreates(
      { request: client.request, logger: noopLogger },
      connection,
      {
        amazonProfileId: DE,
        operations: [
          { ...STRUCTURE[0]!, dailyBudget: '99999999' } as AmazonAdsCreateOperation,
          ...STRUCTURE.slice(1),
          {
            ...STRUCTURE[3]!,
            ref: 'kw-gebot',
            keywordText: 'zu teuer',
            bid: '99999',
          } as AmazonAdsCreateOperation,
        ],
        created: new Map(),
      },
    );
    expect(outcome.results[0]).toMatchObject({
      status: 'failed',
      code: 'BUDGET_OUT_OF_MARKET_PLACE_RANGE',
    });
    expect(outcome.results.slice(1).map((r) => r.status)).toEqual(
      Array(STRUCTURE.length).fill('failed'),
    );

    const ok = await applyCreates({ request: client.request, logger: noopLogger }, connection, {
      amazonProfileId: DE,
      operations: [
        STRUCTURE[0]!,
        STRUCTURE[1]!,
        { ...STRUCTURE[2]!, sku: null, asin: 'B0VENDOR01' } as AmazonAdsCreateOperation,
        { ...STRUCTURE[3]!, bid: '99999' } as AmazonAdsCreateOperation,
        {
          ...STRUCTURE[6]!,
          keywordText: 'eins zwei drei vier fünf',
          matchType: 'NEGATIVE_PHRASE',
        } as AmazonAdsCreateOperation,
      ],
    });
    expect(ok.results.map((r) => (r.status === 'failed' ? r.code : r.status))).toEqual([
      'applied',
      'applied',
      // Seller-Profil: Product Ads brauchen die SKU.
      'INVALID_ASIN',
      'BID_OUT_OF_MARKET_PLACE_RANGE',
      'TOO_HIGH',
    ]);
    expect((await exportRows('campaigns')).length).toBe(before + 1);
  });
});
