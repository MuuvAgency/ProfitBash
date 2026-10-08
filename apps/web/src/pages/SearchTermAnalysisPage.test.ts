import type {
  SearchTermAnalysisResponse,
  SearchTermNgram,
  SearchTermPeriod,
  SearchTermRow,
} from '@profitbash/shared';
import { flushPromises } from '@vue/test-utils';
import type { GridApi } from 'ag-grid-community';
import { AgGridVue } from 'ag-grid-vue3';
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
  vi.restoreAllMocks();
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
    await waitForRow('Über alle Targets: Ernten (2 Zeilen)');
    await waitForRow('Über alle Targets: Ernten (3 Zeilen)');
    await waitForRow('Über alle Targets: Negieren (2 Zeilen)');
    // Allein ein Negativ-Vorschlag, über alle Targets nicht: mit Grund wie in der Zeile selbst.
    await waitForRow('Über alle Targets: Beobachten · Zu wenig Daten (2 Zeilen)');
    // „lampe solo“ ist schon in der Zeile ein Harvest: kein zweiter Hinweis.
    expect(occurrences('Über alle Targets:')).toBe(4);
  });

  it('zeichnet die zweite Zeile nach einem Neuladen mit denselben Zeilen-IDs neu (erscheint, verschwindet)', async () => {
    const base = analysisResponse();
    const [first, ...rest] = base.rows;
    // Dieselbe Zeile (ID, eigene Einstufung „Ernten“), nur die Einstufung über alle Targets wechselt.
    const withAcross = {
      ...base,
      rows: [
        {
          ...first!,
          termClassification: 'watch' as const,
          termReason: 'acosAboveTarget' as const,
          termTargets: 2,
        },
        ...rest,
      ],
    };
    const answers = [base, withAcross, base];
    let calls = 0;
    const { queryClient } = await mountPage(PATH, {
      'POST /api/ads/search-terms/analysis': () =>
        json(answers[Math.min(calls++, answers.length - 1)]),
    });
    const line = 'Über alle Targets: Beobachten · ACoS über dem Ziel (2 Zeilen)';
    await waitForRow('led lampe warmweiß');
    expect(document.body.textContent).not.toContain('Über alle Targets');

    await queryClient.invalidateQueries({ queryKey: ['search-terms'] });
    await waitForRow(line);

    await queryClient.invalidateQueries({ queryKey: ['search-terms'] });
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('Über alle Targets'), {
      timeout: 3000,
    });
    expect(document.body.textContent).toContain('led lampe warmweiß');
  });

  it('übergeht den Filter in den Wortbausteinen und eine unbekannte Angabe in `class`', async () => {
    await mountSpread(`${PATH}?view=ngrams&class=harvest-across`);
    await waitForRow('led lampe');
    expect(document.body.textContent).toContain('Wörter');
    expect(document.body.textContent).not.toContain('gartenlampe solar');
    cleanupMounted();
    vi.unstubAllGlobals();

    await mountSpread(`${PATH}?class=alles-across`);
    await waitForRow('gartenlampe solar');
    await waitForRow('stehlampe billig');
    await waitForRow('lampe solo');
    await waitForRow('deckenlampe rot');
    for (const label of ['Ernten', 'Negieren', 'Beobachten', 'zum Ernten', 'zum Negieren']) {
      expect(button(label)!.getAttribute('aria-pressed'), label).toBe('false');
    }
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

describe('Zeitraum löschen (2b.2d)', () => {
  const DELETE = 'POST /api/ads/search-terms/periods/delete';
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const inDialog = (label: string) =>
    [...(dialog()?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.trim().includes(label),
    );
  const deleteRequests = (requests: RecordedRequest[]) =>
    requests.filter((r) => r.path === '/api/ads/search-terms/periods/delete').map((r) => r.body);
  const periodRequests = (requests: RecordedRequest[]) =>
    requests.filter((r) => r.path === '/api/ads/search-terms/periods');

  /** Die Zeiträume verschwinden beim Löschen aus der Liste, wie auf dem Server. */
  function deletable(list: SearchTermPeriod[]) {
    let current = list;
    return {
      'POST /api/ads/search-terms/periods': () => json({ periods: current }),
      [DELETE]: (request: RecordedRequest) => {
        const body = request.body as { profileId: string; periodStart: string; periodEnd: string };
        const gone = current.filter(
          (p) =>
            p.profileId === body.profileId &&
            p.periodStart === body.periodStart &&
            p.periodEnd === body.periodEnd,
        );
        current = current.filter((p) => !gone.includes(p));
        return json({ deletedRows: gone.reduce((sum, p) => sum + p.rows, 0) });
      },
    };
  }

  async function openDialog() {
    button('Zeitraum löschen')!.click();
    await flushPromises();
  }

  it('bietet den Knopf nur Org-Admins an (wie der Upload der Dateien), nicht Editoren und Viewern', async () => {
    for (const orgRole of ['viewer', 'editor'] as const) {
      await mountPage(PATH, { 'GET /api/me': json(meFixture({ orgRole })) });
      await waitForRow('led lampe warmweiß');
      expect(button('Zeitraum löschen'), orgRole).toBeUndefined();
      cleanupMounted();
    }
    await mountPage();
    await waitForRow('led lampe warmweiß');
    expect(button('Zeitraum löschen')).toBeDefined();
  });

  it('nennt eine einzelne Zeile in der Einzahl', async () => {
    await mountPage(PATH, deletable([period({ rows: 1 })]));
    await waitForRow('led lampe warmweiß');
    await openDialog();
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('1 Zeile');
    expect(text).not.toContain('1 Zeilen');
  });

  it('sendet bei einem zweiten Klick während des Neuladens keine zweite Anfrage', async () => {
    // Das Löschen ist durch, die Zeiträume laden noch: Der Dialog bleibt bis dahin gesperrt.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let periodCalls = 0;
    const routesWithDelete = deletable(periods());
    const { requests } = await mountPage(PATH, {
      ...routesWithDelete,
      'POST /api/ads/search-terms/periods': async () => {
        periodCalls += 1;
        if (periodCalls > 1) await held;
        return routesWithDelete['POST /api/ads/search-terms/periods']();
      },
    });
    await waitForRow('led lampe warmweiß');
    await openDialog();
    inDialog('Zeitraum löschen')!.click();
    await flushPromises();
    await vi.waitFor(() => expect(periodRequests(requests)).toHaveLength(2));

    expect(dialog()).not.toBeNull();
    expect(inDialog('Zeitraum löschen')!.disabled).toBe(true);
    expect(inDialog('Abbrechen')!.disabled).toBe(true);
    inDialog('Zeitraum löschen')!.click();
    await flushPromises();
    expect(deleteRequests(requests)).toHaveLength(1);
    expect(dialog()?.querySelector('[role="alert"]')).toBeNull();

    release();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(deleteRequests(requests)).toHaveLength(1);
  });

  it('nennt im Dialog Profil, Zeitraum und Zeilenzahl und was erhalten bleibt; Abbrechen löscht nichts', async () => {
    const { requests } = await mountPage(PATH, deletable(periods()));
    await waitForRow('led lampe warmweiß');
    expect(dialog()).toBeNull();
    await openDialog();

    const text = dialog()?.textContent ?? '';
    expect(text).toContain('Demo DE · DE');
    expect(text).toContain('01.09.2026 – 30.09.2026');
    expect(text).toContain('2 Zeilen');
    expect(text).toContain('nur die Suchbegriffe dieses Zeitraums');
    expect(text).toContain('Kampagnen, der Verlauf der Datei-Importe und andere Zeiträume bleiben');
    expect(text).toContain('die Datei bzw. die Dateien dieses Zeitraums danach erneut hochladen');
    // Ein Import, der noch läuft oder wartet, bringt den Zeitraum zurück.
    expect(text).toContain('noch läuft oder wartet');
    // Die Zahlen stehen in der Zahlenschrift.
    expect(dialog()?.querySelector('.font-data')?.textContent).toContain('01.09.2026');

    inDialog('Abbrechen')!.click();
    await flushPromises();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(deleteRequests(requests)).toEqual([]);
  });

  it('löscht den gewählten Zeitraum, lädt die Zeiträume neu und wechselt auf den nächsten', async () => {
    const { requests, router } = await mountPage(PATH, deletable(periods()));
    await waitForRow('led lampe warmweiß');
    await openDialog();
    inDialog('Zeitraum löschen')!.click();
    await flushPromises();

    expect(deleteRequests(requests)).toEqual([
      { profileId: P1, periodStart: '2026-09-01', periodEnd: '2026-09-30' },
    ]);
    await vi.waitFor(() => expect(periodRequests(requests)).toHaveLength(2));
    await vi.waitFor(() => expect(dialog()).toBeNull());
    // Die Auswahl fällt auf den nächsten Zeitraum des Profils zurück.
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query).toMatchObject({
        profile: P1,
        from: '2026-08-01',
        to: '2026-09-29',
      }),
    );
    await vi.waitFor(() =>
      expect(analysisRequests(requests).at(-1)).toEqual({
        profileId: P1,
        periodStart: '2026-08-01',
        periodEnd: '2026-09-29',
      }),
    );
    expect(document.body.textContent).toContain('01.08.2026 – 29.09.2026');
  });

  it('zeigt den Leerzustand, wenn kein Zeitraum übrig ist', async () => {
    const { requests } = await mountPage(PATH, deletable([period()]));
    await waitForRow('led lampe warmweiß');
    await openDialog();
    inDialog('Zeitraum löschen')!.click();
    await flushPromises();

    await vi.waitFor(() => expect(document.body.textContent).toContain('Noch keine Suchbegriffe'));
    expect(deleteRequests(requests)).toHaveLength(1);
    expect(button('Zeitraum löschen')).toBeUndefined();
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });

  it('zeigt einen Fehler im Dialog und lässt die Auswahl stehen', async () => {
    const { requests, router } = await mountPage(PATH, {
      [DELETE]: json(
        {
          error: {
            code: 'SEARCH_TERM_PERIOD_NOT_FOUND',
            message: 'Für diesen Zeitraum liegen keine Suchbegriffe vor.',
          },
        },
        404,
      ),
    });
    await waitForRow('led lampe warmweiß');
    await openDialog();
    inDialog('Zeitraum löschen')!.click();
    await flushPromises();

    const alert = dialog()?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      'Für diesen Zeitraum liegen keine Suchbegriffe mehr vor. Bitte lade die Seite neu.',
    );
    expect(periodRequests(requests)).toHaveLength(1);
    expect(router.currentRoute.value.query).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });

    // Beim erneuten Öffnen ist die Meldung weg.
    inDialog('Abbrechen')!.click();
    await flushPromises();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await openDialog();
    expect(dialog()?.querySelector('[role="alert"]')).toBeNull();
  });
});

