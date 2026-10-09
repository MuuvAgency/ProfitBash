import {
  AmazonAdsHttpError,
  AmazonAdsReauthRequiredError,
  AmazonAdsWriteAbortedError,
  createRequestMeter,
  type AmazonAdsWriteResult,
  type ApplyChangesInput,
  type ApplyChangesResult,
} from '@profitbash/amazon-ads';
import { schema, stageAdChanges, submitAdChanges } from '@profitbash/db';
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

const { adChangeSubmissions, adChanges, amazonAdsCampaigns, amazonAdsTargets, connections } =
  schema;

let testDb: TestDatabase;
let f: AdChangeFixture;
const NOW = new Date('2026-10-08T12:00:00Z');

type Answer = (input: ApplyChangesInput) => ApplyChangesResult | Promise<ApplyChangesResult>;
let answer: Answer;
const calls: ApplyChangesInput[] = [];
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
  await db.delete(adChangeSubmissions);
  await db.update(amazonAdsTargets).set({ state: 'ENABLED', removedAt: null });
  await db.update(amazonAdsTargets).set({ bid: '0.50' }).where(eq(amazonAdsTargets.id, f.keyword));
  await db.update(amazonAdsCampaigns).set({ budgetAmount: '20', state: 'ENABLED' });
  await db.update(connections).set({ status: 'active' });
  answer = allApplied;
  calls.length = 0;
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
        'sp.applyChanges',
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
        'sp.applyChanges',
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
