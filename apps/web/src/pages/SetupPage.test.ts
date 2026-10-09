import { DEFAULT_STRUCTURE_CATALOG } from '@profitbash/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Seite „Kampagnen-Setup“ (`phase-4.md` 4.5): planen, Entwurf speichern, übermitteln. */

const P1 = '00000000-0000-4000-8000-0000000000a1';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const G1 = '00000000-0000-4000-8000-0000000000b1';
const D1 = '00000000-0000-4000-8000-0000000000d1';
const S1 = '00000000-0000-4000-8000-0000000000e1';

const campaign = (name: string, overrides: Record<string, unknown> = {}) => ({
  block: 'SP-KW-EXACT',
  adProduct: 'SP',
  targeting: 'keyword',
  name,
  state: 'ENABLED',
  currencyCode: 'EUR',
  dailyBudget: '25.00',
  biddingStrategy: 'SALES_DOWN_ONLY',
  sdOptimization: null,
  costType: 'cpc',
  offAmazon: false,
  placements: { topOfSearch: 20, productPages: 0, restOfSearch: 0 },
  adGroup: { name, defaultBid: '0.85' },
  ads: [{ asin: 'B0FLASCHE1', sku: 'FL-750' }],
  targets: [{ type: 'keyword', text: 'trinkflasche', matchType: 'exact', bid: '0.90' }],
  negatives: [],
  ...overrides,
});
const inputs = { keywords: [], brandTerms: [], productTargets: [], categories: [], unlocks: {} };
const draft = {
  id: D1,
  profileId: P1,
  productGroupId: G1,
  presetKey: 'launch',
  name: 'Flaschen Start',
  status: 'draft',
  campaignState: 'ENABLED',
  version: 1,
  submissionId: null,
  createdBy: null,
  updatedBy: null,
  submittedAt: null,
  createdAt: '2026-10-09T08:00:00.000Z',
  updatedAt: '2026-10-09T08:00:00.000Z',
  inputs,
  campaigns: [campaign('SP | EXACT | Flaschen')],
};

type Responder = (request: RecordedRequest) => Response | Promise<Response>;
function routes(overrides: Record<string, Responder | Response> = {}) {
  return {
    'GET /api/me': json(meFixture()),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/ads/changes/pending': json({ changes: [], check: null }),
    'GET /api/ads/tools/product-groups': json({
      groups: [
        {
          id: G1,
          profileId: P1,
          name: 'Flaschen',
          presetKey: null,
          items: [{ asin: 'B0FLASCHE1', sku: 'FL-750', isHero: true }],
          createdAt: '2026-10-09T08:00:00.000Z',
          updatedAt: '2026-10-09T08:00:00.000Z',
        },
      ],
      profiles: [
        {
          id: P1,
          accountName: 'Waldkauz DE',
          countryCode: 'DE',
          accountType: 'seller',
          clientId: C1,
        },
      ],
      clients: [{ id: C1, name: 'Waldkauz' }],
      maxGroups: 2000,
      maxItems: 100,
    }),
    'GET /api/ads/tools/catalog': json({
      catalog: DEFAULT_STRUCTURE_CATALOG,
      version: 0,
      updatedAt: null,
      clientPresets: [{ clientId: C1, presetKey: 'launch' }],
      productGroupPresets: [],
      clients: [{ id: C1, name: 'Waldkauz' }],
    }),
    'GET /api/ads/tools/setup/drafts': json({
      drafts: [{ ...draft, campaigns: 1, createdByName: 'Ada' }],
    }),
    [`GET /api/ads/tools/setup/drafts/${D1}`]: json(draft),
    'POST /api/ads/tools/setup/plan': json({
      campaigns: [
        campaign('SP | AUTO | Flaschen', { block: 'SP-AUTO', targeting: 'auto', targets: [] }),
        campaign('SP | EXACT | Flaschen'),
      ],
      hints: [
        {
          severity: 'warning',
          code: 'keywordAlreadyExact',
          keyword: 'trinkflasche',
          existing: 'Alt',
        },
      ],
      eurRate: { rate: '1', date: '2026-10-09' },
      profileBids: {},
    }),
    'POST /api/ads/tools/setup/drafts': json({ ...draft, id: D1 }, 201),
    ...overrides,
  };
}

async function mountPage(overrides: Record<string, Responder | Response> = {}) {
  const stub = stubFetch(routes(overrides));
  const mounted = await mountWithApp(undefined, { path: '/ads/tools/setup' });
  await flushPromises();
  return { ...mounted, ...stub };
}

const found = <T extends Element>(selector: string) =>
  vi.waitFor(() => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`nicht gefunden: ${selector}`);
    return element;
  });
async function type(selector: string, value: string) {
  const input = await found<HTMLInputElement | HTMLTextAreaElement>(selector);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}
