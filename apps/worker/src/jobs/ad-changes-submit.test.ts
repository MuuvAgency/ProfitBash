import {
  AmazonAdsHttpError,
  AmazonAdsReauthRequiredError,
  AmazonAdsWriteAbortedError,
  createRequestMeter,
  type AmazonAdsWriteResult,
  type ApplyChangesInput,
  type ApplyChangesResult,
  type ApplyCreatesInput,
} from '@profitbash/amazon-ads';
import {
  saveCampaignSetupDraft,
  schema,
  stageAdChanges,
  submitAdChanges,
  submitCampaignSetupDraft,
} from '@profitbash/db';
import {
  createTestDatabase,
  seedAdChangeFixture,
  type AdChangeFixture,
  type TestDatabase,
} from '@profitbash/db/testing';
import type { AdChangeInput } from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobFailure } from '../run-job';
import { stubAmazonAdsClient } from '../testing';
import { MAX_SUBMISSION_ATTEMPTS, submitConnectionAdChanges } from './ad-changes-submit';
import type { ConnectionJobData, ConnectionJobDeps, ConnectionQueue } from './connection-job';

/** Job `ad-changes-submit` (`phase-3.md` 3.3): Übermittlungen über die API senden und das Ergebnis je Änderung festhalten. */

const {
  adChangeSubmissions,
  adChanges,
  amazonAdsCampaigns,
  amazonAdsTargets,
  campaignSetupDrafts,
  campaignSetupItems,
  connections,
} = schema;

let testDb: TestDatabase;
let f: AdChangeFixture;
const NOW = new Date('2026-10-08T12:00:00Z');

type Answer = (input: ApplyChangesInput) => ApplyChangesResult | Promise<ApplyChangesResult>;
let answer: Answer;
const calls: ApplyChangesInput[] = [];
type CreateAnswer = (input: ApplyCreatesInput) => ApplyChangesResult | Promise<ApplyChangesResult>;
/** Jede Anlage gelingt mit einer neuen ID; schon angelegte behalten ihre. */
const allCreated: CreateAnswer = (input) => ({
  results: input.operations.map((op, index) => ({
    ref: op.ref,
    status: 'applied',
    amazonId: `90${index}`,
  })),
  throttled: false,
  retryAfterMs: null,
});
let createAnswer: CreateAnswer;
const createCalls: ApplyCreatesInput[] = [];
const enqueued: Array<{
  queue: ConnectionQueue;
  job: ConnectionJobData;
  startAfterSeconds: number | undefined;
}> = [];
let leaseExtensions = 0;

/** Jede Operation gelingt. */
const allApplied: Answer = (input) => ({
  results: input.operations.map((op) => ({ ref: op.ref, status: 'applied', amazonId: null })),
  throttled: false,
  retryAfterMs: null,
});

const resultsWith =
  (pick: (ref: string, index: number) => Omit<AmazonAdsWriteResult, 'ref'>, extra = {}): Answer =>
  (input) => ({
    results: input.operations.map(
      (op, index) => ({ ref: op.ref, ...pick(op.ref, index) }) as AmazonAdsWriteResult,
    ),
    throttled: false,
    retryAfterMs: null,
    ...extra,
  });

function deps(): ConnectionJobDeps {
  return {
    db: testDb.db,
    logger: () => {},
    amazonAds: stubAmazonAdsClient({
      applyChanges(_connection, input) {
        calls.push(input);
        return Promise.resolve(answer(input));
      },
      applyCreates(_connection, input) {
        createCalls.push(input);
        return Promise.resolve(createAnswer(input));
      },
    }),
    scheduleRetry: () => Promise.resolve(true),
    enqueue(queue, job, options) {
      enqueued.push({ queue, job, startAfterSeconds: options?.startAfterSeconds });
      return Promise.resolve(true);
    },
    now: () => NOW,
  };
}

const run = () =>
  submitConnectionAdChanges(
    deps(),
    { organizationId: f.org, connectionId: f.connection },
    {
      meter: createRequestMeter(),
      runId: '00000000-0000-4000-8000-000000000001',
      extendLease: () => {
        leaseExtensions += 1;
        return Promise.resolve();
      },
    },
  );

const update = (
  entityType: Extract<AdChangeInput, { operation: 'update' }>['entityType'],
  entityId: string,
  field: Extract<AdChangeInput, { operation: 'update' }>['field'],
  value: string,
): AdChangeInput => ({ operation: 'update', entityType, entityId, field, value });

