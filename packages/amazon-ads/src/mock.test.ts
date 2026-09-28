import { setupServer } from 'msw/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RefreshTokenStore } from './access-token';
import type { AmazonAdsClient } from './client';
import { decodeGzipJson } from './download';
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
