import { setupServer } from 'msw/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RefreshTokenStore } from './access-token';
import { decodeGzipJson } from './download';
import { createExportRowSchema } from './exports';
import { createMockAmazonAdsClient } from './mock';
import { parseJsonLossless } from './json';
import { mockReportRows, toAmazonJson, type MockAccount } from './mock-data';
import { LARGE_MOCK_CLIENTS, LARGE_MOCK_PROFILES, largeMockAccount } from './mock-large';
import { createReportRowSchema, REPORT_DEFINITIONS, type AmazonAdsReportType } from './reports';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const SP = 'SPONSORED_PRODUCTS';
const SB = 'SPONSORED_BRANDS';
const SD = 'SPONSORED_DISPLAY';

/** Report-Zeilen wie aus der Datei (JSON-Text, verlustfrei geparst). */
const reportRows = (...args: Parameters<typeof mockReportRows>) =>
  parseJsonLossless(toAmazonJson(mockReportRows(...args)), { decimals: 'string' }) as Array<
    Record<string, unknown>
  >;

const accounts = LARGE_MOCK_PROFILES.map((profile) => largeMockAccount(profile));
const all = <K extends 'campaigns' | 'adGroups' | 'targets' | 'ads'>(key: K): MockAccount[K] =>
  accounts.flatMap((account) => account[key] as unknown[]) as MockAccount[K];

