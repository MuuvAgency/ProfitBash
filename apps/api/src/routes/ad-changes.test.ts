import { recordAdChangeResults, schema } from '@profitbash/db';
import { seedAdChangeFixture, type AdChangeFixture } from '@profitbash/db/testing';
import type {
  AdChangeInput,
  AdChangeSubmissionDetail,
  ErrorResponse,
  PendingAdChangesResponse,
  RevertAdChangesResponse,
  SubmitAdChangesResponse,
} from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  type TestContext,
} from '../testing';

const {
  adChangeSubmissions,
  adChanges,
  amazonAdsCampaigns,
  amazonAdsProfiles,
  amazonAdsTargets,
  auditEvents,
  orgEntitlements,
} = schema;

/**
 * Änderungen über die API (`phase-3.md` 3.4): Warenkorb, Übermitteln mit Grenzen und Warnungen, Übermittlungen
 * samt Bulk-Datei, erneut versuchen, verwerfen, Revert, Verlauf. Je Endpunkt: Recht `write`, fremde Organisation,
 * ausgeblendetes Profil.
 */

let ctx: TestContext;
let f: AdChangeFixture;
let other: AdChangeFixture;
let admin = '';
let editor = '';
let viewer = '';
let foreign = '';
const NOW = new Date('2026-10-08T12:00:00Z');

async function call<T>(method: string, path: string, cookie?: string, json?: unknown) {
  const res = await request(ctx, `/api/ads/changes${path}`, { method, cookie, json });
  return { status: res.status, body: await readJson<T & ErrorResponse>(res) };
}

const update = (
  entityType: Extract<AdChangeInput, { operation: 'update' }>['entityType'],
  entityId: string,
  field: Extract<AdChangeInput, { operation: 'update' }>['field'],
  value: string,
): AdChangeInput => ({ operation: 'update', entityType, entityId, field, value });

interface Staged {
  results: Array<{ outcome: string; changeId?: string; reason?: string }>;
  counts: Record<string, number>;
}
const stage = (cookie: string, changes: AdChangeInput[]) =>
  call<Staged>('POST', '/pending', cookie, { origin: 'explorer', changes });

type Submitted = Extract<SubmitAdChangesResponse, { status: 'submitted' }>;
/** Vormerken und übermitteln (Warnungen bestätigt); liefert Übermittlung und Änderungen in Eingabe-Reihenfolge. */
async function submit(
  changes: AdChangeInput[],
  channel: 'api' | 'bulk_file' = 'api',
  cookie = admin,
) {
  const staged = await stage(cookie, changes);
  const changeIds = staged.body.results.map((result) => result.changeId ?? 'abgelehnt');
  const res = await call<Submitted>('POST', '/submit', cookie, { channel, confirmWarnings: true });
  if (res.body.status !== 'submitted') throw new Error(`nicht übermittelt: ${res.status}`);
  return { submissionId: res.body.submissions[0]!.id, changeIds, response: res.body };
}

/** Ergebnis des Jobs für eine Übermittlung über die API. */
async function processed(changes: AdChangeInput[], failed: number[] = []) {
  const { submissionId, changeIds } = await submit(changes);
  await recordAdChangeResults(ctx.testDb.db, {
    organizationId: f.org,
    submissionId,
    now: NOW,
    results: changeIds.map((changeId, index) =>
      failed.includes(index)
        ? { changeId, outcome: 'failed', code: 'BID_TOO_LOW', message: 'Gebot zu niedrig.' }
        : { changeId, outcome: 'applied', amazonEntityId: null },
    ),
  });
  return { submissionId, changeIds };
}

