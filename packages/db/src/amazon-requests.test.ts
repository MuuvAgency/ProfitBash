import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAmazonRequest,
  deleteFinishedAmazonRequestsBefore,
  findAmazonRequest,
  listAmazonRequestBatch,
  listDueAmazonRequests,
  listNewerImportedReportRanges,
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
