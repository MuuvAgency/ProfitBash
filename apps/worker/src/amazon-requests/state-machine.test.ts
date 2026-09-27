import { gzipSync } from 'node:zlib';
import { AmazonAdsHttpError, AmazonAdsReauthRequiredError } from '@profitbash/amazon-ads';
import {
  createAmazonRequest,
  findAmazonRequest,
  listDueAmazonRequests,
  schema,
  updateAmazonRequest,
  type AmazonRequest,
  type NewAmazonRequest,
} from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import type { LogEntry } from '@profitbash/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createConnection, createOrganization } from '../testing';
import {
  advanceAmazonRequest,
  MAX_CONSECUTIVE_ERRORS,
  MAX_REQUESTS,
  submitAmazonExportBatch,
  submitAmazonRequest,
  type AmazonDownload,
  type AmazonImportInput,
  type AmazonRequestDeps,
  type AmazonRequestState,
  type AmazonRequestSubmission,
} from './state-machine';

const { amazonAdsProfiles, amazonAdsReportRequests, jobRuns } = schema;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const start = new Date('2026-09-27T06:00:00Z');

let testDb: TestDatabase;
let organizationId = '';
let connectionId = '';
let profileId = '';
let clock = start;
const advanceClock = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const at = (ms: number) => new Date(start.getTime() + ms);

// ---------------------------------------------------------------------------
// Fake-Schnittstelle zu Amazon
// ---------------------------------------------------------------------------

const rowSchema = z.object({ date: z.string(), campaignId: z.string(), cost: z.string() });

const defaultRows = [
  { date: '2026-09-25', campaignId: '9007199254740993', cost: 0.1 },
  { date: '2026-09-24', campaignId: '1', cost: 1234567.89 },
];

/** gzip-JSON als Body. Zahlen im Text bleiben so, wie sie hier stehen (z. B. `0.10`). */
function gzipBody(json: string): AsyncIterable<Uint8Array> {
  const bytes = gzipSync(Buffer.from(json, 'utf8'));
  return (async function* () {
    await Promise.resolve();
    yield new Uint8Array(bytes);
  })();
}

interface Fake {
  request: (request: AmazonRequest) => Promise<AmazonRequestSubmission>;
  getStatus: (request: AmazonRequest) => Promise<AmazonRequestState>;
  download: (request: AmazonRequest, url: string) => Promise<AmazonDownload>;
  import: (
    tx: Parameters<AmazonRequestDeps['port']['import']>[0],
    input: AmazonImportInput,
  ) => Promise<void>;
}

let fake: Fake;
let calls: string[];
let imports: AmazonImportInput[];
let logs: LogEntry[];
let requestCounter = 0;

function defaultFake(): Fake {
  return {
    request: () =>
      Promise.resolve({ status: 'requested', amazonRequestId: `amz-${++requestCounter}` }),
    getStatus: (request) =>
      Promise.resolve({
        status: 'COMPLETED',
        url: `https://s3.example/${request.amazonRequestId}`,
      }),
    download: () => Promise.resolve({ status: 'ok', body: gzipBody(JSON.stringify(defaultRows)) }),
    import: (_tx, input) => {
      imports.push(input);
      return Promise.resolve();
    },
  };
}

