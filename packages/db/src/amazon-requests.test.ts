import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAmazonExportBatch,
  countFailedAmazonRequestsSince,
  countRunningExports,
  createAmazonRequest,
  deleteFinishedAmazonRequestsBefore,
  findAmazonRequest,
  listAmazonRequestBatch,
  listConnectionsWithDueAmazonRequests,
  listDueAmazonRequests,
  listNewerImportedReportRanges,
  listReportRanges,
  nextAmazonRequestPollAt,
  updateAmazonRequest,
  type NewAmazonRequest,
} from './amazon-requests';
import { amazonAdsProfiles, amazonAdsReportRequests, connections, organizations } from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let organizationId = '';
let otherOrganizationId = '';
let connectionId = '';
let otherConnectionId = '';
let profileId = '';
let secondProfileId = '';
let otherConnectionProfileId = '';
let foreignProfileId = '';

const now = new Date('2026-09-27T06:00:00Z');
const minutes = (n: number) => new Date(now.getTime() + n * 60_000);

async function createOrganization(slug: string): Promise<string> {
  const [org] = await testDb.db
    .insert(organizations)
    .values({ name: slug, slug, type: 'internal', createdAt: new Date() })
    .returning({ id: organizations.id });
  if (!org) throw new Error('Organisation fehlt');
  return org.id;
}

async function createConnection(orgId: string, externalAccountId: string): Promise<string> {
  const [row] = await testDb.db
    .insert(connections)
    .values({
      organizationId: orgId,
      provider: 'amazon_ads',
      region: 'eu',
      externalAccountId,
      refreshTokenEncrypted: 'verschlüsselt',
    })
    .returning({ id: connections.id });
  if (!row) throw new Error('Connection fehlt');
  return row.id;
}

async function createProfile(orgId: string, connId: string, amazonProfileId: string) {
  const [row] = await testDb.db
    .insert(amazonAdsProfiles)
    .values({
      organizationId: orgId,
      connectionId: connId,
      amazonProfileId,
      accountName: `Konto ${amazonProfileId}`,
      countryCode: 'DE',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      accountType: 'seller',
    })
    .returning({ id: amazonAdsProfiles.id });
  if (!row) throw new Error('Profil fehlt');
  return row.id;
}

const report = (overrides: Partial<NewAmazonRequest> = {}): NewAmazonRequest => ({
  organizationId,
  profileId,
  kind: 'report',
  adProduct: 'SPONSORED_PRODUCTS',
  reportType: 'spCampaigns',
  startDate: '2026-08-27',
  endDate: '2026-09-25',
  batchId: null,
  now,
  ...overrides,
});

const exportRequest = (overrides: Partial<NewAmazonRequest> = {}): NewAmazonRequest => ({
  organizationId,
  profileId,
  kind: 'export',
  adProduct: 'SPONSORED_PRODUCTS',
  reportType: 'campaigns',
  startDate: null,
  endDate: null,
  batchId: randomUUID(),
  now,
  ...overrides,
});

async function create(input: NewAmazonRequest) {
  const result = await createAmazonRequest(testDb.db, input);
  return result.request;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  organizationId = await createOrganization('muuv');
  otherOrganizationId = await createOrganization('andere');
  connectionId = await createConnection(organizationId, 'amzn1.account.A');
  otherConnectionId = await createConnection(organizationId, 'amzn1.account.B');
  const foreignConnectionId = await createConnection(otherOrganizationId, 'amzn1.account.C');
  profileId = await createProfile(organizationId, connectionId, '111');
  secondProfileId = await createProfile(organizationId, connectionId, '222');
  otherConnectionProfileId = await createProfile(organizationId, otherConnectionId, '333');
  foreignProfileId = await createProfile(otherOrganizationId, foreignConnectionId, '444');
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.db.delete(amazonAdsReportRequests);
});

