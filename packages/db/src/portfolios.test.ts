import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import { closeBulkFileSubmission } from './ad-change-actions';
import { confirmBulkFileAdChanges } from './ad-change-processing';
import { listAdChangeSubmissions } from './ad-changes';
import { createPortfolioRequest, listProfilePortfolios, PortfolioError } from './portfolios';
import {
  adChangeSubmissions,
  amazonAdsCampaigns,
  amazonAdsPortfolios,
  amazonAdsProfiles,
  auditEvents,
  campaignSetupItems,
} from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

/**
 * Portfolio anlegen (`phase-4.md` 4.7, F9): Name und optional Budget, als eigene Übermittlung der Art `portfolio`
 * (nur Bulk-Datei, Blatt „Portfolios“); der nächste Import ordnet die echte ID über den Namen zu.
 */

let testDb: TestDatabase;
let f: AdChangeFixture;
let existingPortfolio = '';

const as = (userId: string, orgId = f.org) => ({ userId, orgId });
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof PortfolioError) return err.code;
    throw err;
  }
  return null;
};
const budget = {
  amount: '500.00',
  policy: 'monthlyRecurring',
  startDate: '2099-11-01',
  endDate: null,
} as const;

beforeAll(async () => {
  testDb = await createTestDatabase();
  f = await seedAdChangeFixture(testDb.db);
  const [portfolio] = await testDb.db
    .insert(amazonAdsPortfolios)
    .values({
      organizationId: f.org,
      profileId: f.profile,
      amazonPortfolioId: '7001',
      name: 'Bestand',
      state: 'ENABLED',
      budgetPolicy: 'NO_CAP',
    })
    .returning({ id: amazonAdsPortfolios.id });
  existingPortfolio = portfolio!.id;
  await testDb.db
    .update(amazonAdsCampaigns)
    .set({ portfolioId: existingPortfolio })
    .where(eq(amazonAdsCampaigns.id, f.campaign));
});

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  await testDb.db.delete(campaignSetupItems);
  await testDb.db.delete(adChangeSubmissions);
  await testDb.db.delete(auditEvents);
  await testDb.db
    .delete(amazonAdsPortfolios)
    .where(eq(amazonAdsPortfolios.amazonPortfolioId, '7002'));
  await testDb.db.update(amazonAdsProfiles).set({ isHidden: false });
});

describe('createPortfolioRequest', () => {
  it('legt eine Übermittlung der Art portfolio mit einer Zeile an, mit Audit', async () => {
    const result = await createPortfolioRequest(testDb.db, {
      ...as(f.ada),
      request: { profileId: f.profile, name: 'Garten', budget },
    });
    expect(result!.submission).toMatchObject({
      kind: 'portfolio',
      channel: 'bulk_file',
      status: 'pending',
      profileId: f.profile,
    });
    const items = await testDb.db.select().from(campaignSetupItems);
    expect(items).toEqual([
      expect.objectContaining({
        entityType: 'portfolio',
        draftId: null,
        campaignRef: 'Garten',
        adGroupRef: null,
        status: 'submitted',
        payload: {
          entity: 'portfolio',
          name: 'Garten',
          budget: { ...budget, currencyCode: 'EUR' },
        },
      }),
    ]);
    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'ad_change_submission.create'));
    expect(event!.target).toMatchObject({ kind: 'portfolio', name: 'Garten', items: 1 });
  });

  it('lehnt einen Namen ab, den es im Profil schon gibt oder der schon angelegt wird (ohne Groß/Klein)', async () => {
    expect(
      await code(
        createPortfolioRequest(testDb.db, {
          ...as(f.ada),
          request: { profileId: f.profile, name: 'bestand', budget: null },
        }),
      ),
    ).toBe('NAME_TAKEN');
    await createPortfolioRequest(testDb.db, {
      ...as(f.ada),
      request: { profileId: f.profile, name: 'Garten', budget: null },
    });
    expect(
      await code(
        createPortfolioRequest(testDb.db, {
          ...as(f.emil),
          request: { profileId: f.profile, name: 'GARTEN', budget: null },
        }),
      ),
    ).toBe('NAME_TAKEN');
  });

  it('lehnt ein Budget ab, das vor heute (Zeitzone des Profils) beginnt', async () => {
    expect(
      await code(
        createPortfolioRequest(testDb.db, {
          ...as(f.ada),
          request: {
            profileId: f.profile,
            name: 'Vergangen',
            budget: { ...budget, startDate: '2020-01-01' },
          },
          now: new Date('2026-10-10T10:00:00Z'),
        }),
      ),
    ).toBe('START_IN_PAST');
  });

  it('gibt den Namen frei, wenn die Datei als hochgeladen gilt, der Import das Portfolio aber nicht zeigt', async () => {
    const first = await createPortfolioRequest(testDb.db, {
      ...as(f.ada),
      request: { profileId: f.profile, name: 'Garten', budget: null },
    });
    await closeBulkFileSubmission(testDb.db, {
      ...as(f.ada),
      submissionId: first!.submission.id,
      outcome: 'applied',
    });
    const second = await createPortfolioRequest(testDb.db, {
      ...as(f.ada),
      request: { profileId: f.profile, name: 'Garten', budget: null },
    });
    expect(second!.submission.kind).toBe('portfolio');
  });

  it('kennt nur sichtbare Profile und liefert null für Nicht-Mitglieder', async () => {
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, f.profile));
    expect(
      await code(
        createPortfolioRequest(testDb.db, {
          ...as(f.ada),
          request: { profileId: f.profile, name: 'X', budget: null },
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(
      await createPortfolioRequest(testDb.db, {
        userId: f.ada,
        orgId: '00000000-0000-4000-8000-000000000999',
        request: { profileId: f.profile, name: 'X', budget: null },
      }),
    ).toBeNull();
  });
});

