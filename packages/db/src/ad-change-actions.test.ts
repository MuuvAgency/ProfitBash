import type { AdChangeChannel, AdChangeInput } from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeBulkFileSubmission,
  dismissFailedAdChanges,
  retryAdChanges,
  revertAdChanges,
} from './ad-change-actions';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import { recordAdChangeResults } from './ad-change-processing';
import {
  AdChangeError,
  getAdChangeSubmission,
  stageAdChanges,
  submitAdChanges,
  type AdChangeSubmissionSummary,
} from './ad-changes';
import {
  adChangeSubmissions,
  adChanges,
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsProfiles,
  amazonAdsTargets,
  auditEvents,
} from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

/** Erneut versuchen, verwerfen, Revert und Abschließen von Hand (`phase-3.md` 3.3, F8). */

let testDb: TestDatabase;
let f: AdChangeFixture;
let other: AdChangeFixture;
const NOW = new Date('2026-10-08T12:00:00Z');
const enqueued: AdChangeSubmissionSummary[][] = [];
const enqueue = (_tx: unknown, submissions: readonly AdChangeSubmissionSummary[]) => {
  enqueued.push([...submissions]);
  return Promise.resolve();
};
const ada = () => ({ userId: f.ada, orgId: f.org });
const emil = () => ({ userId: f.emil, orgId: f.org });

const update = (
  entityType: Extract<AdChangeInput, { operation: 'update' }>['entityType'],
  entityId: string,
  field: Extract<AdChangeInput, { operation: 'update' }>['field'],
  value: string,
): AdChangeInput => ({ operation: 'update', entityType, entityId, field, value });

const negative = (keywordText: string): AdChangeInput => ({
  operation: 'create_negative',
  campaignId: f.campaign,
  adGroupId: f.adGroup,
  negative: { type: 'keyword', keywordText, matchType: 'EXACT' },
});

async function submit(changes: AdChangeInput[], channel: AdChangeChannel = 'api') {
  const staged = await stageAdChanges(testDb.db, { ...ada(), origin: 'explorer', changes });
  const changeIds = staged!.results.map((result) =>
    'changeId' in result ? result.changeId : 'abgelehnt',
  );
  const result = await submitAdChanges(testDb.db, { ...ada(), channel, enqueue: async () => {} });
  return { submissionId: result!.submissions[0]!.id, changeIds };
}

/** Übermittelt über die API und hält das Ergebnis fest: Erfolg (Entities nachgezogen) oder Fehler. */
async function processed(changes: AdChangeInput[], failed: number[] = []) {
  const { submissionId, changeIds } = await submit(changes);
  await recordAdChangeResults(testDb.db, {
    organizationId: f.org,
    submissionId,
    now: NOW,
    results: changeIds.map((changeId, index) =>
      failed.includes(index)
        ? { changeId, outcome: 'failed', code: 'BID_TOO_LOW', message: 'Gebot zu niedrig.' }
        : { changeId, outcome: 'applied', amazonEntityId: '880000000001' },
    ),
  });
  return { submissionId, changeIds };
}

async function changeRow(id: string) {
  const [row] = await testDb.db.select().from(adChanges).where(eq(adChanges.id, id));
  return row!;
}

async function changesOf(submissionId: string) {
  return testDb.db.select().from(adChanges).where(eq(adChanges.submissionId, submissionId));
}

async function auditActions() {
  const rows = await testDb.db.select({ action: auditEvents.action }).from(auditEvents);
  return rows.map((row) => row.action);
}

const setBid = (id: string, bid: string | null) =>
  testDb.db.update(amazonAdsTargets).set({ bid }).where(eq(amazonAdsTargets.id, id));

beforeAll(async () => {
  testDb = await createTestDatabase();
  f = await seedAdChangeFixture(testDb.db, 'muuv');
  other = await seedAdChangeFixture(testDb.db, 'andere');
});