describe('createAmazonRequest', () => {
  it('legt einen Auftrag als pending_request an, fällig sofort', async () => {
    const result = await createAmazonRequest(testDb.db, report());

    expect(result.created).toBe(true);
    expect(result.request).toMatchObject({
      organizationId,
      profileId,
      kind: 'report',
      status: 'pending_request',
      amazonRequestId: null,
      attempts: 0,
      importAttempts: 0,
      errorCount: 0,
      requestCount: 0,
      nextPollAt: now,
      createdAt: now,
      startDate: '2026-08-27',
      endDate: '2026-09-25',
    });
  });

  it('liefert den offenen Auftrag statt eines zweiten mit gleichem Schlüssel', async () => {
    const first = await create(report());

    const second = await createAmazonRequest(testDb.db, report({ now: minutes(5) }));

    expect(second).toEqual({ created: false, request: first });
    expect(await testDb.db.select().from(amazonAdsReportRequests)).toHaveLength(1);
  });

  it('verhindert doppelte offene Exports, obwohl die Daten leer sind (NULLS NOT DISTINCT)', async () => {
    const first = await create(exportRequest());

    const second = await createAmazonRequest(testDb.db, exportRequest());

    expect(second).toEqual({ created: false, request: first });
  });

  it('erlaubt einen neuen Auftrag, sobald der alte importiert oder gescheitert ist', async () => {
    const imported = await create(report());
    await updateAmazonRequest(testDb.db, imported, { status: 'imported', importedAt: now });
    const failed = await create(report());
    await updateAmazonRequest(testDb.db, failed, { status: 'failed' });

    const third = await createAmazonRequest(testDb.db, report());

    expect(third.created).toBe(true);
  });

  it('unterscheidet Aufträge nach Zeitraum, Ad-Typ und Report-Typ', async () => {
    await create(report());
    const results = await Promise.all([
      createAmazonRequest(testDb.db, report({ startDate: '2026-07-27', endDate: '2026-08-26' })),
      createAmazonRequest(testDb.db, report({ adProduct: 'SPONSORED_BRANDS' })),
      createAmazonRequest(testDb.db, report({ reportType: 'spTargeting' })),
      createAmazonRequest(testDb.db, report({ profileId: secondProfileId })),
    ]);
    expect(results.map((result) => result.created)).toEqual([true, true, true, true]);
  });

  it('verbietet ein Profil einer anderen Organisation (zusammengesetzter FK)', async () => {
    await expect(create(report({ profileId: foreignProfileId }))).rejects.toThrow();
  });

  it('verlangt Zeitraum ohne Batch bei Reports und Batch ohne Zeitraum bei Exports', async () => {
    await expect(create(report({ endDate: null }))).rejects.toThrow();
    await expect(
      create(report({ startDate: '2026-09-26', endDate: '2026-09-25' })),
    ).rejects.toThrow();
    await expect(create(report({ batchId: randomUUID() }))).rejects.toThrow();
    await expect(create(exportRequest({ batchId: null }))).rejects.toThrow();
    await expect(create(exportRequest({ startDate: '2026-09-25' }))).rejects.toThrow();
  });
});

describe('createAmazonExportBatch', () => {
  const batchInput = (overrides: { profileId?: string; adProduct?: string } = {}) => ({
    organizationId,
    profileId: overrides.profileId ?? profileId,
    adProduct: overrides.adProduct ?? 'SPONSORED_PRODUCTS',
    exportTypes: ['campaigns', 'adGroups', 'targets', 'ads'],
    now,
  });

  it('legt alle Exports eines Batches auf einmal an', async () => {
    const result = await createAmazonExportBatch(testDb.db, batchInput());

    expect(result.created).toBe(true);
    expect(result.requests.map((row) => row.reportType).sort()).toEqual(
      ['adGroups', 'ads', 'campaigns', 'targets'].sort(),
    );
    expect(new Set(result.requests.map((row) => row.batchId)).size).toBe(1);
    expect(result.requests.every((row) => row.status === 'pending_request')).toBe(true);
  });

  it('legt keinen neuen Batch an, solange ein Export für Profil und Ad-Typ offen ist', async () => {
    const first = await createAmazonExportBatch(testDb.db, batchInput());
    // Drei Exports fertig, einer noch offen: Der neue Batch würde sich sonst mit dem alten mischen.
    for (const row of first.requests.slice(1)) {
      await updateAmazonRequest(testDb.db, row, { status: 'imported' });
    }

    const second = await createAmazonExportBatch(testDb.db, batchInput());

    expect(second.created).toBe(false);
    expect(second.requests.map((row) => row.id)).toEqual([first.requests[0]!.id]);
    expect(await testDb.db.select().from(amazonAdsReportRequests)).toHaveLength(4);
  });

  it('trennt Batches nach Profil und Ad-Typ', async () => {
    await createAmazonExportBatch(testDb.db, batchInput());

    const results = await Promise.all([
      createAmazonExportBatch(testDb.db, batchInput({ adProduct: 'SPONSORED_BRANDS' })),
      createAmazonExportBatch(testDb.db, batchInput({ profileId: secondProfileId })),
    ]);

    expect(results.map((result) => result.created)).toEqual([true, true]);
  });
});

