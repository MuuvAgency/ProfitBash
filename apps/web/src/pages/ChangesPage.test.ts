import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AdChangeSubmissionData,
  PendingAdChangeData,
  PendingAdChangesData,
  SubmittedAdChangeData,
} from '../api/client';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Seite „Änderungen“ (`phase-3.md` 3.6): Ausstehend (Warenkorb) und Übermittlungen mit Folgeschritten. */

const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const CAMPAIGN = '00000000-0000-4000-8000-0000000000ca';
const C1 = '00000000-0000-4000-8000-00000000d001';
const C2 = '00000000-0000-4000-8000-00000000d002';
const C3 = '00000000-0000-4000-8000-00000000d003';
const S1 = '00000000-0000-4000-8000-00000000e001';
const S2 = '00000000-0000-4000-8000-00000000e002';
const NOW = '2026-10-09T08:00:00.000Z';

const plain = (text: string | null | undefined) => (text ?? '').replace(/\u00a0|\u202f/g, ' ');

function change(id: string, patch: Partial<SubmittedAdChangeData> = {}): SubmittedAdChangeData {
  return {
    id,
    profileId: P1,
    accountName: 'Demo DE',
    countryCode: 'DE',
    adProduct: 'SPONSORED_PRODUCTS',
    status: 'pending',
    origin: 'explorer',
    originChangeId: null,
    operation: 'update',
    entityType: 'target',
    entityId: '00000000-0000-4000-8000-0000000000f1',
    campaignId: CAMPAIGN,
    campaignName: 'SP Nistkasten',
    adGroupId: null,
    adGroupName: 'AG Meise',
    field: 'bid',
    before: '0.50',
    after: '0.80',
    currencyCode: 'EUR',
    negative: null,
    entity: {
      targetType: 'keyword',
      keywordText: 'nistkasten meise',
      matchType: 'EXACT',
      expression: null,
      asin: null,
      sku: null,
    },
    submissionId: null,
    amazonEntityId: null,
    errorCode: null,
    errorMessage: null,
    resolvedAt: null,
    createdBy: 'user-1',
    createdAt: NOW,
    updatedAt: NOW,
    followUp: null,
    ...patch,
  };
}

const pendingChange = (
  id: string,
  patch: Partial<PendingAdChangeData> = {},
): PendingAdChangeData => {
  const { followUp: _followUp, ...rest } = change(id);
  return { ...rest, otherUsers: [], comparisonBefore: null, ...patch };
};

const noCheck = { violations: [], largeChanges: [], tooMany: null };
const cart = (
  changes: PendingAdChangeData[],
  check: Partial<PendingAdChangesData['check']> = {},
): PendingAdChangesData => ({ changes, check: { ...noCheck, ...check } });

function submission(
  id: string,
  patch: Partial<AdChangeSubmissionData> = {},
): AdChangeSubmissionData {
  return {
    id,
    profileId: P1,
    accountName: 'Demo DE',
    countryCode: 'DE',
    channel: 'api',
    kind: 'changes',
    status: 'finished',
    error: null,
    createdBy: 'user-1',
    createdByName: 'Dominik',
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: NOW,
    changes: 2,
    counts: { submitted: 0, applied: 1, failed: 1, dismissed: 0 },
    ...patch,
  };
}

type Responder = (request: RecordedRequest) => Response;
function routes(extra: Record<string, Responder | Response> = {}, me = meFixture()) {
  return {
    'GET /api/me': json(me),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/ads/changes/pending': json(cart([])),
    'GET /api/ads/changes/submissions': json({ submissions: [] }),
    ...extra,
  };
}

async function mountPage(path = '/ads/changes') {
  const mounted = await mountWithApp(undefined, { path });
  await flushPromises();
  return mounted;
}

const posts = (requests: RecordedRequest[], path: string) =>
  requests
    .filter((r) => r.method === 'POST' && r.path === `/api/ads/changes${path}`)
    .map((r) => r.body);