beforeEach(async () => {
  const { db } = testDb;
  await db.delete(adChanges);
  await db.delete(adChangeSubmissions);
  await db.delete(auditEvents);
  await db.update(amazonAdsProfiles).set({ isHidden: false });
  await db.update(amazonAdsTargets).set({ state: 'ENABLED', removedAt: null, bid: '0.50' });
  await db
    .update(amazonAdsTargets)
    .set({ bid: null, bidCurrencyCode: null })
    .where(eq(amazonAdsTargets.id, f.productTarget));
  await db.update(amazonAdsCampaigns).set({
    state: 'ENABLED',
    budgetAmount: '20',
    biddingStrategy: 'SALES_DOWN_ONLY',
    extra: { placementBidAdjustments: [{ placement: 'PLACEMENT_TOP', percentage: '50' }] },
  });
  await db.update(amazonAdsAdGroups).set({ state: 'ENABLED', defaultBid: '0.40' });
  await db
    .delete(amazonAdsNegativeTargets)
    .where(eq(amazonAdsNegativeTargets.amazonTargetId, '880000000001'));
  await db.update(amazonAdsNegativeTargets).set({ state: 'ENABLED', removedAt: null });
  enqueued.length = 0;
});

afterAll(async () => {
  await testDb?.close();
});

