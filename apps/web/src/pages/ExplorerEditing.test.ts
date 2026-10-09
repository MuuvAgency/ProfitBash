import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExplorerRowsData, OpenAdChangesData, TimeSeriesData } from '../api/client';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Bearbeiten im Explorer (`phase-3.md` 3.5): Inline, Bulk-Dialoge, Strategie und Platzierungen, offene Änderungen. */

vi.mock('ag-charts-vue3', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    AgCharts: defineComponent({
      name: 'AgChartsStub',
      props: { options: { type: Object, required: true } },
      setup: () => () => h('div', { 'data-stub': 'ag-charts' }),
    }),
  };
});

const P1 = '00000000-0000-4000-8000-0000000000a1';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const CAMPAIGN = '00000000-0000-4000-8000-0000000000ca';
const SB_CAMPAIGN = '00000000-0000-4000-8000-0000000000cb';
const T1 = '00000000-0000-4000-8000-0000000000f1';
const T2 = '00000000-0000-4000-8000-0000000000f2';
const T3 = '00000000-0000-4000-8000-0000000000f3';

const coverage = {
  sales: 'full',
  purchases: 'full',
  units: 'full',
  salesSameSku: 'full',
  purchasesSameSku: 'full',
  unitsSameSku: 'full',
} as const;

const period = {
  sums: {
    impressions: '1000',
    clicks: '20',
    cost: '10',
    sales: '40',
    purchases: '2',
    units: '2',
    salesSameSku: null,
    purchasesSameSku: null,
    unitsSameSku: null,
    viewableImpressions: null,
    viewableCost: null,
  },
  derived: { ctr: '0.02', cpc: '0.5', cvr: '0.1', acos: '0.25', roas: '4', cpm: '10', vcpm: null },
};

type Row = ExplorerRowsData['rows'][number];
function row(id: string, name: string, patch: Partial<Row> = {}): Row {
  return {
    id,
    profileId: P1,
    accountName: 'Demo DE',
    countryCode: 'DE',
    currencyCode: 'EUR',
    adProduct: 'SPONSORED_PRODUCTS',
    name,
    state: 'ENABLED',
    removed: false,
    placeholder: false,
    hasMetrics: true,
    attributes: { amazonId: '1' },
    current: period,
    comparison: null,
    change: null,
    attribution: null,
    ...patch,
  } as Row;
}

const meta = {
  currency: 'EUR',
  converted: false,
  missingFxCurrencies: [],
  dataThrough: '2026-09-25',
  provisionalFrom: '2026-09-12',
  earliestDate: '2026-06-24',
  profilesWithoutData: 0,
};

const rowsByLevel: Record<string, () => Row[]> = {
  campaign: () => [
    row(CAMPAIGN, 'SP Nistkasten', {
      attributes: {
        budgetAmount: '20',
        budgetCurrencyCode: 'EUR',
        budgetType: 'DAILY',
        biddingStrategy: 'SALES_DOWN_ONLY',
        placementBidAdjustments: [{ placement: 'PLACEMENT_TOP', percentage: 25 }],
      },
    }),
    row(SB_CAMPAIGN, 'SB Marke', {
      adProduct: 'SPONSORED_BRANDS',
      attributes: { budgetAmount: '500', budgetCurrencyCode: 'EUR', budgetType: 'LIFETIME' },
    }),
  ],
  target: () => [
    row(T1, 'nistkasten meise', {
      attributes: {
        keywordText: 'nistkasten meise',
        matchType: 'EXACT',
        bid: '0.50',
        bidCurrencyCode: 'EUR',
      },
    }),
    row(T2, 'vogelhaus', {
      attributes: {
        keywordText: 'vogelhaus',
        matchType: 'PHRASE',
        bid: '0.40',
        bidCurrencyCode: 'EUR',
      },
    }),
    row(T3, 'altes keyword', {
      state: 'ARCHIVED',
      attributes: {
        keywordText: 'altes keyword',
        matchType: 'EXACT',
        bid: '0.30',
        bidCurrencyCode: 'EUR',
      },
    }),
  ],
};