async function click(_wrapper: VueWrapper, selector: string) {
  const element = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`${selector} fehlt`);
    return found;
  });
  element.click();
  await flushPromises();
}

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Änderungen: Ausstehend', () => {
  it('zeigt den Warenkorb je Profil mit vorher/nachher und den Prüfungen', async () => {
    stubFetch(
      routes({
        'GET /api/ads/changes/pending': json(
          cart(
            [
              pendingChange(C1, { otherUsers: [{ userId: 'u2', name: 'Emil' }] }),
              pendingChange(C2, {
                entityType: 'campaign',
                entity: null,
                adGroupName: null,
                field: 'budget',
                before: '20',
                after: '0.50',
              }),
              pendingChange(C3, {
                profileId: P2,
                accountName: 'Demo UK',
                countryCode: 'UK',
                currencyCode: 'GBP',
              }),
            ],
            {
              violations: [{ changeId: C2, code: 'belowMinimum', min: '1', max: '1000000' }],
              largeChanges: [{ changeId: C1, changePercent: '60' }],
            },
          ),
        ),
      }),
    );
    const { wrapper } = await mountPage();
    await vi.waitFor(() => expect(wrapper.find(`[data-change="${C1}"]`).exists()).toBe(true));

    expect(wrapper.get('h1').text()).toBe('Änderungen');
    expect(wrapper.findAll('[data-profile]').map((group) => group.get('h2').text())).toEqual([
      'Demo DE · DE',
      'Demo UK · UK',
    ]);
    const first = plain(wrapper.get(`[data-change="${C1}"]`).text());
    expect(first).toContain('nistkasten meise · Genau');
    expect(first).toContain('SP Nistkasten › AG Meise');
    expect(first).toContain('Gebot');
    expect(first).toContain('0,50 €');
    expect(first).toContain('0,80 €');
    expect(first).toContain('+60 %');
    expect(first).toContain('Auch vorgemerkt von Emil');
    const second = plain(wrapper.get(`[data-change="${C2}"]`).text());
    expect(second).toContain('Unter dem Minimum von Amazon (1,00 €)');
    // Mit einem Verstoß lässt sich das Profil nicht übermitteln.
    const group = wrapper.get(`[data-profile="${P1}"]`);
    expect(group.get('[data-submit="api"]').attributes('disabled')).toBeDefined();
    expect(
      wrapper.get(`[data-profile="${P2}"] [data-submit="api"]`).attributes('disabled'),
    ).toBeUndefined();
  });

  it('zeigt Skeleton, leeren Warenkorb mit Weg in den Explorer und einen Fehler mit „Erneut versuchen“', async () => {
    stubFetch(routes());
    const { wrapper } = await mountPage();
    await vi.waitFor(() => expect(wrapper.text()).toContain('Der Warenkorb ist leer'));
    expect(wrapper.find('a[href="/ads/explorer"]').exists()).toBe(true);
    cleanupMounted();

    stubFetch(
      routes({
        'GET /api/ads/changes/pending': json(
          { error: { code: 'INTERNAL_ERROR', message: 'x' } },
          500,
        ),
      }),
    );
    const failed = await mountPage();
    await vi.waitFor(() =>
      expect(failed.wrapper.text()).toContain('Der Warenkorb konnte nicht geladen werden.'),
    );
    expect(failed.wrapper.text()).toContain('Erneut versuchen');
  });

  it('verwirft eine Änderung sofort und alle erst nach Rückfrage', async () => {
    const { requests } = stubFetch(
      routes({
        'GET /api/ads/changes/pending': json(cart([pendingChange(C1), pendingChange(C2)])),
        'POST /api/ads/changes/pending/discard': json({ discarded: 1 }),
      }),
    );
    const { wrapper } = await mountPage();
    await click(wrapper, `[data-change="${C1}"] [data-discard]`);
    expect(posts(requests, '/pending/discard')).toEqual([{ changeIds: [C1] }]);

    await click(wrapper, '[data-discard-all]');
    expect(posts(requests, '/pending/discard')).toHaveLength(1);
    await click(wrapper, '[data-confirm-discard]');
    expect(posts(requests, '/pending/discard')[1]).toEqual({});
  });

  it('fragt bei Warnungen nach und übermittelt erst mit Bestätigung genau die gezeigten Änderungen', async () => {
    const { requests } = stubFetch(
      routes({
        'GET /api/ads/changes/pending': json(
          cart([pendingChange(C1), pendingChange(C2)], {
            largeChanges: [{ changeId: C1, changePercent: '60' }],
          }),
        ),
        'POST /api/ads/changes/submit': ({ body }) =>
          (body as { confirmWarnings?: boolean }).confirmWarnings
            ? json({
                status: 'submitted',
                submissions: [
                  submission(S1, {
                    status: 'pending',
                    counts: { submitted: 2, applied: 0, failed: 0, dismissed: 0 },
                  }),
                ],
                dropped: 1,
                blocked: [],
                bulkFileSkipped: [],
              })
            : json({
                status: 'needsConfirmation',
                check: { ...noCheck, largeChanges: [{ changeId: C1, changePercent: '60' }] },
              }),
        [`GET /api/ads/changes/submissions/${S1}`]: json({
          submission: submission(S1, { status: 'pending' }),
          changes: [change(C1, { status: 'submitted', submissionId: S1 })],
          setupItems: [],
          entitiesSyncedAt: null,
        }),
      }),
    );
    const { wrapper, router } = await mountPage();
    await click(wrapper, `[data-profile="${P1}"] [data-submit="api"]`);
    expect(posts(requests, '/submit')).toEqual([{ channel: 'api', changeIds: [C1, C2] }]);

    const dialog = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role="dialog"]');
      if (!found) throw new Error('kein Dialog');
      return found;
    });
    expect(plain(dialog.textContent)).toContain(
      '1 Änderung ändert ein Gebot oder Budget um mehr als 50 %',
    );
    await click(wrapper, '[data-confirm-warnings]');
    expect(posts(requests, '/submit')[1]).toEqual({
      channel: 'api',
      changeIds: [C1, C2],
      confirmWarnings: true,
    });
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({ tab: 'submissions', submission: S1 }),
    );
    await vi.waitFor(() =>
      expect(wrapper.get('[data-submit-notice]').text()).toContain(
        '1 Änderung entfiel, weil der Wert schon dem Stand bei Amazon entspricht',
      ),
    );
  });

  it('meldet Grenzen von Amazon und Profile ohne Connection, ohne zu übermitteln', async () => {
    let answer: Response = json({
      status: 'limitsExceeded',
      check: {
        ...noCheck,
        violations: [{ changeId: C1, code: 'aboveMaximum', min: '0.02', max: '1000' }],
      },
    });
    stubFetch(
      routes({
        'GET /api/ads/changes/pending': json(cart([pendingChange(C1)])),
        'POST /api/ads/changes/submit': () => answer.clone(),
      }),
    );
    const { wrapper, router } = await mountPage();
    await click(wrapper, '[data-submit="api"]');
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain(
        'Mindestens ein Wert liegt außerhalb der Grenzen von Amazon',
      ),
    );
    answer = json({ error: { code: 'PROFILE_HAS_NO_CONNECTION', message: 'x' } }, 409);
    await click(wrapper, '[data-submit="api"]');
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain('Dieses Profil hat keine Verbindung zur API'),
    );
    expect(router.currentRoute.value.query.tab).toBeUndefined();
  });

  it('zeigt Viewern den Warenkorb ohne Aktionen', async () => {
    stubFetch(
      routes(
        { 'GET /api/ads/changes/pending': json(cart([pendingChange(C1)])) },
        meFixture({ orgRole: 'viewer' }),
      ),
    );
    const { wrapper } = await mountPage();
    await vi.waitFor(() => expect(wrapper.find(`[data-change="${C1}"]`).exists()).toBe(true));
    expect(wrapper.find('[data-submit]').exists()).toBe(false);
    expect(wrapper.find('[data-discard]').exists()).toBe(false);
    expect(wrapper.find('[data-discard-all]').exists()).toBe(false);
  });
});