async function choose(selector: string, value: string) {
  const select = await found<HTMLSelectElement>(selector);
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await flushPromises();
}
async function click(selector: string) {
  (await found<HTMLElement>(selector)).click();
  await flushPromises();
}
const body = (requests: RecordedRequest[], method: string, path: string) =>
  requests.find((r) => r.method === method && r.path === path)?.body as Record<string, unknown>;

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Seite „Kampagnen-Setup“', () => {
  it('listet die Entwürfe des Teams', async () => {
    await mountPage();
    const item = await found(`[data-draft="${D1}"]`);
    expect(item.textContent).toContain('Flaschen Start');
    expect(item.textContent).toContain('Ada');
  });

  it('zeigt einen leeren Zustand ohne Entwürfe', async () => {
    await mountPage({ 'GET /api/ads/tools/setup/drafts': json({ drafts: [] }) });
    expect((await found('[data-setup-empty]')).textContent).toContain('Noch keine Entwürfe');
  });

  it('plant aus Profil, Produktgruppe, Preset und Keywords und speichert pausiert', async () => {
    const { requests } = await mountPage();
    await click('[data-setup-new]');
    await choose('[data-setup-profile]', P1);
    await choose('[data-setup-group]', G1);
    // Vorbelegt: Preset des Clients.
    expect((await found<HTMLSelectElement>('[data-setup-preset]')).value).toBe('launch');
    await type('[data-setup-keywords]', 'trinkflasche\ntrinkflasche edelstahl\n');
    await type('[data-setup-single]', 'trinkflasche 1l');
    await click('[data-setup-plan]');

    expect(body(requests, 'POST', '/api/ads/tools/setup/plan')).toMatchObject({
      profileId: P1,
      productGroupId: G1,
      presetKey: 'launch',
      useProfileBids: true,
      inputs: {
        keywords: [
          { text: 'trinkflasche' },
          { text: 'trinkflasche edelstahl' },
          { text: 'trinkflasche 1l', single: true },
        ],
      },
    });
    const rows = document.querySelectorAll('[data-setup-campaign]');
    expect([...rows].map((row) => row.querySelector('[data-campaign-name]')?.textContent)).toEqual([
      'SP | AUTO | Flaschen',
      'SP | EXACT | Flaschen',
    ]);
    expect((await found('[data-setup-hints]')).textContent).toContain('schon exakt gebucht');
    expect((await found('[data-setup-state-note]')).textContent).toContain('aktiv');

    await click('[data-setup-paused]');
    expect((await found('[data-setup-state-note]')).textContent).toContain('pausiert');
    await type('[data-setup-name]', 'Flaschen Start');
    await click('[data-setup-save]');
    expect(body(requests, 'POST', '/api/ads/tools/setup/drafts')).toMatchObject({
      profileId: P1,
      productGroupId: G1,
      presetKey: 'launch',
      name: 'Flaschen Start',
      campaignState: 'PAUSED',
      campaigns: [{ name: 'SP | AUTO | Flaschen' }, { name: 'SP | EXACT | Flaschen' }],
    });
  });

  it('übermittelt einen Entwurf als Bulk-Datei und verweist auf die Seite „Änderungen“', async () => {
    const { requests } = await mountPage({
      [`POST /api/ads/tools/setup/drafts/${D1}/submit`]: json({
        status: 'submitted',
        submission: {
          id: S1,
          profileId: P1,
          accountName: 'Waldkauz DE',
          countryCode: 'DE',
          channel: 'bulk_file',
          kind: 'setup',
          status: 'pending',
          error: null,
          createdBy: null,
          createdByName: null,
          createdAt: '2026-10-09T08:00:00.000Z',
          startedAt: null,
          finishedAt: null,
          changes: 5,
          counts: { submitted: 5, applied: 0, failed: 0, dismissed: 0 },
        },
        items: 5,
        unsupported: 0,
        issues: [],
      }),
    });
    await click(`[data-draft="${D1}"] [data-draft-open]`);
    await click('[data-setup-submit]');
    expect(body(requests, 'POST', `/api/ads/tools/setup/drafts/${D1}/submit`)).toEqual({
      version: 1,
      channel: 'bulk_file',
    });
    const done = await found('[data-setup-submitted]');
    expect(done.querySelector('a')?.getAttribute('href')).toBe('/ads/changes');
  });

  it('zeigt Fehler der Prüfung beim Übermitteln', async () => {
    await mountPage({
      [`POST /api/ads/tools/setup/drafts/${D1}/submit`]: json({
        status: 'rejected',
        issues: [
          { severity: 'error', code: 'campaignNameTaken', campaign: 'SP | EXACT | Flaschen' },
        ],
      }),
    });
    await click(`[data-draft="${D1}"] [data-draft-open]`);
    await click('[data-setup-submit]');
    expect((await found('[data-setup-issues]')).textContent).toContain('schon vergeben');
    expect(document.querySelector('[data-setup-submitted]')).toBeNull();
  });
});