function rowsResponder({ body }: RecordedRequest): Response {
  const level = (body as { level: string }).level;
  const rows = (rowsByLevel[level] ?? (() => []))();
  return json({
    meta,
    rows,
    totalRows: rows.length,
    truncated: false,
    maxRows: 10000,
    total: {
      current: period,
      comparison: null,
      change: null,
      attribution: { mixed: false, sameSkuMixed: false, coverage },
    },
  });
}

type Open = OpenAdChangesData['changes'][number];
const openChange = (patch: Partial<Open>): Open => ({
  id: '00000000-0000-4000-8000-00000000d001',
  profileId: P1,
  status: 'pending',
  channel: null,
  submissionId: null,
  operation: 'update',
  entityType: 'target',
  entityId: T1,
  campaignId: CAMPAIGN,
  adGroupId: null,
  field: 'bid',
  after: '0.80',
  negative: null,
  mine: true,
  userName: 'Dominik',
  ...patch,
});

const stageOk = (outcomes: unknown[]) => {
  const counts = { created: 0, updated: 0, removed: 0, unchanged: 0, rejected: 0 };
  for (const result of outcomes as { outcome: keyof typeof counts }[]) counts[result.outcome] += 1;
  return json({ results: outcomes, counts });
};

function routes(
  options: {
    me?: Parameters<typeof meFixture>[0];
    open?: () => Open[];
    pending?: number;
    stage?: (request: RecordedRequest) => Response;
  } = {},
) {
  return {
    'GET /api/me': json(meFixture(options.me)),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/settings/ui-state/analytics/filters': json({ value: null }),
    'PUT /api/settings/ui-state/analytics/filters': new Response(null, { status: 204 }),
    'POST /api/ads/filter-options': json({
      clients: [{ id: C1, name: 'Waldkauz (Demo)', slug: 'waldkauz' }],
      profiles: [
        {
          id: P1,
          amazonProfileId: '7100000000000001',
          accountName: 'Demo DE',
          countryCode: 'DE',
          currencyCode: 'EUR',
          timezone: 'Europe/Berlin',
          accountType: 'seller',
          clientId: C1,
        },
      ],
      currencies: ['EUR'],
      fxRatesThrough: '2026-09-25',
      fxRatesStale: false,
    }),
    'POST /api/ads/explorer/rows': rowsResponder,
    'POST /api/ads/timeseries': json({
      meta,
      days: [],
      comparisonDays: [],
      attribution: { mixed: false, sameSkuMixed: false, coverage },
      comparisonAttribution: null,
    } as unknown as TimeSeriesData),
    'GET /api/saved-views': json({ views: [] }),
    'GET /api/ads/changes/open': () =>
      json({ changes: (options.open ?? (() => []))(), truncated: false }),
    'GET /api/ads/changes/pending': json({
      changes: Array.from({ length: options.pending ?? 0 }, (_, index) => ({ id: `p${index}` })),
      check: { violations: [], largeChanges: [], tooMany: null },
    }),
    'POST /api/ads/changes/pending':
      options.stage ??
      (({ body }: RecordedRequest) =>
        stageOk(
          (body as { changes: unknown[] }).changes.map(() => ({
            outcome: 'created',
            changeId: '00000000-0000-4000-8000-00000000d009',
            otherUsers: 0,
          })),
        )),
    'POST /api/ads/changes/pending/discard': json({ discarded: 1 }),
  };
}

async function mountExplorer(path: string) {
  const mounted = await mountWithApp(undefined, { path });
  await flushPromises();
  return mounted;
}

async function waitForRow(text: string) {
  await vi.waitFor(() => expect(document.body.textContent).toContain(text), { timeout: 3000 });
}