describe('findAmazonRequest und updateAmazonRequest', () => {
  it('lesen und ändern nur im Org-Kontext', async () => {
    const request = await create(report());
    const foreignRef = { organizationId: otherOrganizationId, id: request.id };

    expect(await findAmazonRequest(testDb.db, foreignRef)).toBeNull();
    await expect(updateAmazonRequest(testDb.db, foreignRef, { status: 'failed' })).rejects.toThrow(
      /nicht gefunden/,
    );

    const updated = await updateAmazonRequest(testDb.db, request, {
      status: 'requested',
      amazonRequestId: 'r-1',
      requestedAt: now,
    });
    expect(updated).toMatchObject({ status: 'requested', amazonRequestId: 'r-1' });
    expect(await findAmazonRequest(testDb.db, request)).toEqual(updated);
  });
});

describe('listDueAmazonRequests', () => {
  it('liefert fällige offene Aufträge der Profile dieser Connection, älteste zuerst', async () => {
    const later = await create(report({ now: minutes(-1) }));
    const earlier = await create(report({ profileId: secondProfileId, now: minutes(-10) }));
    const notDue = await create(report({ reportType: 'spTargeting' }));
    await updateAmazonRequest(testDb.db, notDue, { nextPollAt: minutes(1) });
    const waiting = await create(report({ reportType: 'spSearchTerm' }));
    await updateAmazonRequest(testDb.db, waiting, { nextPollAt: null });
    const done = await create(report({ reportType: 'spAdvertisedProduct' }));
    await updateAmazonRequest(testDb.db, done, { status: 'imported' });
    await create(report({ profileId: otherConnectionProfileId }));

    const due = await listDueAmazonRequests(testDb.db, {
      organizationId,
      connectionId,
      now,
      limit: 10,
    });

    expect(due.map((row) => row.id)).toEqual([earlier.id, later.id]);
  });

  it('begrenzt die Menge und bleibt in der Organisation', async () => {
    await create(report({ now: minutes(-2) }));
    await create(report({ reportType: 'spTargeting', now: minutes(-1) }));

    expect(
      await listDueAmazonRequests(testDb.db, { organizationId, connectionId, now, limit: 1 }),
    ).toHaveLength(1);
    expect(
      await listDueAmazonRequests(testDb.db, {
        organizationId: otherOrganizationId,
        connectionId,
        now,
        limit: 10,
      }),
    ).toEqual([]);
  });
});

describe('nextAmazonRequestPollAt', () => {
  it('liefert den frühesten Termin offener Aufträge der Connection, sonst null', async () => {
    expect(await nextAmazonRequestPollAt(testDb.db, { organizationId, connectionId })).toBeNull();

    const soon = await create(report());
    await updateAmazonRequest(testDb.db, soon, { nextPollAt: minutes(5) });
    const sooner = await create(report({ profileId: secondProfileId }));
    await updateAmazonRequest(testDb.db, sooner, { nextPollAt: minutes(2) });
    const waiting = await create(report({ reportType: 'spTargeting' }));
    await updateAmazonRequest(testDb.db, waiting, { nextPollAt: null });
    const done = await create(report({ reportType: 'spSearchTerm' }));
    await updateAmazonRequest(testDb.db, done, { status: 'failed', nextPollAt: minutes(1) });
    await create(report({ profileId: otherConnectionProfileId, now: minutes(-60) }));

    expect(await nextAmazonRequestPollAt(testDb.db, { organizationId, connectionId })).toEqual(
      minutes(2),
    );
    expect(
      await nextAmazonRequestPollAt(testDb.db, {
        organizationId: otherOrganizationId,
        connectionId,
      }),
    ).toBeNull();
  });
});