describe('listProfilePortfolios', () => {
  it('zeigt Portfolios des Profils mit Zahl der Kampagnen und offene Anlagen', async () => {
    await createPortfolioRequest(testDb.db, {
      ...as(f.ada),
      request: { profileId: f.profile, name: 'Garten', budget },
    });
    const list = await listProfilePortfolios(testDb.db, { ...as(f.emil), profileId: f.profile });
    expect(list!.portfolios).toEqual([
      expect.objectContaining({
        id: existingPortfolio,
        name: 'Bestand',
        amazonPortfolioId: '7001',
        campaigns: 1,
      }),
    ]);
    expect(list!.pending).toEqual([
      expect.objectContaining({
        name: 'Garten',
        status: 'submitted',
        budget: { ...budget, currencyCode: 'EUR' },
      }),
    ]);
  });
});

describe('Bestätigung durch den Bulk-Import', () => {
  it('ordnet das neue Portfolio über den Namen zu und schließt die Übermittlung', async () => {
    const result = await createPortfolioRequest(testDb.db, {
      ...as(f.ada),
      request: { profileId: f.profile, name: 'Garten', budget: null },
    });
    await testDb.db.insert(amazonAdsPortfolios).values({
      organizationId: f.org,
      profileId: f.profile,
      amazonPortfolioId: '7002',
      name: 'garten',
      state: 'ENABLED',
    });
    await confirmBulkFileAdChanges(testDb.db, {
      organizationId: f.org,
      profileId: f.profile,
      now: new Date(),
    });
    const [item] = await testDb.db.select().from(campaignSetupItems);
    expect(item).toMatchObject({ status: 'applied', amazonEntityId: '7002' });
    const [listed] = (await listAdChangeSubmissions(testDb.db, as(f.ada)))!;
    expect(listed).toMatchObject({
      id: result!.submission.id,
      kind: 'portfolio',
      status: 'finished',
    });
    const list = await listProfilePortfolios(testDb.db, { ...as(f.ada), profileId: f.profile });
    expect(list!.pending).toEqual([]);
  });

  it('lässt sich von Hand als hochgeladen abschließen und trägt die ID später nach', async () => {
    const result = await createPortfolioRequest(testDb.db, {
      ...as(f.ada),
      request: { profileId: f.profile, name: 'Garten', budget: null },
    });
    await closeBulkFileSubmission(testDb.db, {
      ...as(f.ada),
      submissionId: result!.submission.id,
      outcome: 'applied',
    });
    const list = await listProfilePortfolios(testDb.db, { ...as(f.ada), profileId: f.profile });
    expect(list!.pending).toEqual([expect.objectContaining({ name: 'Garten', status: 'applied' })]);
    await testDb.db.insert(amazonAdsPortfolios).values({
      organizationId: f.org,
      profileId: f.profile,
      amazonPortfolioId: '7002',
      name: 'Garten',
    });
    await confirmBulkFileAdChanges(testDb.db, {
      organizationId: f.org,
      profileId: f.profile,
      now: new Date(),
    });
    const [item] = await testDb.db.select().from(campaignSetupItems);
    expect(item).toMatchObject({ status: 'applied', amazonEntityId: '7002' });
  });
});