function cell(rowName: string, column: string): HTMLElement {
  const name = [...document.querySelectorAll<HTMLElement>('.ag-cell[col-id="name"]')].find((c) =>
    c.textContent?.includes(rowName),
  );
  const rowIndex = name?.closest('.ag-row')?.getAttribute('row-index');
  const found = [...document.querySelectorAll<HTMLElement>(`.ag-cell[col-id="${column}"]`)].find(
    (c) => c.closest('.ag-row')?.getAttribute('row-index') === rowIndex,
  );
  if (!found) throw new Error(`Zelle ${column} von „${rowName}“ nicht gefunden`);
  return found;
}

/** Text ohne geschützte Leerzeichen (Währungsformat). */
const plain = (value: string | null | undefined) => (value ?? '').replace(/\u00a0|\u202f/g, ' ');

async function type(input: HTMLInputElement, text: string, key = 'Enter') {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  await flushPromises();
}

const staged = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.method === 'POST' && r.path === '/api/ads/changes/pending');

async function selectAllRows() {
  const box = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>('.ag-header-select-all input');
    if (!input) throw new Error('keine Auswahl-Checkbox');
    return input;
  });
  box.click();
  await flushPromises();
}

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('Explorer: Inline-Bearbeitung', () => {
  it('legt ein neues Gebot mit Enter sofort in den Warenkorb', async () => {
    const { requests } = stubFetch(routes());
    await mountExplorer('/ads/explorer/targets');
    await waitForRow('nistkasten meise');

    const button = cell('nistkasten meise', 'bid').querySelector<HTMLElement>('[data-edit]')!;
    expect(plain(button.getAttribute('aria-label'))).toBe('Gebot bearbeiten: 0,50 €');
    button.click();
    await flushPromises();
    const input = cell('nistkasten meise', 'bid').querySelector<HTMLInputElement>(
      'input[data-edit-input]',
    )!;
    expect(input.getAttribute('aria-label')).toBe('Gebot in EUR');
    expect(input.value).toBe('0,50');
    await type(input, '0,80');

    expect(staged(requests).map((r) => r.body)).toEqual([
      {
        origin: 'explorer',
        changes: [
          { operation: 'update', entityType: 'target', entityId: T1, field: 'bid', value: '0.80' },
        ],
      },
    ]);
    // Danach werden die offenen Änderungen und der Warenkorb neu geladen.
    await vi.waitFor(() =>
      expect(requests.filter((r) => r.path === '/api/ads/changes/open').length).toBeGreaterThan(1),
    );
  });

  it('übernimmt nichts bei Escape, bei unverändertem Wert und bei ungültiger Eingabe', async () => {
    const { requests } = stubFetch(routes());
    await mountExplorer('/ads/explorer/targets');
    await waitForRow('nistkasten meise');
    const open = async () => {
      cell('nistkasten meise', 'bid').querySelector<HTMLElement>('[data-edit]')!.click();
      await flushPromises();
      return cell('nistkasten meise', 'bid').querySelector<HTMLInputElement>(
        'input[data-edit-input]',
      )!;
    };

    await type(await open(), '0,90', 'Escape');
    expect(cell('nistkasten meise', 'bid').querySelector('input')).toBeNull();
    await type(await open(), '0,5');
    expect(cell('nistkasten meise', 'bid').querySelector('input')).toBeNull();

    const input = await open();
    await type(input, '1,234');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(cell('nistkasten meise', 'bid').textContent).toContain(
      'höchstens zwei Nachkommastellen',
    );
    expect(staged(requests)).toEqual([]);
  });

  it('ändert den Status über eine Auswahl in der Zelle', async () => {
    const { requests } = stubFetch(routes());
    await mountExplorer('/ads/explorer/targets');
    await waitForRow('vogelhaus');

    cell('vogelhaus', 'state').querySelector<HTMLElement>('[data-edit]')!.click();
    await flushPromises();
    const select = cell('vogelhaus', 'state').querySelector<HTMLSelectElement>(
      'select[data-edit-input]',
    )!;
    expect([...select.options].map((o) => o.textContent?.trim())).toEqual([
      'Aktiv',
      'Pausiert',
      'Archiviert',
    ]);
    select.value = 'PAUSED';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(staged(requests)[0]!.body).toMatchObject({
      changes: [{ entityType: 'target', entityId: T2, field: 'state', value: 'PAUSED' }],
    });
  });

  it('bietet nur an, was sich ändern lässt: nicht ohne Recht, nicht archiviert, nur Tagesbudgets', async () => {
    stubFetch(routes());
    await mountExplorer('/ads/explorer/targets');
    await waitForRow('altes keyword');
    expect(cell('altes keyword', 'bid').querySelector('[data-edit]')).toBeNull();
    expect(cell('altes keyword', 'state').querySelector('[data-edit]')).toBeNull();
    cleanupMounted();

    stubFetch(routes());
    await mountExplorer('/ads/explorer/campaigns');
    await waitForRow('SB Marke');
    expect(cell('SP Nistkasten', 'budget').querySelector('[data-edit]')).not.toBeNull();
    expect(cell('SB Marke', 'budget').querySelector('[data-edit]')).toBeNull();
    cleanupMounted();

    stubFetch(routes({ me: { orgRole: 'viewer' } }));
    await mountExplorer('/ads/explorer/targets');
    await waitForRow('nistkasten meise');
    expect(document.querySelector('[data-edit]')).toBeNull();
    expect(document.querySelector('[data-bulk-bar]')).toBeNull();
  });

  it('meldet eine abgelehnte Änderung mit dem Grund', async () => {
    stubFetch(
      routes({ stage: () => stageOk([{ outcome: 'rejected', reason: 'entityArchived' }]) }),
    );
    await mountExplorer('/ads/explorer/targets');
    await waitForRow('nistkasten meise');
    cell('nistkasten meise', 'bid').querySelector<HTMLElement>('[data-edit]')!.click();
    await flushPromises();
    await type(
      cell('nistkasten meise', 'bid').querySelector<HTMLInputElement>('input[data-edit-input]')!,
      '0,80',
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-edit-notice]')?.textContent).toContain(
        'Archiviert ist endgültig',
      ),
    );
  });
});