async function submit(changes: AdChangeInput[]) {
  const actor = { userId: f.ada, orgId: f.org };
  const staged = await stageAdChanges(testDb.db, { ...actor, origin: 'explorer', changes });
  const changeIds = staged!.results.map((result) =>
    'changeId' in result ? result.changeId : 'abgelehnt',
  );
  const result = await submitAdChanges(testDb.db, {
    ...actor,
    channel: 'api',
    enqueue: async () => {},
  });
  return { submissionId: result!.submissions[0]!.id, changeIds };
}

async function changeRow(id: string) {
  const [row] = await testDb.db.select().from(adChanges).where(eq(adChanges.id, id));
  return row!;
}

async function submissionRow(id: string) {
  const [row] = await testDb.db
    .select()
    .from(adChangeSubmissions)
    .where(eq(adChangeSubmissions.id, id));
  return row!;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  f = await seedAdChangeFixture(testDb.db);
});

beforeEach(async () => {
  const { db } = testDb;
  await db.delete(adChanges);
  await db.delete(campaignSetupItems);
  await db.delete(campaignSetupDrafts);
  await db.delete(adChangeSubmissions);
  await db.update(amazonAdsTargets).set({ state: 'ENABLED', removedAt: null });
  await db.update(amazonAdsTargets).set({ bid: '0.50' }).where(eq(amazonAdsTargets.id, f.keyword));
  await db.update(amazonAdsCampaigns).set({ budgetAmount: '20', state: 'ENABLED' });
  await db.update(connections).set({ status: 'active' });
  answer = allApplied;
  calls.length = 0;
  createAnswer = allCreated;
  createCalls.length = 0;
  enqueued.length = 0;
  leaseExtensions = 0;
});

afterAll(async () => {
  await testDb?.close();
});

