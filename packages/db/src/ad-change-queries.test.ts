import type { AdChangeChannel, AdChangeInput } from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import { recordAdChangeResults } from './ad-change-processing';
import {
  getBulkFileSubmissionRows,
  listAdChangeHistory,
  listOpenAdChanges,
  listSubmissionConnections,
} from './ad-change-queries';
import { AdChangeError, stageAdChanges, submitAdChanges } from './ad-changes';
import {
  adChangeSubmissions,
  adChanges,
  amazonAdsCampaigns,
  amazonAdsPortfolios,
  amazonAdsProfiles,
} from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

/** Lesen für API und Oberfläche (`phase-3.md` 3.4): offene Änderungen je Entity, Verlauf, Zeilen der Bulk-Datei. */

let testDb: TestDatabase;
let f: AdChangeFixture;
let other: AdChangeFixture;
const NOW = new Date('2026-10-08T12:00:00Z');
const ada = () => ({ userId: f.ada, orgId: f.org });
const emil = () => ({ userId: f.emil, orgId: f.org });

const update = (
  entityType: Extract<AdChangeInput, { operation: 'update' }>['entityType'],
  entityId: string,
  field: Extract<AdChangeInput, { operation: 'update' }>['field'],
  value: string,
): AdChangeInput => ({ operation: 'update', entityType, entityId, field, value });

async function stage(actor: { userId: string; orgId: string }, changes: AdChangeInput[]) {
  const staged = await stageAdChanges(testDb.db, { ...actor, origin: 'explorer', changes });
  return staged!.results.map((result) => ('changeId' in result ? result.changeId : 'abgelehnt'));
}

async function submit(changes: AdChangeInput[], channel: AdChangeChannel = 'api') {
  const changeIds = await stage(ada(), changes);
  const result = await submitAdChanges(testDb.db, { ...ada(), channel, enqueue: async () => {} });
  return { submissionId: result!.submissions[0]!.id, changeIds };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  f = await seedAdChangeFixture(testDb.db, 'muuv');
  other = await seedAdChangeFixture(testDb.db, 'andere');
});

beforeEach(async () => {
  await testDb.db.delete(adChanges);
  await testDb.db.delete(adChangeSubmissions);
  await testDb.db.update(amazonAdsProfiles).set({ isHidden: false });
});

afterAll(async () => {
  await testDb?.close();
});

describe('listOpenAdChanges', () => {
  it('nennt vorgemerkte Änderungen aller Nutzer und übermittelte ohne Ergebnis', async () => {
    const done = await submit([update('ad_group', f.adGroup, 'default_bid', '0.47')]);
    await recordAdChangeResults(testDb.db, {
      organizationId: f.org,
      submissionId: done.submissionId,
      now: NOW,
      results: [{ changeId: done.changeIds[0]!, outcome: 'applied', amazonEntityId: null }],
    });
    const submitted = await submit([update('target', f.keyword, 'bid', '0.75')]);
    const [mine] = await stage(ada(), [update('campaign', f.campaign, 'budget', '25')]);
    const [theirs] = await stage(emil(), [update('campaign', f.campaign, 'budget', '30')]);

    const open = await listOpenAdChanges(testDb.db, ada());

    const byId = new Map(open!.map((change) => [change.id, change]));
    expect(byId.get(submitted.changeIds[0]!)).toMatchObject({
      status: 'submitted',
      channel: 'api',
      entityType: 'target',
      entityId: f.keyword,
      campaignId: f.campaign,
      field: 'bid',
      after: '0.75',
      mine: true,
      userName: 'Ada',
    });
    expect(byId.get(mine!)).toMatchObject({ status: 'pending', channel: null, mine: true });
    expect(byId.get(theirs!)).toMatchObject({
      status: 'pending',
      after: '30',
      mine: false,
      userName: 'Emil',
    });
    // Die angewendete Änderung fehlt.
    expect(open).toHaveLength(3);
  });

  it('zeigt nur sichtbare Profile und null für Nicht-Mitglieder', async () => {
    await submit([update('target', f.keyword, 'bid', '0.75')]);
    expect(await listOpenAdChanges(testDb.db, { userId: other.ada, orgId: other.org })).toEqual([]);
    expect(await listOpenAdChanges(testDb.db, { userId: f.ada, orgId: other.org })).toBeNull();
    await testDb.db.update(amazonAdsProfiles).set({ isHidden: true });
    expect(await listOpenAdChanges(testDb.db, emil())).toEqual([]);
  });
});