beforeAll(async () => {
  ctx = await createTestContext();
  const { db } = ctx.testDb;
  const orgId = ctx.seeded.organizationId;
  const editorUser = await createUser(ctx, {
    email: 'editor@muuv.test',
    org: { id: orgId, role: 'editor' },
  });
  await createUser(ctx, { email: 'viewer@muuv.test', org: { id: orgId, role: 'viewer' } });
  f = await seedAdChangeFixture(db, 'muuv-api', {
    org: orgId,
    ada: ctx.seeded.userId,
    emil: editorUser.id,
  });
  other = await seedAdChangeFixture(db, 'fremd-aenderungen');
  await db.insert(orgEntitlements).values({ organizationId: other.org, feature: 'changes' });
  await createUser(ctx, { email: 'fremd@andere.test', org: { id: other.org, role: 'admin' } });
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
  viewer = await signIn(ctx, 'viewer@muuv.test');
  foreign = await signIn(ctx, 'fremd@andere.test');
});

beforeEach(async () => {
  const { db } = ctx.testDb;
  await db.delete(adChanges);
  await db.delete(adChangeSubmissions);
  await db.delete(auditEvents);
  await db.update(amazonAdsProfiles).set({ isHidden: false });
  await db.update(amazonAdsTargets).set({ bid: '0.50', state: 'ENABLED' });
  await db
    .update(amazonAdsTargets)
    .set({ bid: null })
    .where(eq(amazonAdsTargets.id, f.productTarget));
  await db.update(amazonAdsCampaigns).set({ budgetAmount: '20', state: 'ENABLED' });
  ctx.jobs.adChangesSubmits.length = 0;
  ctx.jobs.enqueuedInTransaction.length = 0;
});

afterAll(async () => {
  await ctx?.close();
});

describe('Rechte', () => {
  const writes: Array<[string, string, unknown]> = [
    ['POST', '/pending', { origin: 'explorer', changes: [] }],
    ['POST', '/pending/discard', {}],
    ['POST', '/submit', { channel: 'api' }],
    ['POST', '/retry', { changeIds: ['00000000-0000-4000-8000-000000000001'], channel: 'api' }],
    ['POST', '/dismiss', { changeIds: ['00000000-0000-4000-8000-000000000001'] }],
    ['POST', '/revert', { changeIds: ['00000000-0000-4000-8000-000000000001'], channel: 'api' }],
    ['POST', '/submissions/00000000-0000-4000-8000-000000000001/close', { outcome: 'applied' }],
    ['GET', '/submissions/00000000-0000-4000-8000-000000000001/bulk-file', undefined],
  ];
  const reads: Array<[string, string, unknown]> = [
    ['GET', '/pending', undefined],
    ['GET', '/open', undefined],
    ['POST', '/history', {}],
    ['GET', '/submissions', undefined],
  ];

  it('verlangt eine Anmeldung', async () => {
    for (const [method, path, body] of [...writes, ...reads]) {
      expect((await call(method, path, undefined, body)).status, path).toBe(401);
    }
  });

  it('lässt Viewer lesen, aber nichts ändern (Recht „write“)', async () => {
    for (const [method, path, body] of reads) {
      expect((await call(method, path, viewer, body)).status, path).toBe(200);
    }
    for (const [method, path, body] of writes) {
      const res = await call(method, path, viewer, body);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('FEATURE_FORBIDDEN');
    }
  });

  it('verlangt das gebuchte Feature „changes“', async () => {
    await ctx.testDb.db
      .update(orgEntitlements)
      .set({ enabled: false })
      .where(eq(orgEntitlements.organizationId, other.org));
    expect((await call('GET', '/pending', foreign)).status).toBe(403);
    await ctx.testDb.db
      .update(orgEntitlements)
      .set({ enabled: true })
      .where(eq(orgEntitlements.organizationId, other.org));
    expect((await call('GET', '/pending', foreign)).status).toBe(200);
  });
});