describe('retryAdChanges', () => {
  it('legt für eine fehlgeschlagene Änderung eine neue mit Verweis an und übermittelt sie', async () => {
    const first = await processed([update('target', f.keyword, 'bid', '0.75')], [0]);
    // Der Stand hat sich seit dem Fehlschlag geändert: „vorher“ wird neu gelesen.
    await setBid(f.keyword, '0.55');
    await testDb.db.delete(auditEvents);

    const result = await retryAdChanges(testDb.db, {
      ...emil(),
      changeIds: first.changeIds,
      channel: 'api',
      enqueue,
    });

    expect(result!.skipped).toEqual([]);
    expect(result!.submissions).toHaveLength(1);
    expect(result!.submissions[0]).toMatchObject({
      profileId: f.profile,
      channel: 'api',
      status: 'pending',
      createdBy: f.emil,
      changes: 1,
    });
    const [retry] = await changesOf(result!.submissions[0]!.id);
    expect(retry).toMatchObject({
      status: 'submitted',
      origin: 'retry',
      originChangeId: first.changeIds[0],
      entityType: 'target',
      entityId: f.keyword,
      field: 'bid',
      oldAmount: '0.55',
      newAmount: '0.75',
      currencyCode: 'EUR',
      createdBy: f.emil,
    });
    expect(await changeRow(first.changeIds[0]!)).toMatchObject({ status: 'failed' });
    expect(enqueued).toHaveLength(1);
    expect(await auditActions()).toEqual(['ad_change_submission.create']);
  });

  it('überspringt, was sich nicht wiederholen lässt, mit Grund', async () => {
    const { changeIds } = await processed(
      [
        update('target', f.keyword, 'bid', '0.75'),
        update('campaign', f.campaign, 'budget', '25'),
        update('ad_group', f.adGroup, 'default_bid', '0.45'),
      ],
      [1, 2],
    );
    // Das Budget steht inzwischen auf dem gewünschten Wert (unklarer Ausgang, der doch gewirkt hat).
    await testDb.db
      .update(amazonAdsCampaigns)
      .set({ budgetAmount: '25.0' })
      .where(eq(amazonAdsCampaigns.id, f.campaign));
    const foreign = await testDb.db
      .select({ id: adChanges.id })
      .from(adChanges)
      .where(eq(adChanges.organizationId, other.org));
    expect(foreign).toEqual([]);

    const again = () =>
      retryAdChanges(testDb.db, {
        ...ada(),
        changeIds: [...changeIds, '00000000-0000-4000-8000-00000000dead'],
        channel: 'api',
        enqueue,
      });
    const result = await again();

    expect(result!.submissions).toHaveLength(1);
    expect(result!.skipped).toEqual(
      expect.arrayContaining([
        { changeId: changeIds[0], reason: 'notFailed' },
        { changeId: changeIds[1], reason: 'nothingToChange' },
        { changeId: '00000000-0000-4000-8000-00000000dead', reason: 'notFound' },
      ]),
    );
    expect(result!.skipped).toHaveLength(3);

    // Ein zweiter Versuch, solange der erste läuft, entfällt.
    expect((await again())!.skipped).toContainEqual({
      changeId: changeIds[2],
      reason: 'alreadyRetried',
    });
  });

  it('wiederholt das Anlegen eines Negatives und prüft vorher, ob es inzwischen existiert', async () => {
    const { changeIds } = await processed([negative('gratis'), negative('umsonst')], [0, 1]);
    await testDb.db.insert(amazonAdsNegativeTargets).values({
      organizationId: f.org,
      profileId: f.profile,
      level: 'ad_group',
      campaignId: f.campaign,
      adGroupId: f.adGroup,
      amazonTargetId: '880000000001',
      adProduct: 'SPONSORED_PRODUCTS',
      targetType: 'keyword',
      keywordText: 'umsonst',
      matchType: 'EXACT',
      state: 'ENABLED',
    });

    const result = await retryAdChanges(testDb.db, {
      ...ada(),
      changeIds,
      channel: 'api',
      enqueue,
    });

    expect(result!.skipped).toEqual([{ changeId: changeIds[1], reason: 'alreadyExists' }]);
    const [retry] = await changesOf(result!.submissions[0]!.id);
    expect(retry).toMatchObject({
      operation: 'create',
      origin: 'retry',
      originChangeId: changeIds[0],
      payload: { type: 'keyword', keywordText: 'gratis', matchType: 'EXACT' },
      campaignId: f.campaign,
      adGroupId: f.adGroup,
    });
  });

  it('sieht keine Änderungen fremder Organisationen oder ausgeblendeter Profile', async () => {
    const { changeIds } = await processed([update('target', f.keyword, 'bid', '0.75')], [0]);
    const input = { changeIds, channel: 'api' as const, enqueue };

    expect(
      await retryAdChanges(testDb.db, { userId: f.ada, orgId: other.org, ...input }),
    ).toBeNull();
    expect(
      (await retryAdChanges(testDb.db, { userId: other.ada, orgId: other.org, ...input }))!.skipped,
    ).toEqual([{ changeId: changeIds[0], reason: 'notFound' }]);
    await testDb.db.update(amazonAdsProfiles).set({ isHidden: true });
    expect((await retryAdChanges(testDb.db, { ...emil(), ...input }))!.skipped).toEqual([
      { changeId: changeIds[0], reason: 'notFound' },
    ]);
  });
});

