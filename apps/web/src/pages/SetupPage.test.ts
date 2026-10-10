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
const inputs = {
  keywords: [],
  brandTerms: [],
  productTargets: [],
  categories: [],
  harvest: [],
  unlocks: {},
};
const M1 = '00000000-0000-4000-8000-0000000000f1';
const M2 = '00000000-0000-4000-8000-0000000000f2';
const harvestMark = (id: string, searchTerm: string, overrides: Record<string, unknown> = {}) => ({
  id,
  searchTerm,
  adProduct: 'SPONSORED_PRODUCTS',
  campaignName: 'SP | AUTO | Alt',
  adGroupName: 'Auto',
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  clicks: 10,
  cost: '7.80',
  sales: '30.00',
  purchases: 2,
  currencyCode: 'EUR',
  cpc: '0.78',
  createdAt: '2026-10-01T08:00:00.000Z',
  ...overrides,
});
const sourceNegative = {
  markId: M1,
  searchTerm: 'trinkflasche glas',
  amazonCampaignId: '111',
  amazonAdGroupId: '222',
  campaignName: 'SP | AUTO | Alt',
  adGroupName: 'Auto',
  negative: { type: 'keyword', text: 'trinkflasche glas', matchType: 'negativeExact' },
  selected: true,
};
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
  sourceNegatives: [],
  portfolioId: null,
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
      sourceNegatives: [],
      eurRate: { rate: '1', date: '2026-10-09' },
      profileBids: {},
    }),
    'GET /api/ads/tools/setup/harvest': json({ marks: [], truncated: false }),
    'GET /api/ads/tools/portfolios': json({ portfolios: [], pending: [] }),
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
    expect(done.querySelector('a')?.getAttribute('href')).toBe(
      `/ads/changes?tab=submissions&submission=${S1}`,
    );
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

  it('nennt den fehlenden Tageskurs und gleichzeitige Änderungen verständlich', async () => {
    await mountPage({
      'POST /api/ads/tools/setup/plan': json(
        { error: { code: 'CAMPAIGN_SETUP_FX_RATE_MISSING', message: 'x' } },
        409,
      ),
    });
    await click('[data-setup-new]');
    await choose('[data-setup-profile]', P1);
    await choose('[data-setup-group]', G1);
    await click('[data-setup-plan]');
    expect((await found('[data-setup-editor]')).textContent).toContain('Tageskurs');
  });

  it('gibt das Übermitteln frei, wenn der Nutzer die gemeldete Kampagne korrigiert oder entfernt', async () => {
    await mountPage({
      'POST /api/ads/tools/setup/plan': json({
        campaigns: [campaign('A'), campaign('B')],
        sourceNegatives: [],
        hints: [
          {
            severity: 'error',
            code: 'budgetOutOfRange',
            campaign: 'A',
            value: '25.00',
            min: '30',
            max: '1000',
          },
          { severity: 'error', code: 'campaignNameInvalid', campaign: 'B', issue: 'tooLong' },
        ],
        eurRate: { rate: '1', date: '2026-10-09' },
        profileBids: { keyword: { exact: '0.71' } },
      }),
    });
    await click('[data-setup-new]');
    await choose('[data-setup-profile]', P1);
    await choose('[data-setup-group]', G1);
    await click('[data-setup-plan]');
    await type('[data-setup-name]', 'X');
    const submit = () => document.querySelector<HTMLButtonElement>('[data-setup-submit]')!;
    expect(submit().disabled).toBe(true);
    // Gebote aus dem Profil: übersetzt und als Zahl formatiert.
    expect(document.body.textContent).toContain('exakt 0,71');

    await type('[data-campaign-budget="A"]', '35.00');
    expect(submit().disabled).toBe(true);
    await click('[data-campaign-remove="B"]');
    expect(submit().disabled).toBe(false);
    expect(document.querySelector('[data-setup-hints]')).toBeNull();
  });

  it('schützt ungespeicherte Änderungen beim Schließen; „Öffnen“ gibt es erst nach dem Schließen', async () => {
    await mountPage();
    await click(`[data-draft="${D1}"] [data-draft-open]`);
    expect(document.querySelector('[data-draft-open]')).toBeNull();
    await type('[data-setup-name]', 'Neuer Name');
    await click('[data-setup-close]');
    expect(document.querySelector('[data-setup-editor]')).not.toBeNull();
    expect((await found('[data-setup-confirm-close]')).textContent).toContain('nicht gespeichert');
    await click('[data-setup-confirm-close] [data-confirm]');
    expect(document.querySelector('[data-setup-editor]')).toBeNull();
    expect(document.querySelector('[data-draft-open]')).not.toBeNull();
  });

  describe('Harvest von der Merkliste (4.6)', () => {
    const harvestRoutes = {
      'GET /api/ads/tools/setup/harvest': json({
        marks: [
          harvestMark(M1, 'trinkflasche glas'),
          harvestMark(M2, 'b0fremd001', { cpc: null, clicks: 0, cost: '0.00' }),
        ],
        truncated: false,
      }),
      'POST /api/ads/tools/setup/plan': json({
        campaigns: [campaign('SP | EXACT | Flaschen')],
        sourceNegatives: [sourceNegative],
        hints: [{ severity: 'info', code: 'sourceProtected', keyword: 'nordwind becher' }],
        eurRate: { rate: '1', date: '2026-10-09' },
        profileBids: {},
      }),
    };

    it('übernimmt Begriffe der Merkliste mit Gebot und schlägt das Negativ in der Quelle vor', async () => {
      const { requests } = await mountPage(harvestRoutes);
      await click('[data-setup-new]');
      await choose('[data-setup-profile]', P1);
      await choose('[data-setup-group]', G1);
      const row = await found(`[data-harvest-mark="${M1}"]`);
      expect(row.textContent).toContain('trinkflasche glas');
      expect(row.textContent).toContain('SP | AUTO | Alt');
      await click(`[data-harvest-mark="${M1}"] [data-harvest-pick]`);
      await type(`[data-harvest-mark="${M1}"] [data-harvest-bid]`, '1.10');
      await click(`[data-harvest-mark="${M2}"] [data-harvest-pick]`);
      await click(`[data-harvest-mark="${M2}"] [data-harvest-single]`);
      await click('[data-setup-plan]');

      expect(body(requests, 'POST', '/api/ads/tools/setup/plan')).toMatchObject({
        inputs: {
          harvest: [
            { markId: M1, bid: '1.10' },
            { markId: M2, single: true },
          ],
        },
        deselectedSources: [],
      });
      const proposal = await found('[data-source-negative]');
      expect(proposal.textContent).toContain('trinkflasche glas');
      expect(proposal.textContent).toContain('SP | AUTO | Alt');
      expect((await found('[data-setup-hints]')).textContent).toContain('nordwind becher');

      await click('[data-source-negative] input[type="checkbox"]');
      await type('[data-setup-name]', 'Harvest');
      await click('[data-setup-save]');
      expect(body(requests, 'POST', '/api/ads/tools/setup/drafts')).toMatchObject({
        inputs: {
          harvest: [
            { markId: M1, bid: '1.10' },
            { markId: M2, single: true },
          ],
        },
        sourceNegatives: [{ markId: M1, selected: false }],
      });

      requests.length = 0;
      await click('[data-setup-plan]');
      expect(body(requests, 'POST', '/api/ads/tools/setup/plan')).toMatchObject({
        deselectedSources: [M1],
      });
    });

    it('übernimmt mehrere Begriffe, auch bei schnell aufeinander folgenden Klicks', async () => {
      const { requests } = await mountPage(harvestRoutes);
      await click('[data-setup-new]');
      await choose('[data-setup-profile]', P1);
      await choose('[data-setup-group]', G1);
      await found(`[data-harvest-mark="${M2}"]`);
      document
        .querySelectorAll<HTMLInputElement>('[data-harvest-pick]')
        .forEach((box) => box.click());
      await flushPromises();
      await click('[data-setup-plan]');
      expect(body(requests, 'POST', '/api/ads/tools/setup/plan')).toMatchObject({
        inputs: { harvest: [{ markId: M1 }, { markId: M2 }] },
      });
    });

    it('erklärt ein ungültiges Gebot und sperrt das Planen', async () => {
      await mountPage(harvestRoutes);
      await click('[data-setup-new]');
      await choose('[data-setup-profile]', P1);
      await choose('[data-setup-group]', G1);
      await click(`[data-harvest-mark="${M1}"] [data-harvest-pick]`);
      await type(`[data-harvest-mark="${M1}"] [data-harvest-bid]`, '1,10');
      expect((await found('[data-harvest-invalid]')).textContent).toContain('Gebot');
      expect((await found<HTMLButtonElement>('[data-setup-plan]')).disabled).toBe(true);
    });

    it('nimmt Einträge, die nicht mehr auf der Merkliste stehen, aus einem Entwurf', async () => {
      const gone = '00000000-0000-4000-8000-0000000000f9';
      const { requests } = await mountPage({
        ...harvestRoutes,
        [`GET /api/ads/tools/setup/drafts/${D1}`]: json({
          ...draft,
          inputs: { ...inputs, harvest: [{ markId: M1 }, { markId: gone }] },
        }),
      });
      await click(`[data-draft="${D1}"] [data-draft-open]`);
      await found(`[data-harvest-mark="${M1}"]`);
      await click('[data-setup-plan]');
      expect(body(requests, 'POST', '/api/ads/tools/setup/plan')).toMatchObject({
        inputs: { harvest: [{ markId: M1 }] },
      });
    });

    it('leert Auswahl und Vorschläge beim Wechsel des Profils', async () => {
      const P2 = '00000000-0000-4000-8000-0000000000a2';
      const groupsResponse = routes()['GET /api/ads/tools/product-groups'] as Response;
      const groups = (await groupsResponse.clone().json()) as { profiles: object[] };
      await mountPage({
        ...harvestRoutes,
        'GET /api/ads/tools/product-groups': json({
          ...groups,
          profiles: [
            ...groups.profiles,
            {
              id: P2,
              accountName: 'Waldkauz FR',
              countryCode: 'FR',
              accountType: 'seller',
              clientId: C1,
            },
          ],
        }),
      });
      await click('[data-setup-new]');
      await choose('[data-setup-profile]', P1);
      await choose('[data-setup-group]', G1);
      await click(`[data-harvest-mark="${M1}"] [data-harvest-pick]`);
      await click('[data-setup-plan]');
      await found('[data-source-negative]');
      await choose('[data-setup-profile]', P2);
      expect(document.querySelector('[data-source-negative]')).toBeNull();
      await choose('[data-setup-profile]', P1);
      const pick = await found<HTMLInputElement>(`[data-harvest-mark="${M1}"] [data-harvest-pick]`);
      expect(pick.checked).toBe(false);
    });

    it('zeigt einen leeren Zustand ohne vorgemerkte Begriffe', async () => {
      await mountPage();
      await click('[data-setup-new]');
      await choose('[data-setup-profile]', P1);
      expect((await found('[data-harvest-empty]')).textContent).toContain('Keine Begriffe');
    });

    it('zeigt einen Fehler der Merkliste, ohne den Assistenten zu sperren', async () => {
      await mountPage({
        'GET /api/ads/tools/setup/harvest': json({ error: { code: 'X', message: 'x' } }, 500),
      });
      await click('[data-setup-new]');
      await choose('[data-setup-profile]', P1);
      await found('[data-harvest-error]');
      expect(document.querySelector('[data-setup-keywords]')).not.toBeNull();
    });
  });

  it('ordnet die neuen Kampagnen einem bestehenden Portfolio zu (4.7)', async () => {
    const PF1 = '00000000-0000-4000-8000-0000000000b9';
    const { requests } = await mountPage({
      'GET /api/ads/tools/portfolios': json({
        portfolios: [
          {
            id: PF1,
            amazonPortfolioId: '7001',
            name: 'Bestand',
            state: 'ENABLED',
            budgetAmount: null,
            budgetCurrencyCode: null,
            budgetPolicy: null,
            budgetStartDate: null,
            budgetEndDate: null,
            campaigns: 2,
          },
        ],
        pending: [
          {
            itemId: '00000000-0000-4000-8000-0000000000f7',
            submissionId: S1,
            name: 'Unterwegs',
            status: 'applied',
            budget: null,
            createdAt: '2026-10-10T08:00:00.000Z',
          },
        ],
      }),
    });
    await click('[data-setup-new]');
    await choose('[data-setup-profile]', P1);
    await choose('[data-setup-group]', G1);
    await choose('[data-setup-portfolio]', PF1);
    expect((await found('[data-setup-portfolio-pending]')).textContent).toContain('Unterwegs');
    await click('[data-setup-plan]');
    await type('[data-setup-name]', 'Mit Portfolio');
    await click('[data-setup-save]');
    expect(body(requests, 'POST', '/api/ads/tools/setup/drafts')).toMatchObject({
      portfolioId: PF1,
    });
  });
});
