import {
  recordAdChangeResults,
  saveCampaignSetupDraft,
  schema,
  submitCampaignSetupDraft,
} from '@profitbash/db';
import { seedAdChangeFixture, type AdChangeFixture } from '@profitbash/db/testing';
import type {
  AdChangeInput,
  AdChangeSubmissionDetail,
  ErrorResponse,
  PendingAdChangesResponse,
  RevertAdChangesResponse,
  SubmitAdChangesResponse,
} from '@profitbash/shared';
import { todayInTimezone } from '@profitbash/shared';
import { openXlsx } from '@profitbash/sheets';
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
  campaignSetupDrafts,
  campaignSetupItems,
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
  await db.delete(campaignSetupItems);
  await db.delete(campaignSetupDrafts);
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
      // Ohne eigenes Gebot zählt das Standardgebot der Ad Group (0.40) als Vergleichswert.
      largeChanges: expect.arrayContaining([
        { changeId: bid, changePercent: '60' },
        { changeId: tooLow, changePercent: '-97.5' },
      ]),
      tooMany: null,
    });
    // Der Warenkorb gehört dem Nutzer (F4).
    expect((await call<PendingAdChangesResponse>('GET', '/pending', admin)).body.changes).toEqual(
      [],
    );
  });

  it('warnt bei einem Target ohne eigenes Gebot gegen das Standardgebot der Ad Group', async () => {
    const staged = await stage(editor, [update('target', f.productTarget, 'bid', '0.90')]);
    const changeId = staged.body.results[0]!.changeId!;

    const cart = await call<PendingAdChangesResponse>('GET', '/pending', editor);
    expect(cart.body.changes[0]).toMatchObject({ before: null, comparisonBefore: '0.40' });
    expect(cart.body.check.largeChanges).toEqual([{ changeId, changePercent: '125' }]);

    const submitted = await call<SubmitAdChangesResponse>('POST', '/submit', editor, {
      channel: 'api',
    });
    expect(submitted.body).toMatchObject({
      status: 'needsConfirmation',
      check: { largeChanges: [{ changeId, changePercent: '125' }] },
    });
  });

  it('passt Beträge um Prozent oder Betrag an und rechnet dabei selbst (kein Wert aus der Anfrage)', async () => {
    const adjust = (
      entityId: string,
      mode: 'percent' | 'amount',
      value: string,
    ): AdChangeInput => ({
      operation: 'adjust',
      entityType: 'target',
      entityId,
      field: 'bid',
      mode,
      value,
    });
    const staged = await stage(editor, [
      adjust(f.keyword, 'percent', '-10'),
      adjust(f.productTarget, 'amount', '0.05'),
      adjust(other.keyword, 'percent', '10'),
    ]);

    expect(staged.status).toBe(200);
    expect(staged.body.results.map((result) => result.reason ?? result.outcome)).toEqual([
      'created',
      'created',
      'notFound',
    ]);
    const cart = await call<PendingAdChangesResponse>('GET', '/pending', editor);
    const byEntity = new Map(cart.body.changes.map((change) => [change.entityId, change]));
    expect(byEntity.get(f.keyword)).toMatchObject({ before: '0.50', after: '0.45' });
    // Ohne eigenes Gebot: Standardgebot der Ad Group (0.40) als Ausgangswert.
    expect(byEntity.get(f.productTarget)).toMatchObject({ before: null, after: '0.45' });

    const invalid = await stage(editor, [adjust(f.keyword, 'percent', '-100')]);
    expect(invalid.status).toBe(400);
    expect((await stage(viewer, [adjust(f.keyword, 'percent', '5')])).status).toBe(403);
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

  it('prüft mit dem Stand beim Übermitteln, nicht mit dem beim Vormerken', async () => {
    // +40 % beim Vormerken; ein Sync senkt das Gebot danach, übermittelt würden +133 %.
    await stage(editor, [update('target', f.keyword, 'bid', '0.70')]);
    await ctx.testDb.db
      .update(amazonAdsTargets)
      .set({ bid: '0.30' })
      .where(eq(amazonAdsTargets.id, f.keyword));

    const res = await call<SubmitAdChangesResponse>('POST', '/submit', editor, { channel: 'api' });

    expect(res.body).toMatchObject({
      status: 'needsConfirmation',
      check: { largeChanges: [{ changePercent: '133.33' }] },
    });
    expect(await ctx.testDb.db.select().from(adChangeSubmissions)).toEqual([]);
    expect(
      (await call<PendingAdChangesResponse>('GET', '/pending', editor)).body.changes,
    ).toHaveLength(1);
  });

  it('übermittelt nur die genannten Änderungen und meldet einen leeren Warenkorb als leere Übermittlung', async () => {
    const staged = await stage(editor, [
      update('target', f.keyword, 'bid', '0.55'),
      update('campaign', f.campaign, 'budget', '25'),
    ]);
    const res = await call<SubmitAdChangesResponse>('POST', '/submit', editor, {
      channel: 'api',
      changeIds: [staged.body.results[0]!.changeId],
    });
    expect(res.body).toMatchObject({ status: 'submitted', submissions: [{ changes: 1 }] });
    expect(
      (await call<PendingAdChangesResponse>('GET', '/pending', editor)).body.changes,
    ).toHaveLength(1);
    const audit = await ctx.testDb.db.select({ action: auditEvents.action }).from(auditEvents);
    expect(audit.map((event) => event.action)).toContain('ad_change_submission.create');

    expect(
      (await call<SubmitAdChangesResponse>('POST', '/submit', admin, { channel: 'api' })).body,
    ).toEqual({
      status: 'submitted',
      submissions: [],
      dropped: 0,
      blocked: [],
      bulkFileSkipped: [],
    });
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

  it('lässt beim Download und beim Abschließen scheitern, was inzwischen nicht mehr in die Datei passt', async () => {
    const { submissionId, changeIds } = await submit(
      [
        update('target', f.fileKeyword, 'bid', '0.55'),
        update('campaign', f.fileCampaign, 'budget', '25'),
      ],
      'bulk_file',
    );
    // Ein Import hat das Target seit dem Übermitteln als entfernt markiert.
    await ctx.testDb.db
      .update(amazonAdsTargets)
      .set({ removedAt: NOW })
      .where(eq(amazonAdsTargets.id, f.fileKeyword));
    try {
      const closed = await call('POST', `/submissions/${submissionId}/close`, editor, {
        outcome: 'applied',
      });
      // Nur das Budget gilt als hochgeladen; das Gebot stand nie in der Datei.
      expect(closed.body).toEqual({ changes: 1 });
      const detail = await call<AdChangeSubmissionDetail>(
        'GET',
        `/submissions/${submissionId}`,
        editor,
      );
      expect(detail.body.changes.find((change) => change.id === changeIds[0])).toMatchObject({
        status: 'failed',
        errorCode: 'ENTITY_NOT_FOUND',
      });
      expect(detail.body.changes.find((change) => change.id === changeIds[1])).toMatchObject({
        status: 'applied',
      });
    } finally {
      await ctx.testDb.db.update(amazonAdsTargets).set({ removedAt: null });
    }
  });

  it('liefert keine Datei mehr, wenn keine Änderung übrig ist', async () => {
    const { submissionId, changeIds } = await submit(
      [update('target', f.fileKeyword, 'bid', '0.55')],
      'bulk_file',
    );
    await ctx.testDb.db
      .update(amazonAdsTargets)
      .set({ removedAt: NOW })
      .where(eq(amazonAdsTargets.id, f.fileKeyword));
    try {
      const res = await call('GET', `/submissions/${submissionId}/bulk-file`, editor);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BULK_FILE_EMPTY');
      const detail = await call<AdChangeSubmissionDetail>(
        'GET',
        `/submissions/${submissionId}`,
        editor,
      );
      expect(detail.body.submission.status).toBe('finished');
      expect(detail.body.changes[0]).toMatchObject({ id: changeIds[0], status: 'failed' });
    } finally {
      await ctx.testDb.db.update(amazonAdsTargets).set({ removedAt: null });
    }

    const discarded = await submit([update('target', f.fileKeyword, 'bid', '0.55')], 'bulk_file');
    expect(
      (
        await call('POST', `/submissions/${discarded.submissionId}/close`, editor, {
          outcome: 'discarded',
        })
      ).body,
    ).toEqual({ changes: 1 });
    expect(
      (await call('GET', `/submissions/${discarded.submissionId}/bulk-file`, editor)).body.error
        .code,
    ).toBe('BULK_FILE_EMPTY');
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

describe('Bulk-Datei eines Setups (4.4)', () => {
  /** Entwurf mit einer SP-Kampagne im Profil ohne Connection, übermittelt als Bulk-Datei. */
  async function setup(defaultBid = '0.85') {
    const { db } = ctx.testDb;
    const name = 'SP | EXACT | Lampen';
    const draft = (await saveCampaignSetupDraft(db, {
      userId: f.ada,
      orgId: f.org,
      draft: {
        profileId: f.fileProfile,
        productGroupId: null,
        presetKey: 'muuv-standard',
        name: 'Lampen',
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
        sourceNegatives: [],
        portfolioId: null,
        campaigns: [
          {
            block: 'SP-KW-EXACT',
            adProduct: 'SP',
            targeting: 'keyword',
            name,
            state: 'ENABLED',
            currencyCode: 'EUR',
            dailyBudget: '20.00',
            biddingStrategy: 'SALES_DOWN_ONLY',
            sdOptimization: null,
            costType: 'cpc',
            offAmazon: false,
            placements: null,
            adGroup: { name, defaultBid },
            ads: [{ asin: 'B0TEST0001', sku: 'SKU-1' }],
            targets: [{ type: 'keyword', text: 'stehlampe', matchType: 'exact', bid: '0.90' }],
            negatives: [],
          },
        ],
      },
    }))!;
    const result = await submitCampaignSetupDraft(db, {
      userId: f.ada,
      orgId: f.org,
      draftId: draft.id,
      version: 1,
      channel: 'bulk_file',
      enqueue: async () => undefined,
      limitFor: () => null,
    });
    if (result?.status !== 'submitted') throw new Error('nicht übermittelt');
    return result.submission.id;
  }

  it('liefert die Datei mit den Anlagen und nennt die Übermittlung als Setup', async () => {
    const submissionId = await setup();
    const res = await request(ctx, `/api/ads/changes/submissions/${submissionId}/bulk-file`, {
      method: 'GET',
      cookie: editor,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="profitbash-setup-datei-konto-de-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    const workbook = openXlsx(new Uint8Array(await res.arrayBuffer()));
    const rows: string[][] = [];
    workbook.forEachRow('Sponsored Products Campaigns', (cells) => rows.push(cells));
    const entity = rows[0]!.indexOf('Entity');
    const start = rows[0]!.indexOf('Start Date');
    expect(rows.slice(1).map((row) => row[entity])).toEqual([
      'Campaign',
      'Ad Group',
      'Product Ad',
      'Keyword',
    ]);
    expect(rows[1]![start]).toBe(todayInTimezone('Europe/Berlin', new Date()).replaceAll('-', ''));

    const detail = await call<AdChangeSubmissionDetail>(
      'GET',
      `/submissions/${submissionId}`,
      editor,
    );
    expect(detail.body.submission).toMatchObject({
      kind: 'setup',
      changes: 4,
      counts: { submitted: 4 },
    });
  });

  it('lässt Anlagen scheitern, die nicht in die Datei passen, samt ihren Kindern', async () => {
    const submissionId = await setup('0');
    const res = await request(ctx, `/api/ads/changes/submissions/${submissionId}/bulk-file`, {
      method: 'GET',
      cookie: editor,
    });
    expect(res.status).toBe(200);
    const items = await ctx.testDb.db
      .select()
      .from(campaignSetupItems)
      .where(eq(campaignSetupItems.submissionId, submissionId))
      .orderBy(campaignSetupItems.position);
    expect(items.map((item) => [item.entityType, item.status, item.errorCode])).toEqual([
      ['campaign', 'submitted', null],
      ['ad_group', 'failed', 'BULK_FILE_INVALID_VALUE'],
      ['product_ad', 'failed', 'PARENT_NOT_CREATED'],
      ['keyword', 'failed', 'PARENT_NOT_CREATED'],
    ]);
  });

  it('schließt ein Setup von Hand ab; fremde Organisation und ausgeblendetes Profil sehen es nicht', async () => {
    const submissionId = await setup();
    expect((await call('GET', `/submissions/${submissionId}/bulk-file`, foreign)).status).toBe(404);
    const closed = await call('POST', `/submissions/${submissionId}/close`, editor, {
      outcome: 'applied',
    });
    expect(closed.body).toEqual({ changes: 4 });
    await ctx.testDb.db.update(amazonAdsProfiles).set({ isHidden: true });
    expect((await call('GET', `/submissions/${submissionId}/bulk-file`, editor)).status).toBe(404);
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

describe('Fremde Organisation und ausgeblendete Profile', () => {
  it('nimmt Änderungen einer anderen Organisation nicht zurück', async () => {
    const { submissionId, changeIds } = await processed([
      update('target', f.keyword, 'bid', '0.55'),
    ]);

    const byChange = await call<RevertAdChangesResponse>('POST', '/revert', foreign, {
      changeIds,
      channel: 'api',
    });
    expect(byChange.body).toEqual({
      status: 'submitted',
      submissions: [],
      skipped: [{ changeId: changeIds[0], reason: 'notFound' }],
      bulkFileSkipped: [],
    });
    const bySubmission = await call<RevertAdChangesResponse>('POST', '/revert', foreign, {
      submissionId,
      channel: 'api',
    });
    expect(bySubmission.body).toMatchObject({ status: 'submitted', submissions: [], skipped: [] });
    expect(await ctx.testDb.db.select().from(adChangeSubmissions)).toHaveLength(1);
  });

  it('zeigt und ändert nichts in ausgeblendeten Profilen', async () => {
    const done = await processed(
      [update('target', f.keyword, 'bid', '0.55'), update('campaign', f.campaign, 'budget', '25')],
      [0],
    );
    const bulk = await submit([update('target', f.fileKeyword, 'bid', '0.55')], 'bulk_file');
    const staged = await stage(editor, [update('ad_group', f.adGroup, 'default_bid', '0.45')]);
    const pendingId = staged.body.results[0]!.changeId!;
    await ctx.testDb.db.update(amazonAdsProfiles).set({ isHidden: true });

    expect((await call<PendingAdChangesResponse>('GET', '/pending', editor)).body.changes).toEqual(
      [],
    );
    expect(
      (await call('POST', '/pending/discard', editor, { changeIds: [pendingId] })).body,
    ).toEqual({ discarded: 0 });
    expect(
      (await call<SubmitAdChangesResponse>('POST', '/submit', editor, { channel: 'api' })).body,
    ).toMatchObject({ status: 'submitted', submissions: [] });
    expect((await call<{ changes: unknown[] }>('GET', '/open', editor)).body.changes).toEqual([]);
    expect(
      (await call<{ changes: unknown[] }>('POST', '/history', editor, {})).body.changes,
    ).toEqual([]);
    expect(
      (await call<{ submissions: unknown[] }>('GET', '/submissions', editor)).body.submissions,
    ).toEqual([]);
    expect(
      (
        await call('POST', `/submissions/${bulk.submissionId}/close`, editor, {
          outcome: 'applied',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call<{ skipped: unknown[] }>('POST', '/retry', editor, {
          changeIds: [done.changeIds[0]],
          channel: 'api',
        })
      ).body.skipped,
    ).toEqual([{ changeId: done.changeIds[0], reason: 'notFound' }]);
    expect(
      (await call('POST', '/dismiss', editor, { changeIds: [done.changeIds[0]] })).body,
    ).toEqual({ dismissed: 0 });
    expect(
      (
        await call<RevertAdChangesResponse>('POST', '/revert', editor, {
          changeIds: [done.changeIds[1]],
          channel: 'api',
        })
      ).body,
    ).toMatchObject({ skipped: [{ changeId: done.changeIds[1], reason: 'notFound' }] });
  });

  it('verlangt auch für eine einzelne Übermittlung eine Anmeldung und begrenzt den Body', async () => {
    expect((await call('GET', '/submissions/00000000-0000-4000-8000-000000000001')).status).toBe(
      401,
    );
    const tooLarge = await call('POST', '/pending', undefined, {
      origin: 'explorer',
      changes: [],
      padding: 'x'.repeat(2 * 1024 * 1024),
    });
    expect(tooLarge.status).toBe(413);
  });
});

describe('Offene Änderungen und Verlauf', () => {
  it('nennt offene Änderungen aller Nutzer für die Anzeige im Grid, neueste zuerst', async () => {
    await submit([update('target', f.keyword, 'bid', '0.55')]);
    await ctx.testDb.db.update(adChanges).set({ createdAt: new Date('2026-10-01T00:00:00Z') });
    await stage(editor, [
      {
        operation: 'create_negative',
        campaignId: f.campaign,
        adGroupId: f.adGroup,
        negative: { type: 'keyword', keywordText: 'gratis', matchType: 'EXACT' },
      },
    ]);
    await stage(editor, [update('target', f.fileKeyword, 'bid', '0.60')]);

    type Open = {
      changes: Array<{ status: string; mine: boolean; userName: string | null; profileId: string }>;
      truncated: boolean;
    };
    const open = await call<Open>('GET', '/open', viewer);

    expect(open.body.truncated).toBe(false);
    expect(open.body.changes).toHaveLength(3);
    expect(open.body.changes.at(-1)).toMatchObject({
      status: 'submitted',
      channel: 'api',
      entityId: f.keyword,
      mine: false,
    });
    expect(open.body.changes).toContainEqual(
      expect.objectContaining({
        status: 'pending',
        operation: 'create',
        userName: 'editor@muuv.test',
        negative: { type: 'keyword', keywordText: 'gratis', matchType: 'EXACT' },
      }),
    );
    const onlyFile = await call<Open>('GET', `/open?profileId=${f.fileProfile}`, viewer);
    expect(onlyFile.body.changes.map((change) => change.profileId)).toEqual([f.fileProfile]);
    expect((await call<Open>('GET', '/open', foreign)).body.changes).toEqual([]);
    expect((await call<Open>('GET', `/open?profileId=${f.profile}`, foreign)).body.changes).toEqual(
      [],
    );
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