describe('revertAdChanges', () => {
  it('setzt eine angewendete Änderung als neue Übermittlung auf den Wert davor zurück', async () => {
    const { changeIds } = await processed([update('target', f.keyword, 'bid', '0.75')]);
    await testDb.db.delete(auditEvents);

    const result = await revertAdChanges(testDb.db, {
      ...emil(),
      changeIds,
      channel: 'api',
      enqueue,
    });

    expect(result).toMatchObject({ status: 'submitted', skipped: [] });
    if (result?.status !== 'submitted') throw new Error('nicht übermittelt');
    const [revert] = await changesOf(result.submissions[0]!.id);
    expect(revert).toMatchObject({
      status: 'submitted',
      origin: 'revert',
      originChangeId: changeIds[0],
      field: 'bid',
      oldAmount: '0.75',
      newAmount: '0.50',
      currencyCode: 'EUR',
      createdBy: f.emil,
    });
    expect(enqueued).toHaveLength(1);
    expect(await auditActions()).toEqual(['ad_change_submission.create']);
  });

  it('fragt nach, wenn sich der Wert seit der Übermittlung geändert hat, und überschreibt erst mit Bestätigung', async () => {
    const { changeIds } = await processed([
      update('target', f.keyword, 'bid', '0.75'),
      update('campaign', f.campaign, 'budget', '25'),
    ]);
    await setBid(f.keyword, '0.90');

    const asked = await revertAdChanges(testDb.db, {
      ...ada(),
      changeIds,
      channel: 'api',
      enqueue,
    });

    expect(asked).toEqual({
      status: 'conflict',
      conflicts: [{ changeId: changeIds[0], expected: '0.75', current: '0.90' }],
      skipped: [],
    });
    expect(await testDb.db.select().from(adChangeSubmissions)).toHaveLength(1);
    expect(enqueued).toEqual([]);

    const confirmed = await revertAdChanges(testDb.db, {
      ...ada(),
      changeIds,
      channel: 'api',
      overwriteChanged: true,
      enqueue,
    });

    if (confirmed?.status !== 'submitted') throw new Error('nicht übermittelt');
    const reverts = await changesOf(confirmed.submissions[0]!.id);
    expect(reverts).toHaveLength(2);
    expect(reverts.find((row) => row.field === 'bid')).toMatchObject({
      oldAmount: '0.90',
      newAmount: '0.50',
    });
  });

  it('nimmt eine ganze Übermittlung zurück und überspringt, was sich nicht zurücknehmen lässt', async () => {
    const { submissionId, changeIds } = await processed(
      [
        update('campaign', f.campaign, 'budget', '25'),
        update('campaign', f.campaign, 'placement_product_page', '30'),
        update('target', f.productTarget, 'bid', '0.60'),
        update('target', f.keyword, 'state', 'ARCHIVED'),
        update('ad_group', f.adGroup, 'default_bid', '0.45'),
      ],
      [4],
    );

    const result = await revertAdChanges(testDb.db, {
      ...ada(),
      submissionId,
      channel: 'api',
      enqueue,
    });

    if (result?.status !== 'submitted') throw new Error('nicht übermittelt');
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { changeId: changeIds[2], reason: 'noPreviousValue' },
        { changeId: changeIds[3], reason: 'archiveNotRevertible' },
        { changeId: changeIds[4], reason: 'notApplied' },
      ]),
    );
    expect(result.skipped).toHaveLength(3);
    const reverts = await changesOf(result.submissions[0]!.id);
    expect(reverts).toHaveLength(2);
    expect(reverts.find((row) => row.field === 'budget')).toMatchObject({
      oldAmount: '25',
      newAmount: '20',
    });
    // Eine Platzierung ohne Eintrag geht auf 0 % zurück.
    expect(reverts.find((row) => row.field === 'placement_product_page')).toMatchObject({
      oldAmount: '30',
      newAmount: '0',
      currencyCode: null,
    });
  });

  it('archiviert ein angelegtes Negative wieder (gefunden über die Amazon-ID)', async () => {
    const { changeIds } = await processed([negative('gratis')]);
    const [created] = await testDb.db
      .select({ id: amazonAdsNegativeTargets.id })
      .from(amazonAdsNegativeTargets)
      .where(eq(amazonAdsNegativeTargets.amazonTargetId, '880000000001'));

    const result = await revertAdChanges(testDb.db, {
      ...ada(),
      changeIds,
      channel: 'api',
      enqueue,
    });

    if (result?.status !== 'submitted') throw new Error('nicht übermittelt');
    const [revert] = await changesOf(result.submissions[0]!.id);
    expect(revert).toMatchObject({
      operation: 'update',
      origin: 'revert',
      originChangeId: changeIds[0],
      entityType: 'negative_target',
      entityId: created!.id,
      campaignId: f.campaign,
      adGroupId: f.adGroup,
      field: 'state',
      oldValue: 'ENABLED',
      newValue: 'ARCHIVED',
    });
  });

  it('nimmt nichts zweimal zurück und nichts, was schon auf dem alten Wert steht', async () => {
    const { changeIds } = await processed([
      update('target', f.keyword, 'bid', '0.75'),
      update('campaign', f.campaign, 'budget', '25'),
    ]);
    await testDb.db
      .update(amazonAdsCampaigns)
      .set({ budgetAmount: '20.00' })
      .where(eq(amazonAdsCampaigns.id, f.campaign));
    const revert = () =>
      revertAdChanges(testDb.db, { ...ada(), changeIds, channel: 'api', enqueue });

    expect(await revert()).toMatchObject({
      status: 'submitted',
      skipped: [{ changeId: changeIds[1], reason: 'nothingToChange' }],
    });
    const second = await revert();
    expect(second).toMatchObject({ status: 'submitted', submissions: [] });
    expect(second!.skipped).toContainEqual({ changeId: changeIds[0], reason: 'alreadyReverted' });
  });

  it('über die API nur für Profile mit Connection, sonst als Bulk-Datei', async () => {
    const { submissionId, changeIds } = await submit(
      [update('target', f.fileKeyword, 'bid', '0.75')],
      'bulk_file',
    );
    await closeBulkFileSubmission(testDb.db, {
      ...ada(),
      submissionId,
      outcome: 'applied',
      now: NOW,
    });

    await expect(
      revertAdChanges(testDb.db, { ...ada(), changeIds, channel: 'api', enqueue }),
    ).rejects.toMatchObject({ code: 'PROFILE_HAS_NO_CONNECTION' });

    const result = await revertAdChanges(testDb.db, {
      ...ada(),
      changeIds,
      channel: 'bulk_file',
      enqueue,
    });
    expect(result).toMatchObject({ status: 'submitted' });
    if (result?.status !== 'submitted') throw new Error('nicht übermittelt');
    expect(result.submissions[0]).toMatchObject({ channel: 'bulk_file', profileId: f.fileProfile });
    // Bulk-Dateien brauchen keinen Job.
    expect(enqueued).toEqual([]);
  });

  it('liefert null für Nicht-Mitglieder und findet fremde Übermittlungen nicht', async () => {
    const { submissionId, changeIds } = await processed([
      update('target', f.keyword, 'bid', '0.75'),
    ]);
    expect(
      await revertAdChanges(testDb.db, {
        userId: f.ada,
        orgId: other.org,
        changeIds,
        channel: 'api',
        enqueue,
      }),
    ).toBeNull();
    expect(
      await revertAdChanges(testDb.db, {
        userId: other.ada,
        orgId: other.org,
        submissionId,
        channel: 'api',
        enqueue,
      }),
    ).toEqual({ status: 'submitted', submissions: [], skipped: [] });
  });
});