describe('Demo-Daten mit Volumen (Generator)', () => {
  it('hat 6 Profile in EUR, GBP, SEK und PLN mit allen Kontotypen', () => {
    expect(LARGE_MOCK_PROFILES).toHaveLength(6);
    expect(new Set(LARGE_MOCK_PROFILES.map((p) => p.currencyCode))).toEqual(
      new Set(['EUR', 'GBP', 'SEK', 'PLN']),
    );
    expect(new Set(LARGE_MOCK_PROFILES.map((p) => p.accountType))).toEqual(
      new Set(['seller', 'vendor', 'agency']),
    );
  });

  it('erzeugt rund 300 Kampagnen und über 10 000 Targets über alle Ad-Typen', () => {
    const campaigns = all('campaigns');
    expect(campaigns.length).toBeGreaterThanOrEqual(270);
    expect(campaigns.length).toBeLessThanOrEqual(330);
    const targets = all('targets').filter((t) => !t.negative);
    expect(targets.length).toBeGreaterThan(10_000);
    expect(targets.length).toBeLessThanOrEqual(13_000);
    expect(new Set(campaigns.map((c) => c.adProduct))).toEqual(new Set([SP, SB, SD]));
    expect(all('targets').some((t) => t.negative && t.adGroupId === null)).toBe(true);
    expect(all('ads').some((ad) => ad.asins.length > 1)).toBe(true);
  });

  it('passt Target-Art und Ausdruck zusammen (Keyword-Text bei Keywords, ASIN bei Produkten)', () => {
    for (const target of all('targets')) {
      if (target.targetType === 'KEYWORD') expect(target.details).toHaveProperty('keyword');
      if (target.targetType === 'PRODUCT') expect(target.details).toHaveProperty('asin');
    }
  });

  it('liefert je Report-Typ gültige Zeilen ohne doppelte Schlüssel (sonst lehnt der Import ab)', () => {
    const keyOf: Record<string, (row: Record<string, unknown>) => string> = {
      campaign: (row) => `${String(row.campaignId)}`,
      adGroup: (row) => `${String(row.adGroupId)}`,
      target: (row) => `${String(row.keywordId ?? row.targetingId)}`,
      productAd: (row) => `${String(row.adId)}`,
      searchTerm: (row) => `${String(row.keywordId)}|${String(row.searchTerm)}`,
    };
    for (const account of accounts) {
      for (const reportType of Object.keys(REPORT_DEFINITIONS) as AmazonAdsReportType[]) {
        const { level } = REPORT_DEFINITIONS[reportType];
        const rows = reportRows(account, reportType, '2026-09-01', '2026-09-02');
        const schema = createReportRowSchema(reportType);
        for (const row of rows) schema.parse(row);
        const keys = rows.map((row) => `${String(row.date)}|${keyOf[level]!(row)}`);
        expect(new Set(keys).size, `${account.profile.amazonProfileId} ${reportType}`).toBe(
          keys.length,
        );
      }
    }
  });

  it('gibt SKUs nur Product-Ads von Sellern', () => {
    for (const ad of all('ads')) {
      if (ad.sku !== undefined) expect(ad.adType).toBe('PRODUCT_AD');
    }
  });

  it('ist deterministisch und hat eindeutige IDs', () => {
    expect(largeMockAccount(LARGE_MOCK_PROFILES[0]!)).toEqual(accounts[0]);
    const ids = [...all('campaigns'), ...all('adGroups'), ...all('targets'), ...all('ads')].map(
      (entity) => entity.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('nutzt nur erfundene Namen mit Kennzeichen „Demo“ bei Profilen', () => {
    for (const profile of LARGE_MOCK_PROFILES) expect(profile.accountName).toMatch(/Demo/);
    for (const client of LARGE_MOCK_CLIENTS) expect(client.name).toMatch(/\(Demo\)$/);
  });

  it('ordnet Profile 3 Clients zu und lässt eines ohne Client', () => {
    expect(LARGE_MOCK_CLIENTS).toHaveLength(3);
    const assigned = LARGE_MOCK_CLIENTS.flatMap((c) => c.amazonProfileIds);
    const known = new Set(LARGE_MOCK_PROFILES.map((p) => p.amazonProfileId));
    for (const id of assigned) expect(known.has(id)).toBe(true);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned.length).toBe(LARGE_MOCK_PROFILES.length - 1);
  });

  it('hat SB-Kampagnen ohne Kennzahlen (Preview-Lücke)', () => {
    const account = accounts.find((a) => a.campaigns.some((c) => c.adProduct === SB))!;
    const sb = account.campaigns.filter((c) => c.adProduct === SB);
    const reported = new Set(
      reportRows(account, 'sbCampaigns', '2026-09-01', '2026-09-07').map((row) =>
        String(row.campaignId),
      ),
    );
    expect(sb.some((c) => !reported.has(c.id))).toBe(true);
    expect(sb.some((c) => reported.has(c.id))).toBe(true);
  });
});

describe('Mock-Anbieter mit scale large', () => {
  const connection = { id: 'conn-1', organizationId: 'org-1', region: 'eu' as const };
  const store: RefreshTokenStore = {
    async withRefreshToken(_id, refresh) {
      return (await refresh('Atzr|mock-refresh')).result;
    },
  };
  let now = Date.parse('2026-09-27T06:00:00Z');
  const client = createMockAmazonAdsClient({
    redirectUri: 'http://localhost/cb',
    consentUrl: 'http://localhost/consent',
    store,
    rateLimit: { requestsPerSecond: 100 },
    scale: 'large',
    simulation: { now: () => now, processingMs: 1_000 },
  });

  it('liefert die 6 Demo-Profile in der EU und keine in NA', async () => {
    const eu = await client.listProfiles(connection);
    expect(eu.map((p) => p.amazonProfileId)).toEqual(
      LARGE_MOCK_PROFILES.map((p) => p.amazonProfileId),
    );
    expect(eu.map((p) => p.accountName)).toEqual(LARGE_MOCK_PROFILES.map((p) => p.accountName));
    await expect(client.listProfiles({ ...connection, region: 'na' })).resolves.toEqual([]);
  });

  it('exportiert Targets und liefert Reports, die die Schemas des Clients bestehen', async () => {
    const profile = LARGE_MOCK_PROFILES[0]!;
    const { exportId } = await client.requestExport(connection, {
      amazonProfileId: profile.amazonProfileId,
      exportType: 'targets',
      adProduct: SD,
    });
    now += 1_000;
    const state = await client.getExport(connection, {
      amazonProfileId: profile.amazonProfileId,
      exportType: 'targets',
      exportId,
    });
    if (state.status !== 'COMPLETED' || !state.url) throw new Error('Export nicht fertig');
    const file = await client.downloadFile(state.url);
    if (file.status !== 'ok') throw new Error('Datei fehlt');
    const rows = (await decodeGzipJson(file.body, { maxBytes: 50 * 1024 * 1024 })) as unknown[];
    const schema = createExportRowSchema('targets', { adProduct: SD, logger: () => {} });
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) schema.parse(row);

    const account = largeMockAccount(profile);
    const rows1 = reportRows(account, 'spTargeting', '2026-09-01', '2026-09-01');
    const reportSchema = createReportRowSchema('spTargeting');
    expect(rows1.length).toBeGreaterThan(500);
    for (const row of rows1) reportSchema.parse(row);
  });
});