describe('listAdChangeHistory', () => {
  it('liefert den Verlauf einer Entity, neueste zuerst, ohne den Warenkorb', async () => {
    const first = await submit([update('target', f.keyword, 'bid', '0.75')]);
    await testDb.db
      .update(adChanges)
      .set({ createdAt: new Date('2026-10-01T00:00:00Z') })
      .where(eq(adChanges.id, first.changeIds[0]!));
    const second = await submit([
      update('target', f.keyword, 'state', 'PAUSED'),
      update('campaign', f.campaign, 'budget', '25'),
    ]);
    await stage(ada(), [update('target', f.keyword, 'bid', '0.99')]);

    const history = await listAdChangeHistory(testDb.db, {
      ...ada(),
      entityType: 'target',
      entityId: f.keyword,
    });

    expect(history!.map((change) => change.id)).toEqual([second.changeIds[0], first.changeIds[0]]);
    expect(history![0]).toMatchObject({
      field: 'state',
      after: 'PAUSED',
      status: 'submitted',
      submissionId: second.submissionId,
      channel: 'api',
      createdByName: 'Ada',
    });
  });

  it('filtert nach Profil, begrenzt die Länge und sieht nichts Fremdes', async () => {
    await submit([update('target', f.keyword, 'bid', '0.75')]);
    await submit([update('target', f.fileKeyword, 'bid', '0.75')], 'bulk_file');

    const all = await listAdChangeHistory(testDb.db, ada());
    expect(all).toHaveLength(2);
    expect(await listAdChangeHistory(testDb.db, { ...ada(), limit: 1 })).toHaveLength(1);
    const file = await listAdChangeHistory(testDb.db, { ...ada(), profileId: f.fileProfile });
    expect(file).toHaveLength(1);
    expect(file![0]).toMatchObject({ channel: 'bulk_file', profileId: f.fileProfile });
    expect(
      await listAdChangeHistory(testDb.db, {
        userId: other.ada,
        orgId: other.org,
        entityType: 'target',
        entityId: f.keyword,
      }),
    ).toEqual([]);
    expect(await listAdChangeHistory(testDb.db, { userId: f.ada, orgId: other.org })).toBeNull();
  });
});

describe('getBulkFileSubmissionRows', () => {
  it('liefert die Änderungen mit Amazon-IDs und dem Stand der Kampagne für die Datei', async () => {
    const [portfolio] = await testDb.db
      .insert(amazonAdsPortfolios)
      .values({
        organizationId: f.org,
        profileId: f.fileProfile,
        amazonPortfolioId: '7001',
        name: 'Portfolio',
        state: 'ENABLED',
      })
      .onConflictDoNothing()
      .returning({ id: amazonAdsPortfolios.id });
    if (portfolio) {
      await testDb.db
        .update(amazonAdsCampaigns)
        .set({ portfolioId: portfolio.id, endDate: '2026-12-31' })
        .where(eq(amazonAdsCampaigns.id, f.fileCampaign));
    }
    const { submissionId, changeIds } = await submit(
      [
        update('campaign', f.fileCampaign, 'budget', '25'),
        update('target', f.fileKeyword, 'bid', '0.75'),
      ],
      'bulk_file',
    );
    // Fehlgeschlagene (beim Erzeugen übersprungene) Änderungen stehen nicht in der Datei.
    await recordAdChangeResults(testDb.db, {
      organizationId: f.org,
      submissionId,
      now: NOW,
      results: [{ changeId: changeIds[1]!, outcome: 'failed', code: 'X', message: 'x' }],
    });

    const result = await getBulkFileSubmissionRows(testDb.db, { ...emil(), submissionId });

    expect(result!.submission).toMatchObject({ id: submissionId, channel: 'bulk_file' });
    expect(result!.rows).toHaveLength(1);
    expect(result!.rows[0]).toMatchObject({
      id: changeIds[0],
      entityType: 'campaign',
      field: 'budget',
      after: '25',
      amazonCampaignId: '9001',
      amazonEntityId: '9001',
      campaignAmazonPortfolioId: '7001',
      campaignEndDate: '2026-12-31',
      campaignState: 'ENABLED',
    });
  });

  it('gilt nur für Übermittlungen per Bulk-Datei in sichtbaren Profilen', async () => {
    const api = await submit([update('target', f.keyword, 'bid', '0.75')]);
    await expect(
      getBulkFileSubmissionRows(testDb.db, { ...ada(), submissionId: api.submissionId }),
    ).rejects.toBeInstanceOf(AdChangeError);
    const bulk = await submit([update('target', f.fileKeyword, 'bid', '0.75')], 'bulk_file');
    expect(
      await getBulkFileSubmissionRows(testDb.db, {
        userId: other.ada,
        orgId: other.org,
        submissionId: bulk.submissionId,
      }),
    ).toBeNull();
  });
});

describe('listSubmissionConnections', () => {
  it('nennt je Übermittlung die Connection des Profils', async () => {
    const api = await submit([update('target', f.keyword, 'bid', '0.75')]);
    const bulk = await submit([update('target', f.fileKeyword, 'bid', '0.75')], 'bulk_file');
    expect(
      await listSubmissionConnections(testDb.db, [api.submissionId, bulk.submissionId]),
    ).toEqual([{ organizationId: f.org, connectionId: f.connection }]);
  });
});