describe('dismissFailedAdChanges', () => {
  it('verwirft fehlgeschlagene Änderungen und lässt andere unberührt', async () => {
    const { changeIds } = await processed(
      [update('target', f.keyword, 'bid', '0.75'), update('campaign', f.campaign, 'budget', '25')],
      [0],
    );
    await testDb.db.delete(auditEvents);

    expect(await dismissFailedAdChanges(testDb.db, { ...emil(), changeIds })).toBe(1);

    expect(await changeRow(changeIds[0]!)).toMatchObject({ status: 'dismissed' });
    expect(await changeRow(changeIds[1]!)).toMatchObject({ status: 'applied' });
    expect(await auditActions()).toEqual(['ad_changes.dismiss']);
    expect(await dismissFailedAdChanges(testDb.db, { ...emil(), changeIds })).toBe(0);
    expect(
      await dismissFailedAdChanges(testDb.db, { userId: f.ada, orgId: other.org, changeIds }),
    ).toBeNull();
  });
});

describe('closeBulkFileSubmission', () => {
  it('schließt eine Bulk-Übermittlung von Hand als erledigt ab und zieht die Entities nach', async () => {
    const { submissionId, changeIds } = await submit(
      [update('target', f.fileKeyword, 'bid', '0.75')],
      'bulk_file',
    );
    await testDb.db.delete(auditEvents);

    const result = await closeBulkFileSubmission(testDb.db, {
      ...emil(),
      submissionId,
      outcome: 'applied',
      now: NOW,
    });

    expect(result).toEqual({ changes: 1 });
    expect(await changeRow(changeIds[0]!)).toMatchObject({ status: 'applied', resolvedAt: NOW });
    const [target] = await testDb.db
      .select({ bid: amazonAdsTargets.bid })
      .from(amazonAdsTargets)
      .where(eq(amazonAdsTargets.id, f.fileKeyword));
    expect(target!.bid).toBe('0.75');
    const [submission] = await testDb.db
      .select()
      .from(adChangeSubmissions)
      .where(eq(adChangeSubmissions.id, submissionId));
    expect(submission).toMatchObject({ status: 'finished', finishedAt: NOW });
    expect(await auditActions()).toEqual(['ad_change_submission.close']);
  });

  it('verwirft eine nicht hochgeladene Bulk-Übermittlung, ohne die Entities anzufassen', async () => {
    const { submissionId, changeIds } = await submit(
      [update('target', f.fileKeyword, 'bid', '0.75')],
      'bulk_file',
    );

    expect(
      await closeBulkFileSubmission(testDb.db, {
        ...ada(),
        submissionId,
        outcome: 'discarded',
        now: NOW,
      }),
    ).toEqual({ changes: 1 });

    expect(await changeRow(changeIds[0]!)).toMatchObject({ status: 'dismissed' });
    const [target] = await testDb.db
      .select({ bid: amazonAdsTargets.bid })
      .from(amazonAdsTargets)
      .where(eq(amazonAdsTargets.id, f.fileKeyword));
    expect(target!.bid).toBe('0.50');
  });

  it('gilt nur für offene Bulk-Übermittlungen sichtbarer Profile', async () => {
    const api = await submit([update('target', f.keyword, 'bid', '0.75')]);
    const close = (submissionId: string, actor = ada()) =>
      closeBulkFileSubmission(testDb.db, { ...actor, submissionId, outcome: 'applied', now: NOW });

    await expect(close(api.submissionId)).rejects.toBeInstanceOf(AdChangeError);
    await expect(close(api.submissionId)).rejects.toMatchObject({ code: 'SUBMISSION_NOT_OPEN' });

    const bulk = await submit([update('target', f.fileKeyword, 'bid', '0.75')], 'bulk_file');
    expect(await close(bulk.submissionId, { userId: other.ada, orgId: other.org })).toBeNull();
    await close(bulk.submissionId);
    await expect(close(bulk.submissionId)).rejects.toMatchObject({ code: 'SUBMISSION_NOT_OPEN' });
  });
});

describe('getAdChangeSubmission', () => {
  it('nennt je Änderung den letzten Folgeschritt (erneuter Versuch bzw. Revert)', async () => {
    const { submissionId, changeIds } = await processed(
      [update('target', f.keyword, 'bid', '0.75'), update('campaign', f.campaign, 'budget', '25')],
      [0],
    );
    const retried = await retryAdChanges(testDb.db, {
      ...ada(),
      changeIds: [changeIds[0]!],
      channel: 'api',
      enqueue,
    });

    const found = await getAdChangeSubmission(testDb.db, { ...ada(), submissionId });

    const byId = new Map(found!.changes.map((change) => [change.id, change]));
    expect(byId.get(changeIds[0]!)!.followUp).toMatchObject({
      origin: 'retry',
      status: 'submitted',
      submissionId: retried!.submissions[0]!.id,
    });
    expect(byId.get(changeIds[1]!)!.followUp).toBeNull();
  });
});
