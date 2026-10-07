import type {
  SearchTermAnalysisResponse,
  SearchTermNgram,
  SearchTermPeriod,
  SearchTermRow,
} from '@profitbash/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const PATH = '/ads/explorer/search-term-analysis';

const period = (patch: Partial<SearchTermPeriod> = {}): SearchTermPeriod => ({
  profileId: P1,
  accountName: 'Demo DE',
  countryCode: 'DE',
  currencyCode: 'EUR',
  clientId: null,
  periodStart: '2026-08-01',
  periodEnd: '2026-09-29',
  adProducts: ['SPONSORED_PRODUCTS'],
  rows: 3,
  importedAt: '2026-10-01T08:00:00.000Z',
  ...patch,
});

const periods = (): SearchTermPeriod[] => [
  period({ periodStart: '2026-09-01', periodEnd: '2026-09-30', rows: 2 }),
  period(),
  period({ profileId: P2, accountName: 'Demo UK', countryCode: 'UK', currencyCode: 'GBP' }),
];

const sums = {
  impressions: '1000',
  clicks: '40',
  cost: '20',
  sales: '100',
  purchases: '4',
  units: '5',
  ctr: '0.04',
  cpc: '0.5',
  cvr: '0.1',
  acos: '0.2',
  roas: '5',
};