/** Fängt den Download ab: Inhalt (Blob) und Dateiname des erzeugten Links. */
function captureDownload() {
  const download: { blob?: Blob; fileName?: string } = {};
  vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
    download.blob = value as Blob;
    return 'blob:csv';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    download.fileName = this.download;
  });
  return {
    fileName: () => download.fileName,
    text: async () => {
      await vi.waitFor(() => expect(download.blob).toBeDefined());
      return download.blob!.text();
    },
  };
}

const EXPORT = 'CSV exportieren';

describe('CSV-Export', () => {
  it('Suchbegriffe: Einstufung mit Grund als Text, Beträge als Decimal-String mit Währung, ohne Summenzeile', async () => {
    const download = captureDownload();
    await mountPage(PATH, {
      'POST /api/ads/search-terms/analysis': json(
        analysisResponse({
          rows: [
            row('led lampe warmweiß', { classification: 'harvest', reason: null }),
            row('=SUMME(1)', { classification: 'negate', reason: null, cost: '25.5', acos: null }),
            row('nordwind lampe', { reason: 'protected', protected: true }),
          ],
        }),
      ),
    });
    await waitForRow('led lampe warmweiß');
    await waitForRow('nordwind lampe');
    expect(button(EXPORT)!.disabled).toBe(false);
    button(EXPORT)!.click();
    const csv = await download.text();
    // BOM, damit Excel UTF-8 erkennt.
    expect(csv.startsWith('\uFEFF"Suchbegriff","Einstufung","Kampagne","Ad Group","Target"')).toBe(
      true,
    );
    expect(csv).toContain('"led lampe warmweiß","Ernten","SP Lampen","AG Lampen"');
    expect(csv).toContain('"nordwind lampe","Beobachten · Geschützter Begriff"');
    expect(csv).not.toMatch(/harvest|negate|watch|protected/);
    // Formeln in Suchbegriffen entschärft, Betrag roh (nicht „25,50 €“), fehlender Wert leer (nicht „–“).
    expect(csv).toContain(`"'=SUMME(1)","Negieren"`);
    expect(csv).toContain('"25.5"');
    expect(csv).not.toContain('€');
    expect(csv).not.toContain('"–"');
    expect(csv).toContain('"Währung"');
    expect(csv).toContain('"EUR"');
    // Die Summenzeile gilt für alle Zeilen des Zeitraums, nicht für die exportierten.
    expect(csv).not.toContain('"Summe"');
    expect(csv).not.toContain('"1234.5"');
    expect(download.fileName()).toBe(
      'profitbash-search-term-analysis-demo-de-de-2026-09-01_2026-09-30.csv',
    );
  });

  it('entschärft Formeln auch in Namen und hält Anführungszeichen, Komma und Zeilenumbruch in einem Feld', async () => {
    const download = captureDownload();
    await mountPage(PATH, {
      'POST /api/ads/search-terms/analysis': json(
        analysisResponse({
          rows: [
            row('lampe "groß", 2er\nset', { campaignName: '=Kampagne', adGroupName: '+AG' }),
            row('leuchte', { campaignName: '-Kampagne', adGroupName: '@AG' }),
          ],
        }),
      ),
    });
    await waitForRow('lampe "groß", 2er');
    await waitForRow('leuchte');
    button(EXPORT)!.click();
    const csv = await download.text();
    expect(csv).toContain(
      `"lampe ""groß"", 2er\nset","Beobachten · Zu wenig Daten","'=Kampagne","'+AG"`,
    );
    expect(csv).toContain(`"leuchte","Beobachten · Zu wenig Daten","'-Kampagne","'@AG"`);
    // Kopfzeile und zwei Zeilen: Der Zeilenumbruch im Suchbegriff beginnt keine neue.
    expect(csv.split('\r\n')).toHaveLength(3);
  });

  it('Suchbegriffe: nur die Zeilen der gewählten Einstufung, die Einstufung steht im Dateinamen', async () => {
    const download = captureDownload();
    await mountPage(`${PATH}?class=negate`);
    await waitForRow('lampe billig');
    button(EXPORT)!.click();
    const csv = await download.text();
    expect(csv).toContain('"lampe billig","Negieren"');
    expect(csv).not.toContain('led lampe warmweiß');
    expect(csv).not.toContain('nordwind lampe');
    expect(download.fileName()).toBe(
      'profitbash-search-term-analysis-negate-demo-de-de-2026-09-01_2026-09-30.csv',
    );
  });

  it('Suchbegriffe: Die Einstufung über alle Targets steht in derselben Zelle, ohne Zeilenumbruch (2b.2f)', async () => {
    const download = captureDownload();
    await mountPage(`${PATH}?class=harvest-across`, {
      'POST /api/ads/search-terms/analysis': json(
        analysisResponse({
          rows: [
            row('led lampe', {
              termClassification: 'harvest',
              termReason: null,
              termTargets: 2,
              termOnlyAcrossTargets: true,
            }),
            row('lampe billig'),
          ],
          termCountsOnlyAcrossTargets: { harvest: 1, negate: 0 },
        }),
      ),
    });
    await waitForRow('led lampe');
    button(EXPORT)!.click();
    const csv = await download.text();
    expect(csv).toContain(
      '"led lampe","Beobachten · Zu wenig Daten; Über alle Targets: Ernten (2 Zeilen)"',
    );
    expect(csv).not.toContain('lampe billig');
    // Kopfzeile und eine Zeile.
    expect(csv.split('\r\n')).toHaveLength(2);
    expect(download.fileName()).toBe(
      'profitbash-search-term-analysis-harvest-across-demo-de-de-2026-09-01_2026-09-30.csv',
    );
  });

  it('Suchbegriffe: Spaltenfilter und Sortierung des Grids gelten auch im Export', async () => {
    const download = captureDownload();
    const { wrapper } = await mountPage(PATH, {
      'POST /api/ads/search-terms/analysis': json(
        analysisResponse({
          rows: [
            row('lampe teuer', { cost: '30' }),
            row('lampe billig', { cost: '10' }),
            row('leuchte', { cost: '20' }),
          ],
        }),
      ),
    });
    await waitForRow('lampe teuer');
    await waitForRow('lampe billig');
    await waitForRow('leuchte');
    const { api } = wrapper.findComponent(AgGridVue).vm as unknown as { api: GridApi };
    await api.setColumnFilterModel('searchTerm', { type: 'contains', filter: 'lampe' });
    api.onFilterChanged();
    api.applyColumnState({ state: [{ colId: 'cost', sort: 'asc' }] });
    button(EXPORT)!.click();
    const csv = await download.text();
    expect(csv).not.toContain('leuchte');
    expect(csv.indexOf('"lampe billig"')).toBeGreaterThan(-1);
    expect(csv.indexOf('"lampe billig"')).toBeLessThan(csv.indexOf('"lampe teuer"'));
  });

  it('Wortbausteine: eigene Spalten, Zähler roh, Umschalter der Wortzahl gilt', async () => {
    const download = captureDownload();
    await mountPage(`${PATH}?view=ngrams`, {
      'POST /api/ads/search-terms/analysis': json(
        analysisResponse({
          ngrams: [ngram('lampe', { searchTerms: 7777, cost: '25.5' }), ngram('led lampe')],
        }),
      ),
    });
    await waitForRow('led lampe');
    button(EXPORT)!.click();
    let csv = await download.text();
    expect(csv.startsWith('\uFEFF"Wortbaustein","Wörter","Suchbegriffe"')).toBe(true);
    expect(csv).toContain('"lampe","1","7777"');
    expect(csv).toContain('"led lampe","2","2"');
    expect(csv).toContain('"25.5"');
    expect(csv).toContain('"EUR"');
    expect(download.fileName()).toBe(
      'profitbash-search-term-ngrams-demo-de-de-2026-09-01_2026-09-30.csv',
    );

    button('2 Wörter')!.click();
    await flushPromises();
    // Der Baustein mit einem Wort (7.777 Suchbegriffe) verschwindet aus dem Grid.
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('7.777'));
    button(EXPORT)!.click();
    await vi.waitFor(async () => expect(await download.text()).not.toBe(csv));
    csv = await download.text();
    expect(csv).toContain('"led lampe","2","2"');
    expect(csv).not.toContain('"lampe","1"');
  });

  it('nennt eine gekürzte Antwort in einer eigenen ersten Zeile (Suchbegriffe und Wortbausteine)', async () => {
    const download = captureDownload();
    await mountPage(PATH, {
      'POST /api/ads/search-terms/analysis': json(
        analysisResponse(
          {},
          {
            totalRows: 12345,
            truncated: true,
            totalNgrams: 6789,
            ngramsTruncated: true,
          },
        ),
      ),
    });
    await waitForRow('led lampe warmweiß');
    button(EXPORT)!.click();
    const terms = (await download.text()).split(/\r?\n/);
    // Ein Feld in Anführungszeichen: Das Komma im Text trennt keine Spalten ab, die Kopfzeile bleibt die zweite Zeile.
    expect(terms[0]).toBe(
      '\uFEFF"Hinweis: Die Analyse hat nur die 10.000 Zeilen mit dem höchsten Spend geliefert (von 12.345), die Datei kann deshalb unvollständig sein."',
    );
    expect(terms[1]!.startsWith('"Suchbegriff","Einstufung"')).toBe(true);
    // Nicht der Hinweis der Seite: Zähler und Summe stehen nicht in der Datei.
    expect(terms.join('\n')).not.toContain('Einstufungs-Zähler');

    button('Wortbausteine')!.click();
    await flushPromises();
    await waitForRow('led lampe');
    button(EXPORT)!.click();
    await vi.waitFor(async () => expect(await download.text()).toContain('"Wortbaustein"'));
    const ngrams = (await download.text()).split(/\r?\n/);
    expect(ngrams[0]).toBe(
      '\uFEFF"Hinweis: Die Analyse hat nur die 5.000 Wortbausteine mit dem höchsten Spend geliefert (von 6.789), die Datei kann deshalb unvollständig sein."',
    );
    expect(ngrams[1]!.startsWith('"Wortbaustein","Wörter"')).toBe(true);
  });

  it('ist ohne Zeilen gesperrt (leerer Zeitraum, Einstufung ohne Treffer, keine Wortbausteine)', async () => {
    const { router } = await mountPage(PATH, {
      'POST /api/ads/search-terms/analysis': json(
        analysisResponse({
          rows: [row('led lampe warmweiß', { classification: 'harvest', reason: null })],
          ngrams: [],
        }),
      ),
    });
    await waitForRow('led lampe warmweiß');
    expect(button(EXPORT)!.disabled).toBe(false);
    button('Negieren')!.click();
    await flushPromises();
    await vi.waitFor(() => expect(router.currentRoute.value.query.class).toBe('negate'));
    expect(button(EXPORT)!.disabled).toBe(true);
    button('Wortbausteine')!.click();
    await flushPromises();
    await vi.waitFor(() => expect(router.currentRoute.value.query.view).toBe('ngrams'));
    expect(button(EXPORT)!.disabled).toBe(true);
  });
});