describe('Warenkorb', () => {
  it('merkt Änderungen vor und zeigt sie mit den Prüfungen', async () => {
    const staged = await stage(editor, [
      update('target', f.keyword, 'bid', '0.80'),
      update('campaign', f.campaign, 'budget', '25'),
      update('target', f.productTarget, 'bid', '0.01'),
    ]);
    expect(staged.status).toBe(200);
    expect(staged.body.counts).toMatchObject({ created: 3, rejected: 0 });
    const [bid, , tooLow] = staged.body.results.map((result) => result.changeId!);

    const cart = await call<PendingAdChangesResponse>('GET', '/pending', editor);

    expect(cart.status).toBe(200);
    expect(cart.body.changes).toHaveLength(3);
    expect(cart.body.changes.find((change) => change.id === bid)).toMatchObject({
      status: 'pending',
      entityType: 'target',
      field: 'bid',
      before: '0.50',
      after: '0.80',
      currencyCode: 'EUR',
      accountName: 'Nordwind DE',
      countryCode: 'DE',
      adProduct: 'SPONSORED_PRODUCTS',
      entity: { targetType: 'keyword', keywordText: 'kw 3001' },
      otherUsers: [],
    });
    expect(cart.body.check).toEqual({
      violations: [{ changeId: tooLow, code: 'belowMinimum', min: '0.02', max: '1000' }],
      largeChanges: [{ changeId: bid, changePercent: '60' }],
      tooMany: null,
    });
    // Der Warenkorb gehört dem Nutzer (F4).
    expect((await call<PendingAdChangesResponse>('GET', '/pending', admin)).body.changes).toEqual(
      [],
    );
  });

  it('lehnt fremde und ausgeblendete Entities je Änderung ab und prüft die Eingabe', async () => {
    const foreignEntity = await stage(editor, [update('target', other.keyword, 'bid', '0.80')]);
    expect(foreignEntity.body.results).toEqual([{ outcome: 'rejected', reason: 'notFound' }]);
    await ctx.testDb.db.update(amazonAdsProfiles).set({ isHidden: true });
    const hidden = await stage(editor, [update('target', f.keyword, 'bid', '0.80')]);
    expect(hidden.body.results).toEqual([{ outcome: 'rejected', reason: 'notFound' }]);

    const invalid = await stage(editor, [update('target', f.keyword, 'bid', 'viel')]);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('nimmt große Sammeländerungen an (eigenes Body-Limit über den allgemeinen 64 KB)', async () => {
    const many = Array.from({ length: 1500 }, () => update('target', other.keyword, 'bid', '0.80'));
    expect(JSON.stringify(many).length).toBeGreaterThan(64 * 1024);
    const res = await stage(editor, many);
    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({ rejected: 1, unchanged: 1499 });
  });

  it('verwirft genannte oder alle eigenen Änderungen', async () => {
    const staged = await stage(editor, [
      update('target', f.keyword, 'bid', '0.60'),
      update('campaign', f.campaign, 'budget', '25'),
    ]);
    const first = staged.body.results[0]!.changeId!;
    expect((await call('POST', '/pending/discard', admin, { changeIds: [first] })).body).toEqual({
      discarded: 0,
    });
    expect((await call('POST', '/pending/discard', editor, { changeIds: [first] })).body).toEqual({
      discarded: 1,
    });
    expect((await call('POST', '/pending/discard', editor, {})).body).toEqual({ discarded: 1 });
  });
});

describe('Übermitteln', () => {
  it('übermittelt nichts, solange ein Wert außerhalb der Grenzen von Amazon liegt', async () => {
    await stage(editor, [
      update('target', f.keyword, 'bid', '0.01'),
      update('campaign', f.campaign, 'budget', '25'),
    ]);

    const res = await call<SubmitAdChangesResponse>('POST', '/submit', editor, {
      channel: 'api',
      confirmWarnings: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('limitsExceeded');
    expect(await ctx.testDb.db.select().from(adChangeSubmissions)).toEqual([]);
    expect(ctx.jobs.adChangesSubmits).toEqual([]);
  });

  it('fragt bei großen Änderungen nach und übermittelt erst mit Bestätigung', async () => {
    await stage(editor, [update('target', f.keyword, 'bid', '0.80')]);

    const asked = await call<SubmitAdChangesResponse>('POST', '/submit', editor, {
      channel: 'api',
    });
    expect(asked.body).toMatchObject({
      status: 'needsConfirmation',
      check: { largeChanges: [{ changePercent: '60' }] },
    });
    expect(await ctx.testDb.db.select().from(adChangeSubmissions)).toEqual([]);

    const confirmed = await call<SubmitAdChangesResponse>('POST', '/submit', editor, {
      channel: 'api',
      confirmWarnings: true,
    });
    expect(confirmed.body).toMatchObject({
      status: 'submitted',
      submissions: [
        {
          profileId: f.profile,
          channel: 'api',
          status: 'pending',
          changes: 1,
          createdByName: 'editor@muuv.test',
        },
      ],
      dropped: 0,
      blocked: [],
      bulkFileSkipped: [],
    });
    // Der Job der Connection ist in der Transaktion der Übermittlung eingeplant.
    expect(ctx.jobs.adChangesSubmits).toEqual([
      { organizationId: f.org, connectionId: f.connection },
    ]);
    expect(ctx.jobs.enqueuedInTransaction).toEqual([true]);
  });

  it('übermittelt ohne Rückfrage, wenn nichts zu warnen ist, und begrenzt auf ein Profil', async () => {
    await stage(editor, [
      update('target', f.keyword, 'bid', '0.55'),
      update('target', f.fileKeyword, 'bid', '0.55'),
    ]);
    const res = await call<SubmitAdChangesResponse>('POST', '/submit', editor, {
      channel: 'api',
      profileId: f.profile,
    });
    expect(res.body).toMatchObject({
      status: 'submitted',
      submissions: [{ profileId: f.profile }],
    });
    const cart = await call<PendingAdChangesResponse>('GET', '/pending', editor);
    expect(cart.body.changes).toHaveLength(1);
  });

  it('nimmt Profile ohne Connection nur als Bulk-Datei', async () => {
    await stage(editor, [update('target', f.fileKeyword, 'bid', '0.55')]);
    const res = await call('POST', '/submit', editor, { channel: 'api' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PROFILE_HAS_NO_CONNECTION');
  });
});

describe('Bulk-Datei', () => {
  it('übermittelt als Bulk-Datei ohne Job und liefert die Datei zum Herunterladen', async () => {
    const { submissionId, response } = await submit(
      [update('target', f.fileKeyword, 'bid', '0.55')],
      'bulk_file',
      editor,
    );
    expect(response.submissions[0]).toMatchObject({ channel: 'bulk_file', status: 'pending' });
    expect(ctx.jobs.adChangesSubmits).toEqual([]);

    const res = await request(ctx, `/api/ads/changes/submissions/${submissionId}/bulk-file`, {
      method: 'GET',
      cookie: editor,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="profitbash-aenderungen-datei-konto-de-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    // ZIP-Signatur einer .xlsx.
    expect([...bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
  });

  it('lässt Änderungen scheitern, die nicht in die Bulk-Datei passen', async () => {
    const { submissionId, changeIds, response } = await submit(
      [
        update('target', f.fileKeyword, 'bid', '0.55'),
        {
          operation: 'create_negative',
          campaignId: f.fileCampaign,
          adGroupId: null,
          negative: { type: 'product', asin: 'B000000001' },
        },
      ],
      'bulk_file',
    );

    expect(response.bulkFileSkipped).toEqual([
      { changeId: changeIds[1], code: 'BULK_FILE_NOT_SUPPORTED', message: expect.any(String) },
    ]);
    expect(response.submissions[0]).toMatchObject({
      status: 'pending',
      counts: { submitted: 1, failed: 1 },
    });
    const detail = await call<AdChangeSubmissionDetail>(
      'GET',
      `/submissions/${submissionId}`,
      admin,
    );
    expect(detail.body.changes.find((change) => change.id === changeIds[1])).toMatchObject({
      status: 'failed',
      errorCode: 'BULK_FILE_NOT_SUPPORTED',
    });
  });

  it('gibt es nur für Übermittlungen per Bulk-Datei in sichtbaren Profilen', async () => {
    const api = await submit([update('target', f.keyword, 'bid', '0.55')]);
    const wrong = await call('GET', `/submissions/${api.submissionId}/bulk-file`, admin);
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('SUBMISSION_NOT_BULK_FILE');

    const bulk = await submit([update('target', f.fileKeyword, 'bid', '0.55')], 'bulk_file');
    expect((await call('GET', `/submissions/${bulk.submissionId}/bulk-file`, foreign)).status).toBe(
      404,
    );
    await ctx.testDb.db.update(amazonAdsProfiles).set({ isHidden: true });
    expect((await call('GET', `/submissions/${bulk.submissionId}/bulk-file`, editor)).status).toBe(
      404,
    );
  });

  it('schließt eine Bulk-Übermittlung von Hand ab', async () => {
    const { submissionId } = await submit(
      [update('target', f.fileKeyword, 'bid', '0.55')],
      'bulk_file',
    );
    expect(
      (await call('POST', `/submissions/${submissionId}/close`, foreign, { outcome: 'applied' }))
        .status,
    ).toBe(404);

    const closed = await call('POST', `/submissions/${submissionId}/close`, editor, {
      outcome: 'applied',
    });
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({ changes: 1 });

    const again = await call('POST', `/submissions/${submissionId}/close`, editor, {
      outcome: 'discarded',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SUBMISSION_NOT_OPEN');
  });
});

describe('Übermittlungen', () => {
  it('listet Übermittlungen der Organisation und zeigt eine mit ihren Änderungen', async () => {
    const { submissionId, changeIds } = await processed(
      [update('target', f.keyword, 'bid', '0.55'), update('campaign', f.campaign, 'budget', '25')],
      [0],
    );

    const list = await call<{ submissions: Array<{ id: string }> }>('GET', '/submissions', viewer);
    expect(list.body.submissions.map((submission) => submission.id)).toEqual([submissionId]);

    const detail = await call<AdChangeSubmissionDetail>(
      'GET',
      `/submissions/${submissionId}`,
      viewer,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.submission).toMatchObject({
      id: submissionId,
      counts: { submitted: 0, applied: 1, failed: 1, dismissed: 0 },
    });
    expect(detail.body.changes.find((change) => change.id === changeIds[0])).toMatchObject({
      status: 'failed',
      errorCode: 'BID_TOO_LOW',
      errorMessage: 'Gebot zu niedrig.',
      resolvedAt: NOW.toISOString(),
      followUp: null,
    });
    expect(detail.body).toHaveProperty('entitiesSyncedAt');
  });

  it('zeigt fremden Organisationen und für ausgeblendete Profile nichts', async () => {
    const { submissionId } = await submit([update('target', f.keyword, 'bid', '0.55')]);
    expect((await call<{ submissions: unknown[] }>('GET', '/submissions', foreign)).body).toEqual({
      submissions: [],
    });
    expect((await call('GET', `/submissions/${submissionId}`, foreign)).status).toBe(404);
    await ctx.testDb.db.update(amazonAdsProfiles).set({ isHidden: true });
    const hidden = await call('GET', `/submissions/${submissionId}`, editor);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe('SUBMISSION_NOT_FOUND');
  });
});

describe('Erneut versuchen, verwerfen, Revert', () => {
  it('versucht fehlgeschlagene Änderungen erneut und plant den Job ein', async () => {
    const { changeIds } = await processed([update('target', f.keyword, 'bid', '0.55')], [0]);
    ctx.jobs.adChangesSubmits.length = 0;

    const res = await call<{ submissions: unknown[]; skipped: unknown[] }>(
      'POST',
      '/retry',
      editor,
      { changeIds, channel: 'api' },
    );

    expect(res.status).toBe(200);
    expect(res.body.submissions).toHaveLength(1);
    expect(res.body.skipped).toEqual([]);
    expect(ctx.jobs.adChangesSubmits).toEqual([
      { organizationId: f.org, connectionId: f.connection },
    ]);
    expect(
      (await call<{ skipped: unknown[] }>('POST', '/retry', foreign, { changeIds, channel: 'api' }))
        .body.skipped,
    ).toEqual([{ changeId: changeIds[0], reason: 'notFound' }]);
  });

  it('verwirft fehlgeschlagene Änderungen', async () => {
    const { changeIds } = await processed([update('target', f.keyword, 'bid', '0.55')], [0]);
    expect((await call('POST', '/dismiss', foreign, { changeIds })).body).toEqual({ dismissed: 0 });
    expect((await call('POST', '/dismiss', editor, { changeIds })).body).toEqual({ dismissed: 1 });
  });

  it('nimmt Änderungen zurück und fragt bei abweichendem Stand nach (F8)', async () => {
    const { submissionId, changeIds } = await processed([
      update('target', f.keyword, 'bid', '0.55'),
    ]);
    await ctx.testDb.db
      .update(amazonAdsTargets)
      .set({ bid: '0.70' })
      .where(eq(amazonAdsTargets.id, f.keyword));

    const asked = await call<RevertAdChangesResponse>('POST', '/revert', editor, {
      submissionId,
      channel: 'api',
    });
    expect(asked.body).toEqual({
      status: 'conflict',
      conflicts: [{ changeId: changeIds[0], expected: '0.55', current: '0.70' }],
      skipped: [],
    });

    const confirmed = await call<RevertAdChangesResponse>('POST', '/revert', editor, {
      submissionId,
      channel: 'api',
      overwriteChanged: true,
    });
    expect(confirmed.body).toMatchObject({ status: 'submitted', skipped: [], bulkFileSkipped: [] });

    const detail = await call<AdChangeSubmissionDetail>(
      'GET',
      `/submissions/${submissionId}`,
      editor,
    );
    expect(detail.body.changes[0]!.followUp).toMatchObject({
      origin: 'revert',
      status: 'submitted',
    });
  });

  it('verlangt beim Revert genau eine Übermittlung oder einzelne Änderungen', async () => {
    const res = await call('POST', '/revert', editor, { channel: 'api' });
    expect(res.status).toBe(400);
    const foreignRevert = await call<RevertAdChangesResponse>('POST', '/revert', foreign, {
      changeIds: ['00000000-0000-4000-8000-000000000001'],
      channel: 'api',
    });
    expect(foreignRevert.body).toMatchObject({
      status: 'submitted',
      submissions: [],
      skipped: [{ reason: 'notFound' }],
    });
  });
});

describe('Offene Änderungen und Verlauf', () => {
  it('nennt offene Änderungen aller Nutzer für die Anzeige im Grid', async () => {
    await submit([update('target', f.keyword, 'bid', '0.55')]);
    await stage(editor, [update('campaign', f.campaign, 'budget', '25')]);

    const open = await call<{
      changes: Array<{ status: string; mine: boolean; userName: string | null }>;
      truncated: boolean;
    }>('GET', '/open', viewer);

    expect(open.body.truncated).toBe(false);
    expect(open.body.changes).toEqual([
      expect.objectContaining({
        status: 'submitted',
        channel: 'api',
        entityId: f.keyword,
        mine: false,
      }),
      expect.objectContaining({ status: 'pending', after: '25', userName: 'editor@muuv.test' }),
    ]);
    expect((await call<{ changes: unknown[] }>('GET', '/open', foreign)).body.changes).toEqual([]);
  });

  it('liefert den Verlauf einer Entity', async () => {
    const { changeIds } = await processed([update('target', f.keyword, 'bid', '0.55')]);

    const history = await call<{ changes: Array<{ id: string }> }>('POST', '/history', viewer, {
      entityType: 'target',
      entityId: f.keyword,
    });

    expect(history.status).toBe(200);
    expect(history.body.changes).toEqual([
      expect.objectContaining({
        id: changeIds[0],
        status: 'applied',
        channel: 'api',
        before: '0.50',
        after: '0.55',
      }),
    ]);
    expect(
      (
        await call<{ changes: unknown[] }>('POST', '/history', foreign, {
          entityType: 'target',
          entityId: f.keyword,
        })
      ).body.changes,
    ).toEqual([]);
    expect((await call('POST', '/history', viewer, { entityType: 'target' })).status).toBe(400);
  });
});