describe('submitConnectionAdChanges', () => {
  it('sendet die Änderungen je Entity zusammengeführt und hält den Erfolg fest', async () => {
    const { submissionId, changeIds } = await submit([
      update('target', f.keyword, 'bid', '0.75'),
      update('target', f.keyword, 'state', 'PAUSED'),
      update('campaign', f.campaign, 'budget', '25'),
    ]);

    const outcome = await run();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ amazonProfileId: '111', adProduct: 'SPONSORED_PRODUCTS' });
    expect(calls[0]!.operations).toHaveLength(2);
    expect(calls[0]!.operations).toContainEqual(
      expect.objectContaining({
        ref: `target:${f.keyword}`,
        type: 'update',
        entity: 'keyword',
        amazonId: '3001',
        bid: '0.75',
        state: 'PAUSED',
      }),
    );
    for (const id of changeIds) expect(await changeRow(id)).toMatchObject({ status: 'applied' });
    expect(await submissionRow(submissionId)).toMatchObject({
      status: 'finished',
      attempts: 1,
      jobRunId: '00000000-0000-4000-8000-000000000001',
      finishedAt: NOW,
    });
    const [keyword] = await testDb.db
      .select({ bid: amazonAdsTargets.bid, state: amazonAdsTargets.state })
      .from(amazonAdsTargets)
      .where(eq(amazonAdsTargets.id, f.keyword));
    expect(keyword).toEqual({ bid: '0.75', state: 'PAUSED' });
    expect(outcome.counters).toMatchObject({
      submissions: 1,
      changesApplied: 3,
      changesFailed: 0,
      changesUnsent: 0,
    });
    expect(leaseExtensions).toBeGreaterThan(0);
  });

  it('bricht bei Teilfehlern nicht ab: Fehler je Änderung, der Rest wird angewendet', async () => {
    const { submissionId, changeIds } = await submit([
      update('target', f.keyword, 'bid', '0.75'),
      update('campaign', f.campaign, 'budget', '25'),
    ]);
    answer = resultsWith((ref) =>
      ref.startsWith('target:')
        ? { status: 'failed', code: 'BID_OUT_OF_MARKET_PLACE_RANGE', message: 'Gebot zu hoch.' }
        : { status: 'applied', amazonId: '1001' },
    );

    const outcome = await run();

    expect(await changeRow(changeIds[0]!)).toMatchObject({
      status: 'failed',
      errorCode: 'BID_OUT_OF_MARKET_PLACE_RANGE',
      errorMessage: 'Gebot zu hoch.',
    });
    expect(await changeRow(changeIds[1]!)).toMatchObject({ status: 'applied' });
    expect(await submissionRow(submissionId)).toMatchObject({ status: 'finished' });
    expect(outcome.counters).toMatchObject({ changesApplied: 1, changesFailed: 1 });
  });

  it('wertet einen unklaren Ausgang als Fehler mit eigenem Code (nicht blind wiederholen)', async () => {
    const { changeIds } = await submit([update('target', f.keyword, 'bid', '0.75')]);
    answer = resultsWith(() => ({ status: 'unknown', message: 'Zeitüberschreitung bei Amazon.' }));

    await run();

    expect(await changeRow(changeIds[0]!)).toMatchObject({
      status: 'failed',
      errorCode: 'UNKNOWN_OUTCOME',
      errorMessage: expect.stringContaining('Zeitüberschreitung'),
    });
  });

  it('trägt die neue ID eines Negatives ein', async () => {
    const { changeIds } = await submit([
      {
        operation: 'create_negative',
        campaignId: f.campaign,
        adGroupId: f.adGroup,
        negative: { type: 'keyword', keywordText: 'gratis', matchType: 'EXACT' },
      },
    ]);
    answer = resultsWith(() => ({ status: 'applied', amazonId: '880000000009' }));

    await run();

    expect(calls[0]!.operations[0]).toMatchObject({
      type: 'createNegative',
      amazonCampaignId: '1001',
      amazonAdGroupId: '2001',
    });
    expect(await changeRow(changeIds[0]!)).toMatchObject({
      status: 'applied',
      amazonEntityId: '880000000009',
    });
    await testDb.db
      .delete(schema.amazonAdsNegativeTargets)
      .where(eq(schema.amazonAdsNegativeTargets.amazonTargetId, '880000000009'));
  });

  it('lässt nicht abbildbare Änderungen scheitern, ohne Amazon zu fragen', async () => {
    const { submissionId, changeIds } = await submit([update('target', f.keyword, 'bid', '0.75')]);
    await testDb.db
      .update(amazonAdsTargets)
      .set({ removedAt: NOW })
      .where(eq(amazonAdsTargets.id, f.keyword));

    await run();

    expect(calls).toHaveLength(0);
    expect(await changeRow(changeIds[0]!)).toMatchObject({
      status: 'failed',
      errorCode: 'ENTITY_NOT_FOUND',
    });
    expect(await submissionRow(submissionId)).toMatchObject({ status: 'finished' });
  });

  it('stellt bei Drosselung zurück und plant den nächsten Lauf nach der Wartezeit ein', async () => {
    const { submissionId, changeIds } = await submit([
      update('target', f.keyword, 'bid', '0.75'),
      update('campaign', f.campaign, 'budget', '25'),
    ]);
    answer = resultsWith(
      (ref) =>
        ref.startsWith('campaign:')
          ? { status: 'applied', amazonId: '1001' }
          : { status: 'unsent' },
      { throttled: true, retryAfterMs: 120_000 },
    );

    const outcome = await run();

    expect(await changeRow(changeIds[0]!)).toMatchObject({ status: 'submitted' });
    expect(await changeRow(changeIds[1]!)).toMatchObject({ status: 'applied' });
    expect(await submissionRow(submissionId)).toMatchObject({
      status: 'pending',
      finishedAt: null,
      error: expect.stringContaining('gedrosselt'),
    });
    expect(enqueued).toEqual([
      {
        queue: 'ad-changes-submit',
        job: { organizationId: f.org, connectionId: f.connection },
        startAfterSeconds: 120,
      },
    ]);
    expect(outcome.counters).toMatchObject({ changesApplied: 1, changesUnsent: 1 });

    // Der nächste Lauf sendet nur noch den Rest.
    answer = allApplied;
    calls.length = 0;
    await run();
    expect(calls[0]!.operations).toHaveLength(1);
    expect(await submissionRow(submissionId)).toMatchObject({ status: 'finished', attempts: 2 });
  });

  it('gibt nach zu vielen gedrosselten Versuchen auf', async () => {
    const { submissionId, changeIds } = await submit([update('target', f.keyword, 'bid', '0.75')]);
    await testDb.db
      .update(adChangeSubmissions)
      .set({ attempts: MAX_SUBMISSION_ATTEMPTS - 1 })
      .where(eq(adChangeSubmissions.id, submissionId));
    answer = resultsWith(() => ({ status: 'unsent' }), { throttled: true, retryAfterMs: null });

    await expect(run()).rejects.toBeInstanceOf(JobFailure);

    expect(await changeRow(changeIds[0]!)).toMatchObject({
      status: 'failed',
      errorCode: 'NOT_SENT',
    });
    expect(await submissionRow(submissionId)).toMatchObject({ status: 'failed' });
    expect(enqueued).toEqual([]);
  });

  it('arbeitet nach einer Drosselung die übrigen Übermittlungen weiter ab und wartet höchstens 10 Minuten', async () => {
    const first = await submit([update('target', f.keyword, 'bid', '0.75')]);
    const second = await submit([update('campaign', f.campaign, 'budget', '25')]);
    answer = (input) =>
      input.operations[0]!.ref.startsWith('target:')
        ? {
            results: [{ ref: input.operations[0]!.ref, status: 'unsent' }],
            throttled: true,
            retryAfterMs: 3_600_000,
          }
        : allApplied(input);

    await run();

    expect(calls).toHaveLength(2);
    expect(await submissionRow(first.submissionId)).toMatchObject({ status: 'pending' });
    expect(await submissionRow(second.submissionId)).toMatchObject({ status: 'finished' });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ startAfterSeconds: 600 });
  });

  it('nimmt eine immer wieder unterbrochene Übermittlung nicht endlos wieder auf', async () => {
    const { submissionId, changeIds } = await submit([update('target', f.keyword, 'bid', '0.75')]);
    await testDb.db
      .update(adChangeSubmissions)
      .set({ status: 'running', attempts: MAX_SUBMISSION_ATTEMPTS })
      .where(eq(adChangeSubmissions.id, submissionId));

    await expect(run()).rejects.toBeInstanceOf(JobFailure);

    expect(calls).toHaveLength(0);
    expect(await changeRow(changeIds[0]!)).toMatchObject({
      status: 'failed',
      errorCode: 'UNKNOWN_OUTCOME',
    });
    expect(await submissionRow(submissionId)).toMatchObject({ status: 'failed' });
  });

  it('hält bei einem Abbruch die Teilergebnisse fest und lässt den Rest scheitern', async () => {
    const { submissionId, changeIds } = await submit([
      update('target', f.keyword, 'bid', '0.75'),
      update('campaign', f.campaign, 'budget', '25'),
    ]);
    answer = (input) => {
      throw new AmazonAdsWriteAbortedError(
        'ads.applyChanges',
        input.operations.map((op) =>
          op.ref.startsWith('campaign:')
            ? { ref: op.ref, status: 'applied', amazonId: '1001' }
            : { ref: op.ref, status: 'unsent' },
        ),
        new AmazonAdsHttpError('Kein Zugriff', 'sp.keywords.update', 403, 'FORBIDDEN', null),
      );
    };

    await expect(run()).rejects.toBeInstanceOf(JobFailure);

    expect(await changeRow(changeIds[1]!)).toMatchObject({ status: 'applied' });
    expect(await changeRow(changeIds[0]!)).toMatchObject({
      status: 'failed',
      errorCode: 'NOT_SENT',
    });
    expect(await submissionRow(submissionId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('403'),
    });
    const [campaign] = await testDb.db
      .select({ budgetAmount: amazonAdsCampaigns.budgetAmount })
      .from(amazonAdsCampaigns)
      .where(eq(amazonAdsCampaigns.id, f.campaign));
    expect(campaign!.budgetAmount).toBe('25');
  });

  it('markiert die Connection bei abgelehntem Refresh-Token und lässt offene Übermittlungen scheitern', async () => {
    const first = await submit([update('target', f.keyword, 'bid', '0.75')]);
    const second = await submit([update('campaign', f.campaign, 'budget', '25')]);
    answer = (input) => {
      throw new AmazonAdsWriteAbortedError(
        'ads.applyChanges',
        input.operations.map((op) => ({ ref: op.ref, status: 'unsent' })),
        new AmazonAdsReauthRequiredError('lwa.refresh', 400, null),
      );
    };

    await expect(run()).rejects.toThrow(/neu verbunden/);

    expect(await submissionRow(first.submissionId)).toMatchObject({ status: 'failed' });
    expect(await submissionRow(second.submissionId)).toMatchObject({ status: 'failed' });
    expect(await changeRow(second.changeIds[0]!)).toMatchObject({
      status: 'failed',
      errorCode: 'NOT_SENT',
    });
    const [connection] = await testDb.db
      .select({ status: connections.status })
      .from(connections)
      .where(eq(connections.id, f.connection));
    expect(connection!.status).toBe('reauth_required');
  });

  it('sendet nichts über eine Connection, die neu verbunden werden muss', async () => {
    const { submissionId, changeIds } = await submit([update('target', f.keyword, 'bid', '0.75')]);
    await testDb.db.update(connections).set({ status: 'reauth_required' });

    await expect(run()).rejects.toThrow(/neu verbunden/);

    expect(calls).toHaveLength(0);
    expect(await submissionRow(submissionId)).toMatchObject({ status: 'failed' });
    expect(await changeRow(changeIds[0]!)).toMatchObject({
      status: 'failed',
      errorCode: 'NOT_SENT',
    });
  });

  it('arbeitet mehrere Übermittlungen in einem Lauf ab und endet leer ohne Fehler', async () => {
    const first = await submit([update('target', f.keyword, 'bid', '0.75')]);
    const second = await submit([update('campaign', f.campaign, 'budget', '25')]);

    const outcome = await run();

    expect(await submissionRow(first.submissionId)).toMatchObject({ status: 'finished' });
    expect(await submissionRow(second.submissionId)).toMatchObject({ status: 'finished' });
    expect(outcome.counters).toMatchObject({ submissions: 2, changesApplied: 2 });
    expect((await run()).counters).toMatchObject({ submissions: 0 });
  });
});