describe('Explorer: offene Änderungen im Grid (F4)', () => {
  it('zeigt die eigene Vormerkung mit neuem Wert und nimmt sie auf Wunsch zurück', async () => {
    const { requests } = stubFetch(routes({ open: () => [openChange({})], pending: 1 }));
    await mountExplorer('/ads/explorer/targets');
    await waitForRow('nistkasten meise');
    const bid = await vi.waitFor(() => {
      const found = cell('nistkasten meise', 'bid');
      if (!found.querySelector('[data-pending="mine"]')) throw new Error('noch keine Markierung');
      return found;
    });
    expect(plain(bid.textContent)).toContain('0,80 €');
    expect(plain(bid.querySelector('[data-pending="mine"]')!.textContent)).toContain(
      'Vorgemerkt, bisher 0,50 €',
    );

    bid.querySelector<HTMLElement>('[data-edit-undo]')!.click();
    await flushPromises();
    const discard = requests.find((r) => r.path === '/api/ads/changes/pending/discard')!;
    expect(discard.body).toEqual({ changeIds: ['00000000-0000-4000-8000-00000000d001'] });
  });

  it('weist auf Vormerkungen anderer und auf Übermitteltes ohne Ergebnis hin', async () => {
    stubFetch(
      routes({
        open: () => [
          openChange({ id: 'o1', mine: false, userName: 'Emil', after: '0.90' }),
          openChange({
            id: 'o2',
            entityId: T2,
            status: 'submitted',
            channel: 'bulk_file',
            after: '0.45',
            mine: false,
            userName: 'Emil',
          }),
        ],
      }),
    );
    await mountExplorer('/ads/explorer/targets');
    await waitForRow('vogelhaus');
    await vi.waitFor(() =>
      expect(
        plain(
          cell('nistkasten meise', 'bid').querySelector('[data-pending="others"]')?.textContent,
        ),
      ).toContain('Emil hat 0,90 € vorgemerkt'),
    );
    // Der Stand der Zelle bleibt der von Amazon.
    expect(plain(cell('nistkasten meise', 'bid').textContent)).toContain('0,50 €');
    expect(
      plain(cell('vogelhaus', 'bid').querySelector('[data-pending="submitted"]')?.textContent),
    ).toContain('Übermittelt (Bulk-Datei), noch ohne Ergebnis: 0,45 €');
  });

  it('fragt die offenen Änderungen nur für das gewählte Profil ab und zeigt den Warenkorb im Kopf', async () => {
    const { requests } = stubFetch({
      ...routes({ pending: 2 }),
      // Profile stehen nie in der URL (nur der Merker `pf=1`), sondern in der gespeicherten Auswahl.
      'GET /api/settings/ui-state/analytics/filters': json({
        value: {
          clientIds: [C1],
          withoutClient: false,
          profileIds: [P1],
          period: { preset: 'last30' },
          comparison: 'previous',
          currency: 'auto',
          attribution: 'console',
        },
      }),
    });
    const { wrapper } = await mountExplorer(`/ads/explorer/targets?clients=${C1}&pf=1`);
    await waitForRow('nistkasten meise');
    await vi.waitFor(() =>
      expect(
        requests.filter((r) => r.path === '/api/ads/changes/open').map((r) => r.search),
      ).toEqual([`?profileId=${P1}`]),
    );
    const link = await vi.waitFor(() => wrapper.get('a[data-pending-link]'));
    expect(link.text()).toContain('Ausstehend (2)');
    expect(link.attributes('href')).toBe('/ads/changes');
  });
});