function deps(overrides: Partial<AmazonRequestDeps> = {}): AmazonRequestDeps {
  return {
    db: testDb.db,
    logger: (entry) => logs.push(entry),
    now: () => clock,
    port: {
      request: (request) => {
        calls.push(`request:${request.reportType}`);
        return fake.request(request);
      },
      getStatus: (request) => {
        calls.push(`status:${request.amazonRequestId}`);
        return fake.getStatus(request);
      },
      download: (request, url) => {
        calls.push(`download:${url}`);
        return fake.download(request, url);
      },
      rowSchema: () => rowSchema,
      import: (tx, input) => {
        calls.push(`import:${input.kind}`);
        return fake.import(tx, input);
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

type ReportOverrides = Partial<
  Pick<NewAmazonRequest, 'profileId' | 'adProduct' | 'reportType' | 'startDate' | 'endDate'>
>;

const reportInput = (overrides: ReportOverrides = {}) => ({
  organizationId,
  profileId,
  kind: 'report' as const,
  adProduct: 'SPONSORED_PRODUCTS',
  reportType: 'spCampaigns',
  startDate: '2026-08-27',
  endDate: '2026-09-25',
  batchId: null,
  ...overrides,
});

const batchInput = (exportTypes: string[]) => ({
  organizationId,
  profileId,
  adProduct: 'SPONSORED_PRODUCTS',
  exportTypes,
});

/** Zeile wie nach einem Absturz direkt nach dem Anlegen (Amazon wurde nie oder ohne Antwort gerufen). */
async function pendingRow(overrides: ReportOverrides = {}) {
  const { request } = await createAmazonRequest(testDb.db, {
    ...reportInput(overrides),
    now: clock,
  });
  return request;
}

async function row(request: { id: string }) {
  const found = await findAmazonRequest(testDb.db, { organizationId, id: request.id });
  if (!found) throw new Error('Auftrag fehlt');
  return found;
}

const advance = (request: { id: string }, overrides: Partial<AmazonRequestDeps> = {}) =>
  advanceAmazonRequest(deps(overrides), { organizationId, id: request.id });

/** Auftrag bis `requested` bringen. */
async function requestedRow(overrides: ReportOverrides = {}) {
  const { request } = await submitAmazonRequest(deps(), reportInput(overrides));
  calls = [];
  return request;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  organizationId = await createOrganization(testDb.db, 'muuv');
  connectionId = await createConnection(testDb.db, {
    organizationId,
    externalAccountId: 'amzn1.account.A',
  });
  const [profile] = await testDb.db
    .insert(amazonAdsProfiles)
    .values({
      organizationId,
      connectionId,
      amazonProfileId: '111',
      accountName: 'Konto',
      countryCode: 'DE',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      accountType: 'seller',
    })
    .returning({ id: amazonAdsProfiles.id });
  if (!profile) throw new Error('Profil fehlt');
  profileId = profile.id;
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.db.delete(amazonAdsReportRequests);
  await testDb.db.delete(jobRuns);
  clock = start;
  requestCounter = 0;
  fake = defaultFake();
  calls = [];
  imports = [];
  logs = [];
});

// ---------------------------------------------------------------------------
// Anfordern
// ---------------------------------------------------------------------------

describe('submitAmazonRequest', () => {
  it('schreibt die Zeile, bevor Amazon gerufen wird, und speichert danach die ID', async () => {
    let seenInDb: AmazonRequest[] = [];
    fake.request = async () => {
      seenInDb = await testDb.db.select().from(amazonAdsReportRequests);
      return { status: 'requested', amazonRequestId: 'amz-42' };
    };

    const { request, counters } = await submitAmazonRequest(deps(), reportInput());

    expect(seenInDb).toEqual([
      expect.objectContaining({ status: 'pending_request', amazonRequestId: null }),
    ]);
    expect(request).toMatchObject({
      status: 'requested',
      amazonRequestId: 'amz-42',
      requestedAt: start,
      attempts: 0,
      requestCount: 1,
      nextPollAt: at(MINUTE),
    });
    expect(counters).toEqual({ requested: 1 });
  });

  it('fordert nicht erneut an, solange ein gleicher Auftrag offen ist', async () => {
    const first = await requestedRow();

    const second = await submitAmazonRequest(deps(), reportInput());

    expect(second).toEqual({ request: first, counters: {} });
    expect(calls).toEqual([]);
  });
});

describe('Absturz rund um das Anfordern', () => {
  it('vor dem Anfordern: Der nächste Lauf fordert die Zeile ohne ID an', async () => {
    const pending = await pendingRow();

    const { request, counters } = await advance(pending);

    expect(calls).toEqual(['request:spCampaigns']);
    expect(request).toMatchObject({ status: 'requested', amazonRequestId: 'amz-1' });
    expect(counters).toEqual({ requested: 1 });
  });

  it('nach dem Anfordern: 425 mit ID übernimmt den laufenden Report', async () => {
    const pending = await pendingRow();
    fake.request = () => Promise.resolve({ status: 'duplicate', amazonRequestId: 'amz-laeuft' });

    const { request, counters } = await advance(pending);

    expect(request).toMatchObject({
      status: 'requested',
      amazonRequestId: 'amz-laeuft',
      requestedAt: start,
      nextPollAt: at(MINUTE),
    });
    expect(counters).toEqual({ reused: 1 });
  });

  it('425 ohne ID: wartet 15 Minuten und fordert dann erneut an', async () => {
    const pending = await pendingRow();
    fake.request = () => Promise.resolve({ status: 'duplicate', amazonRequestId: null });

    const first = await advance(pending);

    expect(first.request).toMatchObject({
      status: 'pending_request',
      amazonRequestId: null,
      nextPollAt: at(15 * MINUTE),
    });
    expect(first.counters).toEqual({});

    advanceClock(15 * MINUTE);
    fake.request = () => Promise.resolve({ status: 'requested', amazonRequestId: 'amz-neu' });
    const second = await advance(pending);

    expect(second.request).toMatchObject({ status: 'requested', amazonRequestId: 'amz-neu' });
  });

  it('425 ohne ID über 4 Stunden: Auftrag scheitert statt endlos zu warten', async () => {
    const pending = await pendingRow();
    fake.request = () => Promise.resolve({ status: 'duplicate', amazonRequestId: null });
    advanceClock(4 * HOUR + MINUTE);

    const { request, counters } = await advance(pending);

    expect(request.status).toBe('failed');
    expect(request.failureReason).toMatch(/4 h/);
    expect(counters).toEqual({ failed: 1 });
  });

  it('Amazon lehnt die Anfrage ab (4xx): Auftrag scheitert sofort', async () => {
    const pending = await pendingRow();
    fake.request = () =>
      Promise.reject(
        new AmazonAdsHttpError(
          'reports.request: HTTP 400 (ungültige Spalte)',
          'reports.request',
          400,
          'BAD',
          null,
        ),
      );

    const { request, counters } = await advance(pending);

    expect(request).toMatchObject({
      status: 'failed',
      failureReason: expect.stringMatching(/400/) as unknown,
    });
    expect(counters).toEqual({ failed: 1 });
  });

  it('vorübergehender Fehler beim Anfordern: später erneut, Zeile bleibt offen', async () => {
    const pending = await pendingRow();
    fake.request = () =>
      Promise.reject(new AmazonAdsHttpError('HTTP 503', 'reports.request', 503, null, null));

    const { request } = await advance(pending);

    expect(request).toMatchObject({
      status: 'pending_request',
      attempts: 1,
      nextPollAt: at(2 * MINUTE),
      failureReason: expect.stringMatching(/503/) as unknown,
    });
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe('Status-Abfrage', () => {
  it('wartet mit Backoff 1 → 2 → 5 → 10 → 15 → 15 Minuten', async () => {
    const requested = await requestedRow();
    fake.getStatus = () => Promise.resolve({ status: 'PROCESSING' });
    const delays: number[] = [(requested.nextPollAt!.getTime() - clock.getTime()) / MINUTE];

    for (let i = 0; i < 5; i += 1) {
      clock = (await row(requested)).nextPollAt!;
      const { request } = await advance(requested);
      delays.push((request.nextPollAt!.getTime() - clock.getTime()) / MINUTE);
      expect(request.attempts).toBe(i + 1);
    }

    expect(delays).toEqual([1, 2, 5, 10, 15, 15]);
  });

  it('429 beim Status: Fehler geht an den Job, der Auftrag bleibt unverändert', async () => {
    const requested = await requestedRow();
    const throttled = new AmazonAdsHttpError('HTTP 429', 'reports.get', 429, null, null, 120_000);
    fake.getStatus = () => Promise.reject(throttled);
    advanceClock(MINUTE);

    await expect(advance(requested)).rejects.toBe(throttled);

    expect(await row(requested)).toEqual(requested);
  });

  it('abgelehnter Refresh-Token geht an den Job', async () => {
    const requested = await requestedRow();
    const reauth = new AmazonAdsReauthRequiredError('lwa.refresh', 400, null);
    fake.getStatus = () => Promise.reject(reauth);

    await expect(advance(requested)).rejects.toBe(reauth);
  });

  it('anderer Fehler beim Status: später erneut, Zeile bleibt requested', async () => {
    const requested = await requestedRow();
    fake.getStatus = () => Promise.reject(new Error('Netzwerk weg'));

    const { request } = await advance(requested);

    expect(request).toMatchObject({
      status: 'requested',
      attempts: 1,
      errorCount: 1,
      nextPollAt: at(2 * MINUTE),
    });
  });

  it('nach langem Ausfall scheitert ein Auftrag nicht am ersten vorübergehenden Fehler', async () => {
    const requested = await requestedRow();
    advanceClock(5 * HOUR);
    fake.getStatus = () => Promise.reject(new Error('Netzwerk weg'));

    const { request } = await advance(requested);

    expect(request).toMatchObject({ status: 'requested', errorCount: 1 });
  });

  it('scheitert nach zu vielen vorübergehenden Fehlern in Folge; eine Antwort setzt sie zurück', async () => {
    const requested = await requestedRow();
    fake.getStatus = () => Promise.reject(new Error('Netzwerk weg'));
    for (let i = 1; i < MAX_CONSECUTIVE_ERRORS; i += 1) {
      const { request } = await advance(requested);
      expect(request).toMatchObject({ status: 'requested', errorCount: i });
    }
    fake.getStatus = () => Promise.resolve({ status: 'PROCESSING' });
    expect((await advance(requested)).request.errorCount).toBe(0);

    fake.getStatus = () => Promise.reject(new Error('Netzwerk weg'));
    for (let i = 1; i < MAX_CONSECUTIVE_ERRORS; i += 1) await advance(requested);
    const { request, counters } = await advance(requested);

    expect(request.status).toBe('failed');
    expect(request.failureReason).toMatch(/Netzwerk weg/);
    expect(counters).toEqual({ failed: 1 });
  });

  it('Amazon verweigert die Abfrage (4xx): Auftrag scheitert sofort', async () => {
    const requested = await requestedRow();
    fake.getStatus = () =>
      Promise.reject(new AmazonAdsHttpError('HTTP 403', 'reports.get', 403, null, null));

    const { request } = await advance(requested);

    expect(request).toMatchObject({
      status: 'failed',
      failureReason: expect.stringMatching(/403/) as unknown,
    });
  });

  it('FAILURE: Auftrag scheitert mit gekürztem Grund ohne URLs', async () => {
    const requested = await requestedRow();
    fake.getStatus = () =>
      Promise.resolve({
        status: 'FAILURE',
        failureReason: `Interner Fehler, siehe https://s3.example/geheim?sig=abc ${'x'.repeat(2000)}`,
      });

    const { request, counters } = await advance(requested);

    expect(request.status).toBe('failed');
    expect(request.failureReason).not.toContain('https://');
    expect(request.failureReason).not.toContain('sig=abc');
    expect(request.failureReason!.length).toBeLessThanOrEqual(500);
    expect(counters).toEqual({ failed: 1 });
  });

  it('PENDING nach über 4 Stunden: Auftrag scheitert', async () => {
    const requested = await requestedRow();
    fake.getStatus = () => Promise.resolve({ status: 'PENDING' });
    advanceClock(4 * HOUR + MINUTE);

    const { request } = await advance(requested);

    expect(request.status).toBe('failed');
    expect(request.failureReason).toMatch(/4 h/);
  });

  it('ein lange nicht abgefragter, fertiger Auftrag wird normal abgeholt', async () => {
    const requested = await requestedRow();
    advanceClock(6 * HOUR);

    const { request, counters } = await advance(requested);

    expect(request.status).toBe('imported');
    expect(counters).toEqual({ imported: 1, rows: 2 });
  });

  it('Amazon kennt den Report nicht mehr: neu anfordern', async () => {
    const requested = await requestedRow();
    fake.getStatus = () => Promise.resolve({ status: 'NOT_FOUND' });
    advanceClock(MINUTE);

    const { request, counters } = await advance(requested);

    expect(calls).toEqual(['status:amz-1', 'request:spCampaigns']);
    expect(request).toMatchObject({ status: 'requested', amazonRequestId: 'amz-2', attempts: 0 });
    expect(counters).toEqual({ requested: 1 });
  });
});

// ---------------------------------------------------------------------------
// Laden und Importieren
// ---------------------------------------------------------------------------

describe('Neu anfordern', () => {
  it('fordert höchstens MAX_REQUESTS-mal an, danach scheitert der Auftrag', async () => {
    const requested = await requestedRow();
    fake.getStatus = () => Promise.resolve({ status: 'NOT_FOUND' });

    for (let count = 2; count <= MAX_REQUESTS; count += 1) {
      const { request } = await advance(requested);
      expect(request).toMatchObject({ status: 'requested', requestCount: count });
    }
    const { request, counters } = await advance(requested);

    expect(request.status).toBe('failed');
    expect(request.failureReason).toMatch(/nicht mehr/);
    expect(counters).toEqual({ failed: 1 });
    expect(calls.filter((call) => call.startsWith('request:'))).toHaveLength(MAX_REQUESTS - 1);
  });
});

describe('Laden und Importieren (Reports)', () => {
  it('lädt, validiert und importiert in einer Transaktion, Beträge verlustfrei', async () => {
    const requested = await requestedRow();
    fake.download = () =>
      Promise.resolve({
        status: 'ok',
        body: gzipBody('[{"date":"2026-09-25","campaignId":9007199254740993,"cost":0.10}]'),
      });
    advanceClock(MINUTE);

    const { request, counters } = await advance(requested);

    expect(calls).toEqual(['status:amz-1', 'download:https://s3.example/amz-1', 'import:report']);
    expect(imports).toEqual([
      {
        kind: 'report',
        request: expect.objectContaining({ id: requested.id }) as unknown,
        rows: [{ date: '2026-09-25', campaignId: '9007199254740993', cost: '0.10' }],
        invalidRowCount: 0,
        ranges: [{ startDate: '2026-08-27', endDate: '2026-09-25' }],
      },
    ]);
    expect(request).toMatchObject({
      status: 'imported',
      completedAt: clock,
      importedAt: clock,
      rowCount: 1,
      invalidRowCount: 0,
      nextPollAt: null,
    });
    expect(counters).toEqual({ imported: 1, rows: 1 });
  });

  it('zählt kaputte Zeilen und loggt sie ohne Werte', async () => {
    const requested = await requestedRow();
    fake.download = () =>
      Promise.resolve({
        status: 'ok',
        body: gzipBody(
          '[{"date":"2026-09-25","campaignId":"1","cost":1.5},{"date":"2026-09-24","campaignId":"2","cost":"geheimer-wert-xyz"},{"campaignId":3}]',
        ),
      });

    const { request } = await advance(requested);

    // "geheimer-wert-xyz" ist ein gültiger String; ungültig ist nur die Zeile ohne date/cost.
    expect(request).toMatchObject({ status: 'imported', rowCount: 2, invalidRowCount: 1 });
    expect(imports[0]).toMatchObject({ invalidRowCount: 1 });
    const invalidLogs = logs.filter((entry) => entry.msg === 'amazon_requests.invalid_row');
    expect(invalidLogs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain('geheimer-wert-xyz');
  });

  it('Datei über dem Deckel: Auftrag scheitert mit Hinweis', async () => {
    const requested = await requestedRow();

    const { request, counters } = await advance(requested, { maxDownloadBytes: 10 });

    expect(request.status).toBe('failed');
    expect(request.failureReason).toMatch(/größer/);
    expect(counters).toEqual({ failed: 1 });
    expect(calls).not.toContain('import:report');
  });

  it('abgelaufene URL: holt sie frisch per Status-Abfrage', async () => {
    const requested = await requestedRow();
    let downloads = 0;
    fake.download = () => {
      downloads += 1;
      return Promise.resolve(
        downloads === 1
          ? { status: 'expired' }
          : { status: 'ok', body: gzipBody(JSON.stringify(defaultRows)) },
      );
    };

    const { request } = await advance(requested);

    expect(calls.filter((call) => call.startsWith('status:'))).toHaveLength(2);
    expect(request.status).toBe('imported');
  });

  it('Amazon liefert die Datei nicht mehr: neu anfordern', async () => {
    const requested = await requestedRow();
    fake.download = () => Promise.resolve({ status: 'expired' });

    const { request, counters } = await advance(requested);

    expect(request).toMatchObject({
      status: 'requested',
      amazonRequestId: 'amz-2',
      importAttempts: 0,
      completedAt: null,
    });
    expect(counters).toEqual({ requested: 1 });
  });

  it('ein dreimal scheiternder Import endet als failed, jeder Versuch rollt zurück', async () => {
    const requested = await requestedRow();
    fake.import = async (tx) => {
      await tx.insert(jobRuns).values({ job: 'teilimport' });
      throw new Error('Import kaputt');
    };

    const first = await advance(requested);
    expect(first.request).toMatchObject({
      status: 'completed',
      importAttempts: 1,
      nextPollAt: at(5 * MINUTE),
      failureReason: expect.stringMatching(/Import kaputt/) as unknown,
    });
    expect(first.counters).toEqual({});

    clock = first.request.nextPollAt!;
    const second = await advance(requested);
    expect(second.request).toMatchObject({ status: 'completed', importAttempts: 2 });
    // Jeder Versuch holt die URL frisch.
    expect(calls.filter((call) => call.startsWith('status:'))).toHaveLength(2);

    clock = second.request.nextPollAt!;
    const third = await advance(requested);
    expect(third.request).toMatchObject({ status: 'failed', importAttempts: 3 });
    expect(third.counters).toEqual({ failed: 1 });

    expect(await testDb.db.select().from(jobRuns)).toEqual([]);
  });

  it('ein vorübergehender Fehler beim frischen Holen der URL zählt nicht als Importversuch', async () => {
    const requested = await requestedRow();
    fake.import = () => Promise.reject(new Error('Import kaputt'));
    const first = await advance(requested);
    expect(first.request).toMatchObject({ status: 'completed', importAttempts: 1 });

    clock = first.request.nextPollAt!;
    fake.getStatus = () =>
      Promise.reject(new AmazonAdsHttpError('HTTP 503', 'reports.get', 503, null, null));
    const { request } = await advance(requested);

    expect(request).toMatchObject({ status: 'completed', importAttempts: 1, errorCount: 1 });
    expect(request.nextPollAt!.getTime()).toBeGreaterThan(clock.getTime());
  });

  it('eine Datei, die kein Array ist, zählt als gescheiterter Import', async () => {
    const requested = await requestedRow();
    fake.download = () => Promise.resolve({ status: 'ok', body: gzipBody('{"rows":[]}') });

    const { request } = await advance(requested);

    expect(request).toMatchObject({ status: 'completed', importAttempts: 1 });
  });
});

describe('Reihenfolge', () => {
  async function importedNewer(range: { startDate: string; endDate: string }) {
    const newer = await pendingRow(range);
    await updateAmazonRequest(testDb.db, newer, {
      status: 'imported',
      requestedAt: new Date(clock.getTime() + HOUR),
    });
  }

  it('ein vollständig überholter Auftrag endet ohne Download als imported (superseded)', async () => {
    const requested = await requestedRow();
    await importedNewer({ startDate: '2026-08-27', endDate: '2026-09-26' });

    const { request, counters } = await advance(requested);

    expect(calls).toEqual(['status:amz-1']);
    expect(request).toMatchObject({ status: 'imported', rowCount: 0 });
    expect(counters).toEqual({ imported: 1, superseded: 1 });
  });

  it('ein teilweise überholter Auftrag importiert nur die übrigen Tage', async () => {
    const requested = await requestedRow();
    await importedNewer({ startDate: '2026-08-28', endDate: '2026-09-26' });

    await advance(requested);

    expect(imports[0]).toMatchObject({
      ranges: [{ startDate: '2026-08-27', endDate: '2026-08-27' }],
    });
  });
});

// ---------------------------------------------------------------------------
// Exports (je Batch)
// ---------------------------------------------------------------------------

describe('Exports je Batch', () => {
  async function submitBatch() {
    const { requests } = await submitAmazonExportBatch(
      deps(),
      batchInput(['campaigns', 'adGroups']),
    );
    const campaigns = requests.find((request) => request.reportType === 'campaigns')!;
    const adGroups = requests.find((request) => request.reportType === 'adGroups')!;
    calls = [];
    return { batchId: campaigns.batchId!, campaigns, adGroups };
  }

  const dueRows = () =>
    listDueAmazonRequests(testDb.db, { organizationId, connectionId, now: clock, limit: 10 });

  it('fordert alle Exports eines neuen Batches an, aber keinen zweiten Batch daneben', async () => {
    const first = await submitAmazonExportBatch(deps(), batchInput(['campaigns', 'adGroups']));

    expect(first.requests.map((request) => request.status)).toEqual(['requested', 'requested']);
    expect(first.counters).toEqual({ requested: 2 });
    expect(calls.filter((call) => call.startsWith('request:')).sort()).toEqual([
      'request:adGroups',
      'request:campaigns',
    ]);

    calls = [];
    const second = await submitAmazonExportBatch(deps(), batchInput(['campaigns', 'adGroups']));

    expect(second.counters).toEqual({});
    expect(second.requests.map((request) => request.id).sort()).toEqual(
      first.requests.map((request) => request.id).sort(),
    );
    expect(calls).toEqual([]);
  });

  it('lehnt Amazon einen Export ab (4xx), scheitert der ganze Batch', async () => {
    fake.request = (request) =>
      request.reportType === 'adGroups'
        ? Promise.reject(new AmazonAdsHttpError('HTTP 400', 'exports.request', 400, null, null))
        : Promise.resolve({ status: 'requested', amazonRequestId: `amz-${++requestCounter}` });

    const { requests, counters } = await submitAmazonExportBatch(
      deps(),
      batchInput(['campaigns', 'adGroups', 'targets']),
    );

    expect(requests.map((request) => request.status)).toEqual(['failed', 'failed', 'failed']);
    expect(counters).toEqual({ requested: 1, failed: 3 });
    expect(calls).not.toContain('request:targets');
  });

  it('429 beim Laden des Batches: der zuletzt fertige Export bleibt fällig', async () => {
    const { campaigns, adGroups } = await submitBatch();
    await advance(campaigns);
    const throttled = new AmazonAdsHttpError('HTTP 429', 'exports.get', 429, null, null, 120_000);
    let statusCalls = 0;
    fake.getStatus = (request) => {
      statusCalls += 1;
      // Erst die Abfrage des auslösenden Exports, dann die frische URL der Geschwister: gedrosselt.
      return statusCalls === 1
        ? Promise.resolve({
            status: 'COMPLETED',
            url: `https://s3.example/${request.amazonRequestId}`,
          })
        : Promise.reject(throttled);
    };

    await expect(advance(adGroups)).rejects.toBe(throttled);

    expect((await dueRows()).map((row) => row.id)).toEqual([adGroups.id]);
    fake = defaultFake();
    const { counters } = await advance(adGroups);
    expect(counters).toEqual({ imported: 2, rows: 4 });
  });

  it('wartet, bis alle Exports fertig sind, und importiert sie gemeinsam', async () => {
    const { batchId, campaigns, adGroups } = await submitBatch();
    fake.getStatus = (request) =>
      Promise.resolve(
        request.reportType === 'campaigns'
          ? { status: 'COMPLETED', url: `https://s3.example/${request.amazonRequestId}` }
          : { status: 'PROCESSING' },
      );

    const first = await advance(campaigns);
    expect(first.request).toMatchObject({ status: 'completed', nextPollAt: null });
    await advance(adGroups);
    expect(imports).toEqual([]);

    fake = defaultFake();
    clock = (await row(adGroups)).nextPollAt!;
    const last = await advance(adGroups);

    expect(imports).toEqual([
      {
        kind: 'export',
        batchId,
        // Reihenfolge der Dateien ist Sache des Imports (Hierarchie, 1.7).
        files: expect.arrayContaining([
          expect.objectContaining({
            request: expect.objectContaining({ id: campaigns.id }) as unknown,
            invalidRowCount: 0,
          }),
          expect.objectContaining({
            request: expect.objectContaining({ id: adGroups.id }) as unknown,
            invalidRowCount: 0,
          }),
        ]) as unknown,
      },
    ]);
    expect(last.counters).toEqual({ imported: 2, rows: 4 });
    expect(await row(campaigns)).toMatchObject({ status: 'imported', rowCount: 2 });
    expect(await row(adGroups)).toMatchObject({ status: 'imported', rowCount: 2 });
  });

  it('FAILURE eines Exports lässt den ganzen Batch scheitern', async () => {
    const { campaigns, adGroups } = await submitBatch();
    fake.getStatus = () => Promise.resolve({ status: 'FAILURE', failureReason: 'kaputt' });

    const { counters } = await advance(campaigns);

    expect(counters).toEqual({ failed: 2 });
    expect(await row(campaigns)).toMatchObject({ status: 'failed', failureReason: 'kaputt' });
    expect(await row(adGroups)).toMatchObject({
      status: 'failed',
      failureReason: expect.stringMatching(/Batch/) as unknown,
    });
  });

  it('eine nicht mehr verfügbare Datei fordert nicht einzeln neu an, sondern lässt den Batch scheitern', async () => {
    const { campaigns, adGroups } = await submitBatch();
    fake.download = () => Promise.resolve({ status: 'expired' });

    await advance(campaigns);
    await advance(adGroups);

    expect(calls.filter((call) => call.startsWith('request:'))).toEqual([]);
    expect((await row(campaigns)).status).toBe('failed');
    expect((await row(adGroups)).status).toBe('failed');
  });

  it('Importversuche zählen je Batch, nach dem dritten scheitert der Batch', async () => {
    const { campaigns, adGroups } = await submitBatch();
    fake.import = () => Promise.reject(new Error('Import kaputt'));
    const due = dueRows;

    await advance(campaigns);
    const afterFirst = await advance(adGroups);
    expect(afterFirst.counters).toEqual({});
    expect(await row(campaigns)).toMatchObject({ status: 'completed', importAttempts: 1 });
    expect(await row(adGroups)).toMatchObject({ status: 'completed', importAttempts: 1 });

    // Nur ein Auftrag des Batches wird wieder fällig; ein Lauf versucht den Import also nur einmal.
    clock = at(5 * MINUTE);
    const dueAfterFirst = await due();
    expect(dueAfterFirst).toHaveLength(1);
    await advance(dueAfterFirst[0]!);
    expect(await row(campaigns)).toMatchObject({ status: 'completed', importAttempts: 2 });
    expect(await row(adGroups)).toMatchObject({ status: 'completed', importAttempts: 2 });

    clock = at(10 * MINUTE);
    const dueAfterSecond = await due();
    expect(dueAfterSecond).toHaveLength(1);
    const third = await advance(dueAfterSecond[0]!);

    expect(third.counters).toEqual({ failed: 2 });
    expect(await row(campaigns)).toMatchObject({ status: 'failed', importAttempts: 3 });
    expect(await row(adGroups)).toMatchObject({ status: 'failed', importAttempts: 3 });
    expect(await due()).toEqual([]);
  });
});

describe('abgeschlossene Aufträge', () => {
  it('bleiben unverändert', async () => {
    const requested = await requestedRow();
    await advance(requested);
    calls = [];

    const { request, counters } = await advance(requested);

    expect(request.status).toBe('imported');
    expect(counters).toEqual({});
    expect(calls).toEqual([]);
  });
});