describe('Sprung in den Explorer', () => {
  const CAMPAIGN = '00000000-0000-4000-8000-0000000000d1';
  const AD_GROUP = '00000000-0000-4000-8000-0000000000e1';

  const anchor = (text: string) =>
    [...document.querySelectorAll<HTMLAnchorElement>('.ag-root a')].find(
      (a) => a.textContent?.trim() === text,
    );
  const target = (a: HTMLAnchorElement) => {
    const url = new URL(a.getAttribute('href')!, 'http://localhost');
    return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
  };

  it('Kampagne und Ad Group verlinken in den Explorer (Client, Datei-Zeitraum, Drill-Down, auch Entfernte)', async () => {
    const CLIENT = '00000000-0000-4000-8000-0000000000c1';
    await mountPage(PATH, {
      'POST /api/ads/search-terms/analysis': json(
        analysisResponse(
          {
            rows: [
              row('led lampe warmweiß', {
                campaignId: CAMPAIGN,
                campaignName: 'SP Bekannt',
                adGroupId: AD_GROUP,
                adGroupName: 'AG Bekannt',
              }),
            ],
          },
          { clientId: CLIENT },
        ),
      ),
    });
    await waitForRow('led lampe warmweiß');
    await waitForRow('SP Bekannt');
    await waitForRow('AG Bekannt');
    const filter = {
      clients: CLIENT,
      period: 'custom',
      from: '2026-09-01',
      to: '2026-09-30',
      removed: '1',
    };
    expect(target(anchor('SP Bekannt')!)).toEqual({
      path: '/ads/explorer/ad-groups',
      query: { ...filter, campaign: CAMPAIGN },
    });
    expect(target(anchor('AG Bekannt')!)).toEqual({
      path: '/ads/explorer/targets',
      query: { ...filter, campaign: CAMPAIGN, adGroup: AD_GROUP },
    });
  });

  it('Tastatur: Enter auf der Zelle öffnet den Explorer (Profil ohne Client: „Ohne Client“)', async () => {
    const { router } = await mountPage(PATH, {
      'POST /api/ads/search-terms/analysis': json(
        analysisResponse({
          rows: [row('led lampe warmweiß', { campaignId: CAMPAIGN, campaignName: 'SP Bekannt' })],
        }),
      ),
    });
    await waitForRow('SP Bekannt');
    const cell = document.querySelector<HTMLElement>('.ag-cell[col-id="campaign"]')!;
    cell.focus();
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/ads/explorer/ad-groups'));
    expect(router.currentRoute.value.query).toMatchObject({
      campaign: CAMPAIGN,
      nc: '1',
      removed: '1',
    });
    // Keine einzelnen Profile: Der Link gilt in jedem Tab und für jeden Leser gleich.
    expect(router.currentRoute.value.query.pf).toBeUndefined();
    expect(router.options.history.state.analyticsFilters).toMatchObject({ profileIds: null });
  });

  it('Link und reiner Text tragen den vollen Namen als title; die Summenzeile hat keinen Link', async () => {
    await mountPage(PATH, {
      'POST /api/ads/search-terms/analysis': json(
        analysisResponse({
          rows: [row('led lampe warmweiß', { campaignId: CAMPAIGN, campaignName: 'SP Bekannt' })],
        }),
      ),
    });
    await waitForRow('SP Bekannt');
    await waitForRow('AG Lampen');
    await waitForRow('Summe');
    expect(anchor('SP Bekannt')!.getAttribute('title')).toBe('SP Bekannt');
    const plain = [...document.querySelectorAll('.ag-cell[col-id="adGroup"] span')].find(
      (span) => span.textContent?.trim() === 'AG Lampen',
    );
    expect(plain?.getAttribute('title')).toBe('AG Lampen');
    expect(document.querySelectorAll('.ag-root a')).toHaveLength(1);
    expect(document.querySelectorAll('.ag-floating-bottom a')).toHaveLength(0);
  });

  it('bekannte Entity ohne Namen: Platzhalter statt eines leeren Links', async () => {
    await mountPage(PATH, {
      'POST /api/ads/search-terms/analysis': json(
        analysisResponse({
          rows: [row('led lampe warmweiß', { campaignId: CAMPAIGN, campaignName: '' })],
        }),
      ),
    });
    await waitForRow('led lampe warmweiß');
    await waitForRow('AG Lampen');
    const cell = () =>
      document.querySelector('.ag-row:not(.ag-row-pinned) .ag-cell[col-id="campaign"]');
    await vi.waitFor(() => expect(cell()?.textContent?.trim()).toBe('–'));
    expect(cell()!.querySelector('a')).toBeNull();
  });

  it('fehlt die Entity im Profil, bleibt der Name reiner Text', async () => {
    await mountPage();
    await waitForRow('led lampe warmweiß');
    await waitForRow('SP Lampen');
    await waitForRow('AG Lampen');
    expect(document.querySelectorAll('.ag-root a')).toHaveLength(0);
  });
});