describe('Explorer: markierte Zeilen', () => {
  it('senkt die Gebote der markierten Targets um Prozent; der Server rechnet', async () => {
    const { requests } = stubFetch(
      routes({
        stage: () =>
          stageOk([
            { outcome: 'created', changeId: 'a', otherUsers: 0 },
            { outcome: 'rejected', reason: 'resultOutOfRange' },
          ]),
      }),
    );
    const { wrapper } = await mountExplorer('/ads/explorer/targets');
    await waitForRow('nistkasten meise');
    await selectAllRows();

    const bar = await vi.waitFor(() => wrapper.get('[data-bulk-bar]'));
    expect(bar.text()).toContain('3 markiert');
    await bar.get('[data-bulk="bid"]').trigger('click');
    await flushPromises();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Gebot für 2 Targets ändern');
    expect(dialog.textContent).toContain('1 Zeile wird übersprungen');
    dialog.querySelector<HTMLInputElement>('input[value="percent"]')!.click();
    await flushPromises();
    dialog.querySelector<HTMLInputElement>('input[value="decrease"]')!.click();
    const value = dialog.querySelector<HTMLInputElement>('input[data-bulk-value]')!;
    value.value = '10';
    value.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    dialog.querySelector<HTMLElement>('[data-bulk-submit]')!.click();
    await flushPromises();

    expect(staged(requests)[0]!.body).toEqual({
      origin: 'explorer',
      changes: [T1, T2].map((entityId) => ({
        operation: 'adjust',
        entityType: 'target',
        entityId,
        field: 'bid',
        mode: 'percent',
        value: '-10',
      })),
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-stage-result]')?.textContent).toContain(
        '1 Änderung vorgemerkt',
      ),
    );
    expect(document.querySelector('[data-stage-result]')!.textContent).toContain(
      '1 abgelehnt: Das Ergebnis wäre kein gültiger Betrag',
    );
  });

  it('setzt einen festen Wert und prüft die Eingabe vor dem Senden', async () => {
    const { requests } = stubFetch(routes());
    const { wrapper } = await mountExplorer('/ads/explorer/targets');
    await waitForRow('nistkasten meise');
    await selectAllRows();
    await (await vi.waitFor(() => wrapper.get('[data-bulk="bid"]'))).trigger('click');
    await flushPromises();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const submit = dialog.querySelector<HTMLButtonElement>('[data-bulk-submit]')!;
    expect(submit.disabled).toBe(true);
    const value = dialog.querySelector<HTMLInputElement>('input[data-bulk-value]')!;
    expect(
      value.getAttribute('aria-label') ??
        dialog.querySelector(`label[for="${value.id}"]`)?.textContent,
    ).toContain('EUR');
    value.value = '0,75';
    value.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    expect(submit.disabled).toBe(false);
    submit.click();
    await flushPromises();
    expect(staged(requests)[0]!.body).toMatchObject({
      changes: [
        { operation: 'update', entityId: T1, field: 'bid', value: '0.75' },
        { operation: 'update', entityId: T2, field: 'bid', value: '0.75' },
      ],
    });
  });

  it('ändert den Status der markierten Zeilen', async () => {
    const { requests } = stubFetch(routes());
    const { wrapper } = await mountExplorer('/ads/explorer/targets');
    await waitForRow('nistkasten meise');
    await selectAllRows();
    await (await vi.waitFor(() => wrapper.get('[data-bulk="state"]'))).trigger('click');
    await flushPromises();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    dialog.querySelector<HTMLInputElement>('input[value="PAUSED"]')!.click();
    await flushPromises();
    dialog.querySelector<HTMLElement>('[data-bulk-submit]')!.click();
    await flushPromises();
    expect(staged(requests)[0]!.body).toMatchObject({
      changes: [
        {
          operation: 'update',
          entityType: 'target',
          entityId: T1,
          field: 'state',
          value: 'PAUSED',
        },
        {
          operation: 'update',
          entityType: 'target',
          entityId: T2,
          field: 'state',
          value: 'PAUSED',
        },
      ],
    });
  });

  it('öffnet Gebotsstrategie und Platzierungen für genau eine SP-Kampagne', async () => {
    const { requests } = stubFetch(routes());
    const { wrapper } = await mountExplorer('/ads/explorer/campaigns');
    await waitForRow('SP Nistkasten');
    await selectAllRows();
    const bar = await vi.waitFor(() => wrapper.get('[data-bulk-bar]'));
    // Zwei Kampagnen markiert: Der Dialog gilt nur für eine.
    expect(bar.get('[data-bulk="bidding"]').attributes('disabled')).toBeDefined();

    const sbRow = cell('SB Marke', 'name').closest('.ag-row')!.getAttribute('row-index');
    document
      .querySelector<HTMLInputElement>(
        `.ag-row[row-index="${sbRow}"] .ag-selection-checkbox input`,
      )!
      .click();
    await flushPromises();
    await vi.waitFor(() =>
      expect(wrapper.get('[data-bulk="bidding"]').attributes('disabled')).toBeUndefined(),
    );
    await wrapper.get('[data-bulk="bidding"]').trigger('click');
    await flushPromises();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain('SP Nistkasten');
    const strategy = dialog.querySelector<HTMLSelectElement>('select[data-bidding-strategy]')!;
    expect(strategy.value).toBe('SALES_DOWN_ONLY');
    const top = dialog.querySelector<HTMLInputElement>('input[data-placement="placement_top"]')!;
    expect(top.value).toBe('25');
    strategy.value = 'SALES_UP_AND_DOWN';
    strategy.dispatchEvent(new Event('change', { bubbles: true }));
    top.value = '50';
    top.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    dialog.querySelector<HTMLElement>('[data-bidding-submit]')!.click();
    await flushPromises();

    const update = (field: string, value: string) => ({
      operation: 'update',
      entityType: 'campaign',
      entityId: CAMPAIGN,
      field,
      value,
    });
    expect(staged(requests)[0]!.body).toEqual({
      origin: 'explorer',
      changes: [
        update('bidding_strategy', 'SALES_UP_AND_DOWN'),
        update('placement_top', '50'),
        update('placement_rest_of_search', '0'),
        update('placement_product_page', '0'),
        update('placement_amazon_business', '0'),
      ],
    });
  });
});
