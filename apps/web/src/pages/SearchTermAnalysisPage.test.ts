import type {
  SearchTermAnalysisResponse,
  SearchTermNgram,
  SearchTermPeriod,
  SearchTermRow,
} from '@profitbash/shared';
import { flushPromises } from '@vue/test-utils';
import Select from 'primevue/select';
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
  // Ohne eigene Angabe: ein Target, über alle Targets wie die Zeile.
  termClassification: patch.classification ?? 'watch',
  termReason: patch.reason === undefined ? 'tooFewData' : patch.reason,
  termTargets: 1,
  termOnlyAcrossTargets: false,
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
    termCounts: { harvest: 1, negate: 1, watch: 1 },
    termCountsOnlyAcrossTargets: { harvest: 0, negate: 0 },
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

  it('lädt den Zeitraum aus der URL', async () => {
    const { requests } = await mountPage(`${PATH}?profile=${P1}&from=2026-08-01&to=2026-09-29`);
    await waitForRow('led lampe warmweiß');
    expect(analysisRequests(requests)).toEqual([
      { profileId: P1, periodStart: '2026-08-01', periodEnd: '2026-09-29' },
    ]);
  });

  it('ersetzt unbekannte URL-Angaben durch die erste gültige Auswahl (auch in der URL)', async () => {
    const { requests, router } = await mountPage(
      `${PATH}?profile=${P2}&from=2020-01-01&to=2020-01-31`,
    );
    await waitForRow('led lampe warmweiß');
    expect(analysisRequests(requests)).toEqual([
      { profileId: P2, periodStart: '2026-08-01', periodEnd: '2026-09-29' },
    ]);
    expect(router.currentRoute.value.query).toMatchObject({
      profile: P2,
      from: '2026-08-01',
      to: '2026-09-29',
    });
  });

  it('wechselt Profil (auf dessen neuesten Zeitraum) und Zeitraum mit Verlaufseintrag; Zurück stellt die Auswahl wieder her', async () => {
    const { requests, router, wrapper } = await mountPage();
    await waitForRow('led lampe warmweiß');
    const [profile, range] = wrapper.findAllComponents(Select);

    profile!.vm.$emit('update:modelValue', P2);
    await flushPromises();
    expect(router.currentRoute.value.query).toMatchObject({
      profile: P2,
      from: '2026-08-01',
      to: '2026-09-29',
    });
    await vi.waitFor(() =>
      expect(analysisRequests(requests).at(-1)).toEqual({
        profileId: P2,
        periodStart: '2026-08-01',
        periodEnd: '2026-09-29',
      }),
    );

    router.back();
    await vi.waitFor(() => expect(router.currentRoute.value.query.profile).toBe(P1));
    await flushPromises();
    range!.vm.$emit('update:modelValue', '2026-08-01_2026-09-29');
    await flushPromises();
    expect(router.currentRoute.value.query).toMatchObject({
      profile: P1,
      from: '2026-08-01',
      to: '2026-09-29',
    });
  });

  it('zeigt Beträge in der Währung des gewählten Profils', async () => {
    await mountPage(`${PATH}?profile=${P2}&from=2026-08-01&to=2026-09-29`, {
      'POST /api/ads/search-terms/analysis': json(
        analysisResponse({}, { profileId: P2, currency: 'GBP' }),
      ),
    });
    await waitForRow('led lampe warmweiß');
    expect(document.body.textContent).toContain('1.234,50\u00a0£');
  });

  it('ergänzt die Auswahl wieder, wenn die URL sie verliert (Klick auf den eigenen Reiter)', async () => {
    const { router } = await mountPage();
    await waitForRow('led lampe warmweiß');
    await router.push(PATH);
    await flushPromises();
    expect(router.currentRoute.value.query).toMatchObject({ profile: P1, from: '2026-09-01' });
  });

  it('leitet beim Verlassen der Seite nicht zurück', async () => {
    const { router } = await mountPage(`${PATH}?profile=${P2}&from=2026-08-01&to=2026-09-29`);
    await waitForRow('led lampe warmweiß');
    await router.push('/admin/connections');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/admin/connections');
    expect(router.currentRoute.value.query.profile).toBeUndefined();
  });

  it('meldet einen Fehler beim Neuladen, auch wenn noch alte Daten zu sehen sind', async () => {
    let calls = 0;
    const { queryClient } = await mountPage(PATH, {
      'POST /api/ads/search-terms/analysis': () =>
        ++calls === 1
          ? json(analysisResponse())
          : json({ error: { code: 'INTERNAL', message: 'kaputt' } }, 500),
    });
    await waitForRow('led lampe warmweiß');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await queryClient.invalidateQueries({ queryKey: ['search-terms'] });
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(document.body.textContent).toContain('led lampe warmweiß');
    expect(document.body.textContent).toContain('nicht aktuell');
  });

  it('nimmt den Einstufungs-Filter nicht mit in die Wortbausteine', async () => {
    const { router } = await mountPage(`${PATH}?class=negate`);
    await waitForRow('lampe billig');
    button('Wortbausteine')!.click();
    await flushPromises();
    expect(router.currentRoute.value.query.class).toBeUndefined();
    expect(button('Negieren')!.getAttribute('aria-pressed')).toBe('false');
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

describe('Einstufung über alle Targets', () => {
  /** Käufe bzw. Klicks verteilen sich auf zwei Targets; „lampe solo“ steht auf einem. */
  const spread = () => {
    const across = { termTargets: 2, termReason: null, termOnlyAcrossTargets: true };
    const harvest = { ...across, termClassification: 'harvest' as const };
    const negate = { ...across, termClassification: 'negate' as const };
    const rows = [
      row('gartenlampe solar', { ...harvest, amazonTargetId: 'T1' }),
      row('gartenlampe solar', { ...harvest, amazonTargetId: 'T2', termTargets: 3 }),
      row('stehlampe billig', negate),
      row('lampe solo', { classification: 'harvest', reason: null }),
      row('deckenlampe rot', {
        classification: 'negate',
        reason: null,
        termClassification: 'watch',
        termReason: 'tooFewData',
        termTargets: 2,
      }),
    ];
    return analysisResponse({
      rows,
      counts: { harvest: 1, negate: 1, watch: 3 },
      termCounts: { harvest: 2, negate: 1, watch: 1 },
      termCountsOnlyAcrossTargets: { harvest: 1, negate: 1 },
    });
  };
  const mountSpread = (path = PATH) =>
    mountPage(path, { 'POST /api/ads/search-terms/analysis': json(spread()) });
  const occurrences = (needle: string) =>
    (document.body.textContent ?? '').split(needle).length - 1;

  it('zeigt sie in der Zeile nur, wenn sie von der Einstufung der Zeile abweicht', async () => {
    await mountSpread();
    await waitForRow('gartenlampe solar');
    await waitForRow('stehlampe billig');
    await waitForRow('lampe solo');
    await waitForRow('deckenlampe rot');
    await waitForRow('Über alle Targets: Ernten (2 Targets)');
    await waitForRow('Über alle Targets: Ernten (3 Targets)');
    await waitForRow('Über alle Targets: Negieren (2 Targets)');
    // Allein ein Negativ-Vorschlag, über alle Targets nicht.
    await waitForRow('Über alle Targets: Beobachten (2 Targets)');
    // „lampe solo“ ist schon in der Zeile ein Harvest: kein zweiter Hinweis.
    expect(occurrences('Über alle Targets:')).toBe(4);
  });

  it('zeigt ohne Abweichung keinen Hinweis und keine Zeile in der Kachel', async () => {
    await mountPage();
    await waitForRow('led lampe warmweiß');
    await waitForRow('nordwind lampe');
    expect(document.body.textContent).not.toContain('Über alle Targets');
    expect(document.body.textContent).not.toContain('über alle Targets');
  });

  it('nennt in der Kachel die Suchbegriffe, die erst über alle Targets Kandidaten sind', async () => {
    await mountSpread();
    await waitForRow('gartenlampe solar');
    const text = document.body.textContent ?? '';
    expect(text).toContain('Erst über alle Targets zusammen:');
    expect(button('zum Ernten')!.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '1 Suchbegriff zum Ernten',
    );
    expect(button('zum Negieren')!.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '1 Suchbegriff zum Negieren',
    );
  });

  it('nennt nur die Einstufung mit Treffern (Mehrzahl mit Tausenderpunkt)', async () => {
    await mountPage(PATH, {
      'POST /api/ads/search-terms/analysis': json({
        ...spread(),
        termCountsOnlyAcrossTargets: { harvest: 1234, negate: 0 },
      }),
    });
    await waitForRow('gartenlampe solar');
    expect(button('zum Ernten')!.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '1.234 Suchbegriffe zum Ernten',
    );
    expect(button('zum Negieren')).toBeUndefined();
  });

  it('filtert auf die Zeilen dieser Suchbegriffe (URL `class`) und wieder zurück', async () => {
    const { router } = await mountSpread();
    await waitForRow('lampe solo');
    button('zum Ernten')!.click();
    await flushPromises();
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('lampe solo'));
    await waitForRow('gartenlampe solar');
    expect(document.body.textContent).not.toContain('stehlampe billig');
    expect(router.currentRoute.value.query.class).toBe('harvest-across');
    expect(button('zum Ernten')!.getAttribute('aria-pressed')).toBe('true');
    expect(button('Ernten')!.getAttribute('aria-pressed')).toBe('false');

    button('zum Ernten')!.click();
    await flushPromises();
    await waitForRow('lampe solo');
    expect(router.currentRoute.value.query.class).toBeUndefined();
  });

  it('liest den Filter aus der URL', async () => {
    await mountSpread(`${PATH}?class=negate-across`);
    await waitForRow('stehlampe billig');
    expect(document.body.textContent).not.toContain('gartenlampe solar');
    expect(document.body.textContent).not.toContain('deckenlampe rot');
    expect(button('zum Negieren')!.getAttribute('aria-pressed')).toBe('true');
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