describe('Änderungen: Übermittlungen', () => {
  const detail = (patch: Partial<AdChangeSubmissionData> = {}, changes?: SubmittedAdChangeData[]) =>
    json({
      submission: submission(S1, patch),
      changes: changes ?? [
        change(C1, { status: 'applied', submissionId: S1, resolvedAt: NOW }),
        change(C2, {
          status: 'failed',
          submissionId: S1,
          errorCode: 'BID_TOO_LOW',
          errorMessage: 'Gebot zu niedrig.',
          after: '0.01',
        }),
        change(C3, {
          status: 'failed',
          submissionId: S1,
          errorCode: 'NOT_SENT',
          errorMessage: null,
          followUp: { changeId: 'x', origin: 'retry', status: 'applied', submissionId: S2 },
        }),
      ],
      setupItems: [],
      entitiesSyncedAt: '2026-10-01T06:00:00.000Z',
    });

  it('zeigt die Anlagen eines Kampagnen-Setups mit Ergebnis', async () => {
    const item = (position: number, patch: Record<string, unknown>) => ({
      id: `00000000-0000-4000-8000-00000000f00${position}`,
      position,
      campaignRef: 'SP | EXACT | Flaschen',
      adGroupRef: position === 0 ? null : 'SP | EXACT | Flaschen',
      status: 'submitted',
      amazonEntityId: null,
      errorCode: null,
      errorMessage: null,
      ...patch,
    });
    stubFetch(
      routes({
        'GET /api/ads/changes/submissions': json({
          submissions: [submission(S1, { kind: 'setup', channel: 'bulk_file', status: 'pending' })],
        }),
        [`GET /api/ads/changes/submissions/${S1}`]: json({
          submission: submission(S1, { kind: 'setup', channel: 'bulk_file', status: 'pending' }),
          changes: [],
          setupItems: [
            item(0, {
              entityType: 'campaign',
              payload: { entity: 'campaign', name: 'SP | EXACT | Flaschen' },
              status: 'applied',
              amazonEntityId: '4401',
            }),
            item(1, {
              entityType: 'keyword',
              payload: { entity: 'keyword', text: 'trinkflasche', matchType: 'exact', bid: '0.90' },
              status: 'failed',
              errorCode: 'PARENT_NOT_CREATED',
              errorMessage: 'Die Kampagne wird nicht angelegt.',
            }),
            item(2, {
              entityType: 'source_negative',
              campaignRef: 'SP | AUTO | Alt',
              adGroupRef: 'Auto',
              payload: {
                entity: 'source_negative',
                amazonCampaignId: '111',
                amazonAdGroupId: '222',
                negative: {
                  type: 'keyword',
                  text: 'trinkflasche glas',
                  matchType: 'negativeExact',
                },
                harvestMarkId: '00000000-0000-4000-8000-0000000000f1',
              },
            }),
          ],
          entitiesSyncedAt: null,
        }),
      }),
    );
    const { wrapper } = await mountPage(`/ads/changes?tab=submissions&submission=${S1}`);
    await vi.waitFor(() => expect(wrapper.find(`[data-submission="${S1}"]`).exists()).toBe(true));
    expect(wrapper.get(`[data-submission="${S1}"]`).text()).toContain('Kampagnen-Setup');
    const panel = await vi.waitFor(() => wrapper.get('[data-submission-detail]'));
    await vi.waitFor(() => expect(panel.findAll('[data-setup-item]')).toHaveLength(3));
    const [campaignRow, keywordRow, sourceRow] = panel.findAll('[data-setup-item]');
    expect(sourceRow!.text()).toContain('Negativ in der Quelle');
    expect(sourceRow!.text()).toContain('trinkflasche glas (negativ exakt)');
    expect(sourceRow!.text()).toContain('SP | AUTO | Alt');
    expect(campaignRow!.text()).toContain('Kampagne');
    expect(campaignRow!.text()).toContain('SP | EXACT | Flaschen');
    expect(campaignRow!.text()).toContain('Angelegt');
    expect(campaignRow!.text()).toContain('4401');
    expect(keywordRow!.text()).toContain('trinkflasche');
    expect(keywordRow!.text()).toContain('trinkflasche (exakt)');
    expect(keywordRow!.text()).toContain(
      'Die Kampagne bzw. Ad Group dieser Anlage wird nicht angelegt.',
    );
    // Folgeschritte (erneut versuchen, Revert) gibt es für Setups nicht; der Hinweis erklärt die Zuordnung.
    expect(panel.find('[data-followup-channel]').exists()).toBe(false);
    expect(panel.text()).toContain('über ihren Namen');
  });

  it('listet die Übermittlungen der Organisation und öffnet eine mit dem Ergebnis je Änderung', async () => {
    stubFetch(
      routes({
        'GET /api/ads/changes/submissions': json({
          submissions: [
            submission(S1),
            submission(S2, { channel: 'bulk_file', status: 'pending', createdByName: 'Emil' }),
          ],
        }),
        [`GET /api/ads/changes/submissions/${S1}`]: detail(),
      }),
    );
    const { wrapper, router } = await mountPage('/ads/changes?tab=submissions');
    await vi.waitFor(() => expect(wrapper.find(`[data-submission="${S1}"]`).exists()).toBe(true));
    const row = wrapper.get(`[data-submission="${S2}"]`).text();
    expect(row).toContain('Bulk-Datei');
    expect(row).toContain('Wartet auf den Upload');
    expect(row).toContain('Emil');
    expect(wrapper.get(`[data-submission="${S1}"]`).text()).toContain('1 angewendet');
    expect(wrapper.get(`[data-submission="${S1}"]`).text()).toContain('1 fehlgeschlagen');

    await click(wrapper, `[data-submission="${S1}"] [data-open]`);
    await vi.waitFor(() => expect(router.currentRoute.value.query.submission).toBe(S1));
    const panel = await vi.waitFor(() => wrapper.get('[data-submission-detail]'));
    await vi.waitFor(() => expect(panel.find(`[data-change="${C2}"]`).exists()).toBe(true));
    expect(panel.get(`[data-change="${C1}"]`).text()).toContain('Angewendet');
    expect(panel.get(`[data-change="${C2}"]`).text()).toContain('Fehlgeschlagen');
    expect(panel.get(`[data-change="${C2}"]`).text()).toContain('Gebot zu niedrig. (BID_TOO_LOW)');
    // Schon erneut versucht: kein zweiter Versuch, aber der Hinweis mit Link.
    const retried = panel.get(`[data-change="${C3}"]`);
    expect(retried.text()).toContain('Erneut versucht: angewendet');
    expect(retried.find('[data-retry]').exists()).toBe(false);
    expect(retried.get('a').attributes('href')).toContain(`submission=${S2}`);
  });

  it('versucht fehlgeschlagene Änderungen erneut und verwirft sie', async () => {
    const { requests } = stubFetch(
      routes({
        'GET /api/ads/changes/submissions': json({ submissions: [submission(S1)] }),
        [`GET /api/ads/changes/submissions/${S1}`]: detail(),
        'POST /api/ads/changes/retry': json({
          submissions: [submission(S2, { status: 'pending' })],
          skipped: [],
          bulkFileSkipped: [],
        }),
        'POST /api/ads/changes/dismiss': json({ dismissed: 1 }),
      }),
    );
    const { wrapper } = await mountPage(`/ads/changes?tab=submissions&submission=${S1}`);
    await click(wrapper, `[data-change="${C2}"] [data-retry]`);
    expect(posts(requests, '/retry')).toEqual([{ changeIds: [C2], channel: 'api' }]);
    await vi.waitFor(() =>
      expect(wrapper.get('[data-action-notice]').text()).toContain(
        'Als neue Übermittlung eingeplant',
      ),
    );
    await click(wrapper, `[data-change="${C2}"] [data-dismiss]`);
    expect(posts(requests, '/dismiss')).toEqual([{ changeIds: [C2] }]);
  });

  it('nimmt eine Übermittlung zurück und fragt nach, wenn sich Werte seitdem geändert haben (F8)', async () => {
    const { requests } = stubFetch(
      routes({
        'GET /api/ads/changes/submissions': json({ submissions: [submission(S1)] }),
        [`GET /api/ads/changes/submissions/${S1}`]: detail(),
        'POST /api/ads/changes/revert': ({ body }) =>
          (body as { overwriteChanged?: boolean }).overwriteChanged
            ? json({
                status: 'submitted',
                submissions: [submission(S2, { status: 'pending' })],
                skipped: [{ changeId: C2, reason: 'notApplied' }],
                bulkFileSkipped: [],
              })
            : json({
                status: 'conflict',
                conflicts: [{ changeId: C1, expected: '0.80', current: '0.95' }],
                skipped: [],
              }),
      }),
    );
    const { wrapper } = await mountPage(`/ads/changes?tab=submissions&submission=${S1}`);
    await click(wrapper, '[data-revert-all]');
    expect(posts(requests, '/revert')).toEqual([{ submissionId: S1, channel: 'api' }]);
    const dialog = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role="dialog"]');
      if (!found) throw new Error('kein Dialog');
      return found;
    });
    expect(plain(dialog.textContent)).toContain('nistkasten meise · Genau');
    expect(plain(dialog.textContent)).toContain('übermittelt 0,80 €, jetzt 0,95 €');
    await click(wrapper, '[data-confirm-overwrite]');
    expect(posts(requests, '/revert')[1]).toEqual({
      submissionId: S1,
      channel: 'api',
      overwriteChanged: true,
    });
    await vi.waitFor(() =>
      expect(wrapper.get('[data-action-notice]').text()).toContain('1 übersprungen'),
    );
  });

  it('bietet für eine Bulk-Übermittlung Download und Abschließen von Hand, mit dem Stand der Kampagnen', async () => {
    const { requests } = stubFetch(
      routes({
        'GET /api/ads/changes/submissions': json({
          submissions: [submission(S1, { channel: 'bulk_file', status: 'pending' })],
        }),
        [`GET /api/ads/changes/submissions/${S1}`]: detail(
          { channel: 'bulk_file', status: 'pending' },
          [change(C1, { status: 'submitted', submissionId: S1 })],
        ),
        [`GET /api/ads/changes/submissions/${S1}/bulk-file`]: new Response('xlsx', {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition':
              'attachment; filename="profitbash-aenderungen-demo-de-2026-10-09.xlsx"',
          },
        }),
        [`POST /api/ads/changes/submissions/${S1}/close`]: json({ changes: 1 }),
      }),
    );
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const { wrapper } = await mountPage(`/ads/changes?tab=submissions&submission=${S1}`);
    const panel = await vi.waitFor(() => wrapper.get('[data-submission-detail]'));
    await vi.waitFor(() => expect(panel.find('[data-download]').exists()).toBe(true));
    expect(plain(panel.text())).toContain(
      'Portfolio und Enddatum der Kampagnen stammen vom Stand 01.10.2026',
    );
    expect(panel.find('[data-revert-all]').exists()).toBe(false);

    await click(wrapper, '[data-download]');
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(requests.some((r) => r.path.endsWith('/bulk-file'))).toBe(true);

    // Abschließen ist endgültig: erst nach Rückfrage.
    await click(wrapper, '[data-close="discarded"]');
    expect(posts(requests, `/submissions/${S1}/close`)).toEqual([]);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Die offene Änderung wird verworfen',
    );
    await click(wrapper, '[data-confirm-close]');
    expect(posts(requests, `/submissions/${S1}/close`)).toEqual([{ outcome: 'discarded' }]);
  });

  it('richtet die Knöpfe nach dem Stand des Folgeschritts: offen sperrt, verworfen gibt wieder frei', async () => {
    const followUp = (origin: 'retry' | 'revert', status: SubmittedAdChangeData['status']) => ({
      changeId: 'x',
      origin,
      status,
      submissionId: S2,
    });
    stubFetch(
      routes({
        'GET /api/ads/changes/submissions': json({ submissions: [submission(S1)] }),
        [`GET /api/ads/changes/submissions/${S1}`]: detail({}, [
          change('a1', { status: 'applied', followUp: followUp('revert', 'dismissed') }),
          change('a2', { status: 'applied', followUp: followUp('revert', 'failed') }),
          change('a3', { status: 'applied', field: 'state', before: 'ENABLED', after: 'ARCHIVED' }),
          change('f1', { status: 'failed', followUp: followUp('retry', 'dismissed') }),
          change('f2', { status: 'failed', followUp: followUp('retry', 'applied') }),
          change('f3', { status: 'failed', errorCode: 'SUPERSEDED' }),
        ]),
      }),
    );
    const { wrapper } = await mountPage(`/ads/changes?tab=submissions&submission=${S1}`);
    await vi.waitFor(() => expect(wrapper.find('[data-change="f3"]').exists()).toBe(true));
    const has = (id: string, action: string) =>
      wrapper.find(`[data-change="${id}"] [data-${action}]`).exists();
    expect([has('a1', 'revert'), has('a2', 'revert'), has('a3', 'revert')]).toEqual([
      true,
      false,
      false,
    ]);
    expect([has('f1', 'retry'), has('f2', 'retry'), has('f3', 'retry')]).toEqual([
      true,
      false,
      false,
    ]);
    // Verwerfen geht für jede fehlgeschlagene Änderung, auch mit Folgeversuch und für überholte.
    expect([has('f1', 'dismiss'), has('f2', 'dismiss'), has('f3', 'dismiss')]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('zeigt einen Fehler beim bestätigten Überschreiben statt ihn hinter der Rückfrage zu lassen', async () => {
    stubFetch(
      routes({
        'GET /api/ads/changes/submissions': json({ submissions: [submission(S1)] }),
        [`GET /api/ads/changes/submissions/${S1}`]: detail(),
        'POST /api/ads/changes/revert': ({ body }) =>
          (body as { overwriteChanged?: boolean }).overwriteChanged
            ? json({ error: { code: 'PROFILE_HAS_NO_CONNECTION', message: 'x' } }, 409)
            : json({
                status: 'conflict',
                conflicts: [{ changeId: C1, expected: '0.80', current: '0.95' }],
                skipped: [],
              }),
      }),
    );
    const { wrapper } = await mountPage(`/ads/changes?tab=submissions&submission=${S1}`);
    await click(wrapper, `[data-change="${C1}"] [data-revert]`);
    await click(wrapper, '[data-confirm-overwrite]');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-submission-detail]').text()).toContain(
        'Dieses Profil hat keine Verbindung zur API',
      ),
    );
    await vi.waitFor(() => expect(document.querySelector('[data-confirm-overwrite]')).toBeNull());
  });

  it('zeigt leere Liste, unbekannte Übermittlung und Viewern keine Aktionen', async () => {
    stubFetch(routes());
    const empty = await mountPage('/ads/changes?tab=submissions');
    await vi.waitFor(() => expect(empty.wrapper.text()).toContain('Noch keine Übermittlungen'));
    cleanupMounted();

    stubFetch(
      routes({
        [`GET /api/ads/changes/submissions/${S1}`]: json(
          { error: { code: 'SUBMISSION_NOT_FOUND', message: 'x' } },
          404,
        ),
      }),
    );
    const missing = await mountPage(`/ads/changes?tab=submissions&submission=${S1}`);
    await vi.waitFor(() =>
      expect(missing.wrapper.text()).toContain('Diese Übermittlung gibt es nicht (mehr)'),
    );
    cleanupMounted();

    stubFetch(
      routes(
        {
          'GET /api/ads/changes/submissions': json({ submissions: [submission(S1)] }),
          [`GET /api/ads/changes/submissions/${S1}`]: detail(),
        },
        meFixture({ orgRole: 'viewer' }),
      ),
    );
    const viewer = await mountPage(`/ads/changes?tab=submissions&submission=${S1}`);
    await vi.waitFor(() =>
      expect(viewer.wrapper.find(`[data-change="${C2}"]`).exists()).toBe(true),
    );
    for (const selector of [
      '[data-retry]',
      '[data-dismiss]',
      '[data-revert]',
      '[data-revert-all]',
    ]) {
      expect(viewer.wrapper.find(selector).exists()).toBe(false);
    }
  });
});
