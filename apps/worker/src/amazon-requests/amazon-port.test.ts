import {
  createMockAmazonAdsClient,
  createRequestMeter,
  decodeGzipJson,
  type AmazonAdsClient,
} from '@profitbash/amazon-ads';
import type { AmazonRequest } from '@profitbash/db';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAmazonRequestPort } from './amazon-port';
import type { AmazonRequestPort } from './state-machine';

// Ohne Handler: Der Mock-Anbieter beantwortet alles im Prozess, jeder echte Aufruf ließe den Test scheitern.
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const PROFILE_ID = '00000000-0000-4000-8000-000000000001';
const AMAZON_PROFILE_ID = '9007199254740993';
const connection = { id: 'conn-1', organizationId: 'org-1', region: 'eu' as const };

function row(overrides: Partial<AmazonRequest>): AmazonRequest {
  const now = new Date('2026-09-27T06:00:00Z');
  return {
    id: 'req-1',
    organizationId: 'org-1',
    profileId: PROFILE_ID,
    kind: 'report',
    adProduct: 'SPONSORED_PRODUCTS',
    reportType: 'spCampaigns',
    startDate: '2026-09-20',
    endDate: '2026-09-26',
    batchId: null,
    amazonRequestId: null,
    status: 'pending_request',
    attempts: 0,
    importAttempts: 0,
    errorCount: 0,
    requestCount: 0,
    nextPollAt: now,
    requestedAt: null,
    completedAt: null,
    importedAt: null,
    failureReason: null,
    rowCount: null,
    invalidRowCount: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setup(simulation: { failingReportTypes?: string[] } = {}) {
  let now = Date.parse('2026-09-27T06:00:00Z');
  const client: AmazonAdsClient = createMockAmazonAdsClient({
    redirectUri: 'http://localhost/cb',
    consentUrl: 'http://localhost/consent',
    store: {
      async withRefreshToken(_id, refresh) {
        return (await refresh('Atzr|mock-refresh')).result;
      },
    },
    rateLimit: { requestsPerSecond: 100 },
    simulation: { now: () => now, processingMs: 60_000, ...simulation },
  });
  const meter = createRequestMeter();
  const imports: unknown[] = [];
  const port = createAmazonRequestPort({
    client,
    connection,
    amazonProfileIds: new Map([[PROFILE_ID, AMAZON_PROFILE_ID]]),
    meter,
    logger: () => {},
    import: async (_tx, input) => {
      imports.push(input);
    },
  });
  return {
    port,
    meter,
    imports,
    advance(ms: number) {
      now += ms;
    },
  };
}

async function fetchRows(port: AmazonRequestPort, request: AmazonRequest): Promise<unknown[]> {
  const state = await port.getStatus(request);
  expect(state.status).toBe('COMPLETED');
  const download = await port.download(
    request,
    state.status === 'COMPLETED' ? (state.url ?? '') : '',
  );
  if (download.status !== 'ok') throw new Error('Datei fehlt');
  const rows = (await decodeGzipJson(download.body, { maxBytes: 10_000_000 })) as unknown[];
  const schema = port.rowSchema(request);
  return rows.map((raw) => schema.parse(raw));
}

describe('createAmazonRequestPort', () => {
  it('fordert Reports an, fragt den Status ab, lädt und liefert normalisierte Zeilen', async () => {
    const { port, advance, meter } = setup();
    const pending = row({ reportType: 'spAdGroups' });

    const submission = await port.request(pending);
    expect(submission.status).toBe('requested');
    const requested = row({
      reportType: 'spAdGroups',
      status: 'requested',
      amazonRequestId: submission.amazonRequestId,
    });
    await expect(port.getStatus(requested)).resolves.toEqual({ status: 'PENDING' });
    advance(60_000);

    const rows = await fetchRows(port, requested);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      amazonCampaignId: expect.any(String),
      amazonAdGroupId: expect.any(String),
    });
    // Anfordern und zwei Status-Abfragen; der Download geht nicht an die Ads-API.
    expect(meter.requests).toBe(3);
  });

  it('meldet 425 als duplicate mit der ID des laufenden Reports', async () => {
    const { port } = setup();
    const first = await port.request(row({}));
    await expect(port.request(row({ id: 'req-2' }))).resolves.toEqual({
      status: 'duplicate',
      amazonRequestId: first.amazonRequestId,
    });
  });

  it('bildet FAILED auf FAILURE und unbekannte IDs auf NOT_FOUND ab', async () => {
    const { port, advance } = setup({ failingReportTypes: ['spCampaigns'] });
    const submission = await port.request(row({}));
    advance(60_000);
    await expect(
      port.getStatus(row({ status: 'requested', amazonRequestId: submission.amazonRequestId })),
    ).resolves.toMatchObject({ status: 'FAILURE' });
    await expect(
      port.getStatus(row({ status: 'requested', amazonRequestId: 'unbekannt' })),
    ).resolves.toEqual({ status: 'NOT_FOUND' });
  });

  it('fordert Exports mit dem Ad-Typ des Auftrags an und normalisiert Targets', async () => {
    const { port, advance } = setup();
    const pending = row({
      kind: 'export',
      reportType: 'targets',
      startDate: null,
      endDate: null,
      batchId: '00000000-0000-4000-8000-0000000000b1',
    });
    const submission = await port.request(pending);
    expect(submission.status).toBe('requested');
    advance(60_000);
    const rows = await fetchRows(port, {
      ...pending,
      status: 'requested',
      amazonRequestId: submission.amazonRequestId,
    });
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'negative' }));
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'target' }));
  });

  it('meldet eine abgelaufene Download-URL als expired', async () => {
    const { port } = setup();
    const expired = await port.download(
      row({}),
      'https://offline-report-storage-eu-west-1-prod.s3.amazonaws.com/mock/weg.json.gz',
    );
    expect(expired).toEqual({ status: 'expired' });
  });

  it('reicht den Import an die übergebene Funktion weiter', async () => {
    const { port, imports } = setup();
    const input = { kind: 'export' as const, batchId: 'b', files: [] };
    await port.import({} as never, input);
    expect(imports).toEqual([input]);
  });

  it('scheitert laut bei Profilen ohne Amazon-ID, unbekannten Typen und fehlender Auftrags-ID', async () => {
    const { port } = setup();
    await expect(port.request(row({ profileId: 'fremd' }))).rejects.toThrow(/Profil/);
    await expect(port.request(row({ reportType: 'spUnbekannt' }))).rejects.toThrow(/Report-Typ/);
    await expect(
      port.request(row({ kind: 'export', reportType: 'keywords', startDate: null, endDate: null })),
    ).rejects.toThrow(/Export-Typ/);
    await expect(port.getStatus(row({ status: 'requested' }))).rejects.toThrow(/ID/);
    expect(() => port.rowSchema(row({ reportType: 'spUnbekannt' }))).toThrow(/Report-Typ/);
  });
});