describe('listConnectionsWithDueAmazonRequests', () => {
  it('liefert aktive Connections mit fälligen offenen Aufträgen, je Connection einmal', async () => {
    await create(report({ now: minutes(-5) }));
    await create(report({ reportType: 'spTargeting', now: minutes(-5) }));
    const notDue = await create(report({ profileId: otherConnectionProfileId }));
    await updateAmazonRequest(testDb.db, notDue, { nextPollAt: minutes(5) });
    await create(report({ profileId: foreignProfileId, organizationId: otherOrganizationId }));

    const due = await listConnectionsWithDueAmazonRequests(testDb.db, now);

    expect(due).toHaveLength(2);
    expect(due).toContainEqual({ id: connectionId, organizationId });
    expect(due).not.toContainEqual(expect.objectContaining({ id: otherConnectionId }));
  });

  it('überspringt Connections, die neu verbunden werden müssen', async () => {
    await create(report({ now: minutes(-5) }));
    await testDb.db
      .update(connections)
      .set({ status: 'reauth_required' })
      .where(eq(connections.id, connectionId));
    try {
      const due = await listConnectionsWithDueAmazonRequests(testDb.db, now);
      expect(due).not.toContainEqual(expect.objectContaining({ id: connectionId }));
    } finally {
      await testDb.db
        .update(connections)
        .set({ status: 'active' })
        .where(eq(connections.id, connectionId));
    }
  });
});

describe('countRunningExports', () => {
  it('zählt angeforderte Exports eines Typs über alle Profile der Connection', async () => {
    for (const [profile, status] of [
      [profileId, 'requested'],
      [secondProfileId, 'requested'],
      [otherConnectionProfileId, 'requested'],
    ] as const) {
      const row = await create(exportRequest({ profileId: profile }));
      await updateAmazonRequest(testDb.db, row, { status });
    }
    await create(exportRequest({ adProduct: 'SPONSORED_BRANDS' }));
    const completed = await create(exportRequest({ adProduct: 'SPONSORED_DISPLAY' }));
    await updateAmazonRequest(testDb.db, completed, { status: 'completed' });
    const otherType = await create(exportRequest({ reportType: 'targets' }));
    await updateAmazonRequest(testDb.db, otherType, { status: 'requested' });

    expect(
      await countRunningExports(testDb.db, {
        organizationId,
        connectionId,
        exportType: 'campaigns',
      }),
    ).toBe(2);
  });
});

describe('listReportRanges', () => {
  it('liefert die Zeiträume der Reports mit gleichem Schlüssel und passendem Status', async () => {
    const imported = await create(report({ startDate: '2026-06-01', endDate: '2026-06-30' }));
    await updateAmazonRequest(testDb.db, imported, { status: 'imported' });
    await create(report({ startDate: '2026-07-01', endDate: '2026-07-31' }));
    const failed = await create(report({ startDate: '2026-08-01', endDate: '2026-08-10' }));
    await updateAmazonRequest(testDb.db, failed, { status: 'failed' });
    await create(report({ reportType: 'spTargeting' }));
    await create(report({ profileId: secondProfileId }));
    await create(report({ adProduct: 'SPONSORED_BRANDS' }));

    const ranges = await listReportRanges(testDb.db, {
      organizationId,
      profileId,
      adProduct: 'SPONSORED_PRODUCTS',
      reportType: 'spCampaigns',
      statuses: ['imported', 'pending_request', 'requested', 'completed'],
    });

    expect(ranges).toEqual([
      { startDate: '2026-06-01', endDate: '2026-06-30' },
      { startDate: '2026-07-01', endDate: '2026-07-31' },
    ]);
  });
});

describe('countFailedAmazonRequestsSince', () => {
  it('zählt Aufträge der Connection, die seit dem Zeitpunkt gescheitert sind', async () => {
    const setUpdatedAt = (id: string, at: Date) =>
      testDb.db
        .update(amazonAdsReportRequests)
        .set({ updatedAt: at })
        .where(eq(amazonAdsReportRequests.id, id));
    const recent = await create(report());
    await updateAmazonRequest(testDb.db, recent, { status: 'failed' });
    await setUpdatedAt(recent.id, minutes(10));
    const recentExport = await create(exportRequest({ profileId: secondProfileId }));
    await updateAmazonRequest(testDb.db, recentExport, { status: 'failed' });
    await setUpdatedAt(recentExport.id, minutes(20));
    const old = await create(report({ reportType: 'spTargeting' }));
    await updateAmazonRequest(testDb.db, old, { status: 'failed' });
    await setUpdatedAt(old.id, minutes(-10));
    const open = await create(report({ reportType: 'spSearchTerm' }));
    await setUpdatedAt(open.id, minutes(10));
    const otherConnection = await create(report({ profileId: otherConnectionProfileId }));
    await updateAmazonRequest(testDb.db, otherConnection, { status: 'failed' });
    await setUpdatedAt(otherConnection.id, minutes(10));

    expect(
      await countFailedAmazonRequestsSince(testDb.db, { organizationId, connectionId, since: now }),
    ).toBe(2);
  });
});