describe('submitConnectionAdChanges: Setups (4.4)', () => {
  const NAME = 'SP | EXACT | Flaschen';
  const sourceNegative = {
    markId: '00000000-0000-4000-8000-000000000001',
    searchTerm: 'flasche',
    amazonCampaignId: '1001',
    amazonAdGroupId: '2001',
    campaignName: 'Kampagne 1001',
    adGroupName: 'AG 2001',
    negative: { type: 'keyword', text: 'flasche', matchType: 'negativeExact' },
    selected: true,
  } as const;
  async function setup(sourceNegatives: (typeof sourceNegative)[] = []) {
    const actor = { userId: f.ada, orgId: f.org };
    const draft = (await saveCampaignSetupDraft(testDb.db, {
      ...actor,
      draft: {
        profileId: f.profile,
        productGroupId: null,
        presetKey: 'muuv-standard',
        name: 'Flaschen',
        campaignState: 'ENABLED',
        inputs: {
          keywords: [],
          brandTerms: [],
          productTargets: [],
          categories: [],
          harvest: [],
          unlocks: {},
          creative: null,
        },
        sourceNegatives,
        portfolioId: null,
        campaigns: [
          {
            block: 'SP-KW-EXACT',
            adProduct: 'SP',
            targeting: 'keyword',
            name: NAME,
            state: 'ENABLED',
            currencyCode: 'EUR',
            dailyBudget: '25.00',
            biddingStrategy: 'SALES_DOWN_ONLY',
            sdOptimization: null,
            costType: 'cpc',
            offAmazon: false,
            placements: { topOfSearch: 20, productPages: 0, restOfSearch: 0 },
            adGroup: { name: NAME, defaultBid: '0.85' },
            ads: [{ asin: 'B0TEST0001', sku: 'SKU-1' }],
            targets: [{ type: 'keyword', text: 'flasche', matchType: 'exact', bid: '0.90' }],
            negatives: [],
          },
        ],
      },
    }))!;
    const result = await submitCampaignSetupDraft(testDb.db, {
      ...actor,
      draftId: draft.id,
      version: 1,
      channel: 'api',
      enqueue: async () => undefined,
      limitFor: () => null,
    });
    if (result?.status !== 'submitted') throw new Error('nicht übermittelt');
    return result.submission.id;
  }
  const items = (submissionId: string) =>
    testDb.db
      .select()
      .from(campaignSetupItems)
      .where(eq(campaignSetupItems.submissionId, submissionId))
      .orderBy(campaignSetupItems.position);

  it('legt die Struktur über die API an und hält die neuen IDs fest', async () => {
    const submissionId = await setup();
    const outcome = await run();

    expect(calls).toEqual([]);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.amazonProfileId).toBe('111');
    // Startdatum: heute in der Zeitzone des Profils (Europe/Berlin).
    expect(createCalls[0]!.operations[0]).toMatchObject({
      entity: 'campaign',
      startDate: '2026-10-08',
      placements: [{ placement: 'PLACEMENT_TOP', percentage: '20' }],
    });
    expect(
      (await items(submissionId)).map((row) => [row.entityType, row.status, row.amazonEntityId]),
    ).toEqual([
      ['campaign', 'applied', '900'],
      ['placement', 'applied', null],
      ['ad_group', 'applied', '901'],
      ['product_ad', 'applied', '902'],
      ['keyword', 'applied', '903'],
    ]);
    expect(await submissionRow(submissionId)).toMatchObject({ status: 'finished' });
    expect(outcome.counters).toMatchObject({ submissions: 1, changesApplied: 5, changesFailed: 0 });
  });

  it('negiert in der Quelle erst nach der Anlage des Keywords, im selben Lauf (4.6)', async () => {
    const submissionId = await setup([sourceNegative]);
    await run();
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0]!.operations.map((op) => op.entity)).not.toContain('negativeKeyword');
    expect(createCalls[1]!.operations).toEqual([
      expect.objectContaining({
        entity: 'negativeKeyword',
        campaignRef: 'amazon-campaign:1001',
        adGroupRef: 'amazon-ad-group:2001',
        keywordText: 'flasche',
      }),
    ]);
    expect((await items(submissionId)).at(-1)).toMatchObject({
      entityType: 'source_negative',
      status: 'applied',
    });
    expect(await submissionRow(submissionId)).toMatchObject({ status: 'finished' });
  });

  it('negiert nicht in der Quelle, wenn das Keyword abgelehnt wird (4.6)', async () => {
    const submissionId = await setup([sourceNegative]);
    createAnswer = (input) => ({
      results: input.operations.map((op) =>
        op.entity === 'keyword'
          ? { ref: op.ref, status: 'failed', code: 'INVALID_KEYWORD', message: 'abgelehnt' }
          : { ref: op.ref, status: 'applied', amazonId: `7${op.ref.length}` },
      ),
      throttled: false,
      retryAfterMs: null,
    });
    await run();
    expect(createCalls).toHaveLength(1);
    expect((await items(submissionId)).at(-1)).toMatchObject({
      entityType: 'source_negative',
      status: 'failed',
      errorCode: 'HARVEST_TARGET_NOT_CREATED',
    });
    expect(await submissionRow(submissionId)).toMatchObject({ status: 'finished' });
  });

  it('hält Teilfehler fest und setzt nach einer Drosselung mit den angelegten Eltern fort', async () => {
    const submissionId = await setup();
    createAnswer = (input) => ({
      results: input.operations.map((op, index) =>
        index === 0
          ? { ref: op.ref, status: 'applied', amazonId: '4401' }
          : { ref: op.ref, status: 'unsent' },
      ),
      throttled: true,
      retryAfterMs: 90_000,
    });
    const first = await run();
    expect(first.counters).toMatchObject({ changesApplied: 2, changesUnsent: 3 });
    expect(await submissionRow(submissionId)).toMatchObject({ status: 'pending' });
    expect(enqueued.at(-1)).toMatchObject({ startAfterSeconds: 90 });

    createAnswer = (input) => ({
      results: input.operations.map((op) =>
        op.entity === 'keyword'
          ? { ref: op.ref, status: 'failed', code: 'INVALID_KEYWORD', message: 'abgelehnt' }
          : { ref: op.ref, status: 'applied', amazonId: `5${op.ref.length}` },
      ),
      throttled: false,
      retryAfterMs: null,
    });
    await run();
    const second = createCalls.at(-1)!;
    expect(second.operations.map((op) => op.entity)).toEqual(['adGroup', 'productAd', 'keyword']);
    expect([...(second.created ?? new Map()).values()]).toEqual(['4401']);
    expect((await items(submissionId)).map((row) => [row.entityType, row.status])).toEqual([
      ['campaign', 'applied'],
      ['placement', 'applied'],
      ['ad_group', 'applied'],
      ['product_ad', 'applied'],
      ['keyword', 'failed'],
    ]);
    expect(await submissionRow(submissionId)).toMatchObject({ status: 'finished' });
  });

  it('wertet unklare Ausgänge als Fehler und lässt bei einem Abbruch den Rest scheitern', async () => {
    const submissionId = await setup();
    createAnswer = () => {
      throw new AmazonAdsWriteAbortedError(
        'ads.applyCreates',
        [],
        new AmazonAdsHttpError('Kein Zugriff', 'sp.campaigns.create', 403, 'FORBIDDEN', null),
      );
    };
    await expect(run()).rejects.toBeInstanceOf(JobFailure);
    expect((await items(submissionId)).every((row) => row.status === 'failed')).toBe(true);
    expect((await items(submissionId))[0]!.errorCode).toBe('NOT_SENT');
    expect(await submissionRow(submissionId)).toMatchObject({ status: 'failed' });
  });
});