let nextId = 0;
const row = (searchTerm: string, patch: Partial<SearchTermRow> = {}): SearchTermRow => ({
  id: `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
  adProduct: 'SPONSORED_PRODUCTS',
  searchTerm,
  amazonCampaignId: 'C1',
  amazonAdGroupId: 'AG1',
  amazonTargetId: 'T1',
  campaignId: null,
  campaignName: 'SP Lampen',
  adGroupId: null,
  adGroupName: 'AG Lampen',
  targetId: null,
  keywordText: 'lampe',
  matchType: 'BROAD',
  expression: null,
  ...sums,
  classification: 'watch',
  reason: 'tooFewData',
  protected: false,
  alreadyTargeted: false,
  ...patch,
});

const ngram = (gram: string, patch: Partial<SearchTermNgram> = {}): SearchTermNgram => ({
  size: gram.split(' ').length,
  gram,
  searchTerms: 2,
  ...sums,
  ...patch,
});

const rules = {
  harvestMinPurchases: 3,
  harvestMaxAcos: '0.25',
  negateMinClicks: 25,
  negateMinCost: '20',
};

function analysisResponse(
  patch: Partial<SearchTermAnalysisResponse> = {},
  meta: Partial<SearchTermAnalysisResponse['meta']> = {},
): SearchTermAnalysisResponse {
  const rows = [
    row('led lampe warmweiß', { classification: 'harvest', reason: null }),
    row('lampe billig', { classification: 'negate', reason: null, cost: '25.5', acos: null }),
    row('nordwind lampe', { reason: 'protected', protected: true }),
  ];
  return {
    meta: {
      profileId: P1,
      accountName: 'Demo DE',
      countryCode: 'DE',
      currency: 'EUR',
      clientId: null,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      importedAt: '2026-10-01T08:00:00.000Z',
      rules,
      rulesAreDefault: true,
      protectedTerms: ['nordwind'],
      totalRows: rows.length,
      truncated: false,
      maxRows: 10000,
      totalNgrams: 2,
      ngramsTruncated: false,
      maxNgrams: 5000,
      ...meta,
    },
    total: { ...sums, cost: '1234.5', sales: '4938', acos: '0.25' },
    counts: { harvest: 1, negate: 1, watch: 1 },
    rows,
    ngrams: [ngram('lampe', { searchTerms: 3 }), ngram('led lampe')],
    ...patch,
  };
}

type Responder = (request: RecordedRequest) => Response | Promise<Response>;

function routes(overrides: Record<string, Responder | Response> = {}) {
  return {
    'GET /api/me': json(meFixture()),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'POST /api/ads/search-terms/periods': json({ periods: periods() }),
    'POST /api/ads/search-terms/analysis': json(analysisResponse()),
    ...overrides,
  };
}

async function mountPage(path = PATH, overrides: Record<string, Responder | Response> = {}) {
  const stub = stubFetch(routes(overrides));
  const mounted = await mountWithApp(undefined, { path });
  await flushPromises();
  return { ...mounted, ...stub };
}

/** AG Grid zeichnet Zeilen asynchron: auf jede gelesene Zeile warten. */
async function waitForRow(text: string) {
  await vi.waitFor(() => expect(document.body.textContent).toContain(text), { timeout: 3000 });
}

const analysisRequests = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.path === '/api/ads/search-terms/analysis').map((r) => r.body);

const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim().includes(label));

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Suchbegriff-Analyse', () => {
  it('wählt das erste Profil mit seinem neuesten Datei-Zeitraum und lädt genau diesen', async () => {
    const { requests, router } = await mountPage();
    await waitForRow('led lampe warmweiß');
    expect(analysisRequests(requests)).toEqual([
      { profileId: P1, periodStart: '2026-09-01', periodEnd: '2026-09-30' },
    ]);
    expect(router.currentRoute.value.query).toMatchObject({
      profile: P1,
      from: '2026-09-01',
      to: '2026-09-30',
    });
    const text = document.body.textContent ?? '';
    expect(text).toContain('01.09.2026 – 30.09.2026');
    // Kein freier Zeitraum: Der Hinweis erklärt die Datei-Zeiträume.
    expect(text).toContain('Zeiträume verschiedener Dateien werden nie addiert');
  });

  it('zeigt Einstufung mit Grund, Summen in der Profilwährung und die geltenden Regeln', async () => {
    await mountPage();
    await waitForRow('led lampe warmweiß');
    await waitForRow('nordwind lampe');
    const text = document.body.textContent ?? '';
    expect(text).toContain('Ernten');
    expect(text).toContain('Negieren');
    expect(text).toContain('Beobachten · Geschützter Begriff');
    expect(text).toContain('1.234,50 €');
    expect(text).toContain('25,0 %');
    // Regeln: Startwerte sind als vorläufig gekennzeichnet.
    expect(text).toContain('ab 3 Käufen');
    expect(text).toContain('ab 25 Klicks');
    expect(text).toContain('Startwerte');
  });

  it('ist als Reiter im Explorer erreichbar und führt zurück zu den Ebenen', async () => {
    await mountPage();
    const nav = document.querySelector('nav[aria-label="Ebenen"]');
    const current = nav?.querySelector('[aria-current="page"]');
    expect(current?.textContent).toContain('Suchbegriff-Analyse');
    const campaigns = [...(nav?.querySelectorAll('a') ?? [])].find((a) =>
      a.textContent?.includes('Kampagnen'),
    );
    expect(campaigns?.getAttribute('href')).toBe('/ads/explorer/campaigns');
  });

  it('lädt den Zeitraum aus der URL und wechselt das Profil auf dessen neuesten Zeitraum', async () => {
    const { requests } = await mountPage(`${PATH}?profile=${P1}&from=2026-08-01&to=2026-09-29`);
    await waitForRow('led lampe warmweiß');
    expect(analysisRequests(requests)).toEqual([
      { profileId: P1, periodStart: '2026-08-01', periodEnd: '2026-09-29' },
    ]);
  });

  it('ersetzt unbekannte URL-Angaben durch die erste gültige Auswahl', async () => {
    const { requests } = await mountPage(`${PATH}?profile=${P2}&from=2020-01-01&to=2020-01-31`);
    await waitForRow('led lampe warmweiß');
    expect(analysisRequests(requests)).toEqual([
      { profileId: P2, periodStart: '2026-08-01', periodEnd: '2026-09-29' },
    ]);
  });

  it('filtert die Zeilen über die Einstufungs-Kacheln', async () => {
    const { router } = await mountPage();
    await waitForRow('led lampe warmweiß');
    button('Negieren')!.click();
    await flushPromises();
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('led lampe warmweiß'));
    await waitForRow('lampe billig');
    expect(router.currentRoute.value.query.class).toBe('negate');
    expect(button('Negieren')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('zeigt die Wortbausteine (N-Gramme) als eigene Ansicht', async () => {
    const { router } = await mountPage();
    await waitForRow('led lampe warmweiß');
    button('Wortbausteine')!.click();
    await flushPromises();
    expect(router.currentRoute.value.query.view).toBe('ngrams');
    await waitForRow('led lampe');
    const text = document.body.textContent ?? '';
    expect(text).toContain('Wörter');
    expect(text).not.toContain('led lampe warmweiß');
  });

  it('nennt gekürzte Zeilen', async () => {
    await mountPage(PATH, {
      'POST /api/ads/search-terms/analysis': json(
        analysisResponse({}, { totalRows: 12345, truncated: true }),
      ),
    });
    await waitForRow('led lampe warmweiß');
    expect(document.body.textContent).toContain('10.000');
    expect(document.body.textContent).toContain('12.345');
  });

  it('zeigt einen Leerzustand ohne Datei-Zeiträume und fragt dann keine Analyse an', async () => {
    const { requests } = await mountPage(PATH, {
      'POST /api/ads/search-terms/periods': json({ periods: [] }),
    });
    expect(document.body.textContent).toContain('Noch keine Suchbegriffe');
    expect(analysisRequests(requests)).toEqual([]);
  });

  it('zeigt Skelette beim Laden und einen Fehler mit „Erneut versuchen“', async () => {
    let fail = true;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { requests } = await mountPage(PATH, {
      'POST /api/ads/search-terms/analysis': async () => {
        await gate;
        if (fail) return json({ error: { code: 'INTERNAL', message: 'kaputt' } }, 500);
        return json(analysisResponse());
      },
    });
    expect(document.querySelectorAll('[data-skeleton]').length).toBeGreaterThan(0);
    release!();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(document.querySelectorAll('[data-skeleton]')).toHaveLength(0);
    fail = false;
    button('Erneut versuchen')!.click();
    await waitForRow('led lampe warmweiß');
    expect(analysisRequests(requests)).toHaveLength(2);
  });

  it('zeigt einen Fehler, wenn die Zeiträume nicht laden', async () => {
    await mountPage(PATH, {
      'POST /api/ads/search-terms/periods': json(
        { error: { code: 'INTERNAL', message: 'x' } },
        500,
      ),
    });
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe('Regeln ändern', () => {
  it('bietet Viewern keinen Knopf an', async () => {
    await mountPage(PATH, { 'GET /api/me': json(meFixture({ orgRole: 'viewer' })) });
    await waitForRow('led lampe warmweiß');
    expect(button('Regeln ändern')).toBeUndefined();
  });

  it('speichert Regeln (ACoS als Prozent eingegeben, als Bruch gesendet) und lädt die Analyse neu', async () => {
    const saved = { ...rules, harvestMaxAcos: '0.305', negateMinCost: '12.50' };
    const { requests } = await mountPage(PATH, {
      'PUT /api/ads/search-terms/rules': json({
        rules: saved,
        isDefault: false,
        updatedAt: '2026-10-07T20:00:00.000Z',
      }),
    });
    await waitForRow('led lampe warmweiß');
    button('Regeln ändern')!.click();
    await flushPromises();

    const input = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!;
    expect(input('rules-harvest-acos').value).toBe('25');
    expect(input('rules-negate-cost').value).toBe('20');
    const type = (id: string, value: string) => {
      input(id).value = value;
      input(id).dispatchEvent(new Event('input'));
    };
    type('rules-harvest-acos', '30,5');
    type('rules-negate-cost', '12,50');
    await flushPromises();
    button('Speichern')!.click();
    await flushPromises();

    const put = requests.find((r) => r.method === 'PUT');
    expect(put?.body).toEqual(saved);
    await vi.waitFor(() => expect(analysisRequests(requests)).toHaveLength(2));
    expect(document.querySelector('#rules-harvest-acos')).toBeNull();
  });

  it('lehnt ungültige Eingaben ab, ohne zu senden', async () => {
    const { requests } = await mountPage();
    await waitForRow('led lampe warmweiß');
    button('Regeln ändern')!.click();
    await flushPromises();
    const acos = document.querySelector<HTMLInputElement>('#rules-harvest-acos')!;
    acos.value = '0';
    acos.dispatchEvent(new Event('input'));
    await flushPromises();
    button('Speichern')!.click();
    await flushPromises();
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
    expect(document.querySelector('[role="dialog"] [role="alert"]')).not.toBeNull();
  });
});