describe('listAmazonRequestBatch', () => {
  it('liefert alle Exports eines Batches der Organisation', async () => {
    const batchId = randomUUID();
    const campaigns = await create(exportRequest({ batchId }));
    const adGroups = await create(exportRequest({ batchId, reportType: 'adGroups' }));
    await create(exportRequest({ reportType: 'targets' }));

    const batch = await listAmazonRequestBatch(testDb.db, { organizationId, batchId });

    expect(batch.map((row) => row.id).sort()).toEqual([campaigns.id, adGroups.id].sort());
    expect(
      await listAmazonRequestBatch(testDb.db, { organizationId: otherOrganizationId, batchId }),
    ).toEqual([]);
  });
});

describe('listNewerImportedReportRanges', () => {
  it('liefert die Zeiträume später angeforderter, importierter Reports mit gleichem Schlüssel', async () => {
    const own = await create(report());
    await updateAmazonRequest(testDb.db, own, { status: 'requested', requestedAt: now });

    const newer = await create(report({ startDate: '2026-08-28', endDate: '2026-09-26' }));
    await updateAmazonRequest(testDb.db, newer, { status: 'imported', requestedAt: minutes(60) });
    const older = await create(report({ startDate: '2026-08-26', endDate: '2026-09-24' }));
    await updateAmazonRequest(testDb.db, older, { status: 'imported', requestedAt: minutes(-60) });
    const newerOpen = await create(report({ startDate: '2026-08-29', endDate: '2026-09-27' }));
    await updateAmazonRequest(testDb.db, newerOpen, {
      status: 'completed',
      requestedAt: minutes(30),
    });
    const newerFailed = await create(report({ startDate: '2026-08-30', endDate: '2026-09-28' }));
    await updateAmazonRequest(testDb.db, newerFailed, {
      status: 'failed',
      requestedAt: minutes(30),
    });
    for (const other of [
      report({ adProduct: 'SPONSORED_BRANDS' }),
      report({ reportType: 'spTargeting' }),
      report({ profileId: secondProfileId }),
    ]) {
      const row = await create(other);
      await updateAmazonRequest(testDb.db, row, { status: 'imported', requestedAt: minutes(60) });
    }

    const ranges = await listNewerImportedReportRanges(testDb.db, {
      ...own,
      requestedAt: now,
    });

    expect(ranges).toEqual([{ startDate: '2026-08-28', endDate: '2026-09-26' }]);
  });
});

describe('deleteFinishedAmazonRequestsBefore', () => {
  it('löscht nur abgeschlossene Aufträge vor dem Stichtag', async () => {
    const cutoff = minutes(0);
    const oldImported = await create(report({ now: minutes(-10) }));
    await updateAmazonRequest(testDb.db, oldImported, { status: 'imported' });
    const oldFailed = await create(report({ reportType: 'spTargeting', now: minutes(-10) }));
    await updateAmazonRequest(testDb.db, oldFailed, { status: 'failed' });
    const oldOpen = await create(report({ reportType: 'spSearchTerm', now: minutes(-10) }));
    const newImported = await create(
      report({ reportType: 'spAdvertisedProduct', now: minutes(1) }),
    );
    await updateAmazonRequest(testDb.db, newImported, { status: 'imported' });

    const deleted = await deleteFinishedAmazonRequestsBefore(testDb.db, cutoff);

    expect(deleted).toBe(2);
    const rest = await testDb.db
      .select({ id: amazonAdsReportRequests.id })
      .from(amazonAdsReportRequests);
    expect(rest.map((row) => row.id).sort()).toEqual([oldOpen.id, newImported.id].sort());
  });
});

describe('Profil löschen', () => {
  it('nimmt die Aufträge des Profils mit (Betriebszustand, keine Historie)', async () => {
    const extra = await createProfile(organizationId, connectionId, '999');
    await create(report({ profileId: extra }));

    await testDb.db.delete(amazonAdsProfiles).where(eq(amazonAdsProfiles.id, extra));

    expect(await testDb.db.select().from(amazonAdsReportRequests)).toEqual([]);
  });
});
