import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTER_STATE, type FilterState } from '../analytics/filters';
import { explorerStateFromRoute } from '../explorer/state';
import { explorerTarget, filtersFromView, matchingView, viewState } from './view-state';

const CLIENT = '00000000-0000-4000-8000-0000000000c1';
const PROFILE_A = '00000000-0000-4000-8000-0000000000a1';
const PROFILE_B = '00000000-0000-4000-8000-0000000000a2';
const CAMPAIGN = '00000000-0000-4000-8000-0000000000ca';

const filters: FilterState = {
  ...DEFAULT_FILTER_STATE,
  clientIds: [CLIENT],
  profileIds: [PROFILE_B, PROFILE_A],
  period: { preset: 'custom', range: { from: '2026-09-01', to: '2026-09-10' } },
};

describe('Zustand einer Ansicht (F8)', () => {
  it('Dashboard: nur die Filterleiste', () => {
    expect(viewState('dashboard', filters)).toEqual({
      filters: {
        clientIds: [CLIENT],
        withoutClient: false,
        profileIds: [PROFILE_B, PROFILE_A],
        period: { preset: 'custom', range: { from: '2026-09-01', to: '2026-09-10' } },
        comparison: 'previous',
        currency: 'auto',
        attribution: 'console',
      },
    });
  });

  it('Explorer: zusätzlich Ebene, Drill-Down, Spalten, Sortierung, Chart', () => {
    const explorer = explorerStateFromRoute('/ads/explorer/ad-groups', {
      campaign: CAMPAIGN,
      sort: 'cost.desc',
      m2: 'acos',
    });
    expect(
      viewState('explorer', filters, { explorer, columns: ['cost', 'sales'] }).explorer,
    ).toEqual({
      level: 'adGroup',
      drill: { portfolioId: null, campaignId: CAMPAIGN, adGroupId: null },
      includeRemoved: false,
      adProducts: [],
      chartMetrics: ['cost', 'acos'],
      columns: ['cost', 'sales'],
      sort: { column: 'cost', direction: 'desc' },
    });
  });

  it('zurück in die Filterleiste; Ungültiges fällt auf den Standard', () => {
    const state = viewState('dashboard', filters);
    expect(filtersFromView(state)).toEqual({
      ...filters,
      profileIds: [PROFILE_A, PROFILE_B],
    });
  });

  it('Suche nach ASIN/SKU im Reiter Product Ads gehört zur Ansicht', () => {
    const explorer = explorerStateFromRoute('/ads/explorer/product-ads', { q: 'B0AAA0001,SKU-7' });
    const state = viewState('explorer', filters, { explorer, columns: null });
    expect(state.explorer?.productSearch).toEqual(['B0AAA0001', 'SKU-7']);
    expect(explorerTarget(state)).toEqual({
      path: '/ads/explorer/product-ads',
      query: { q: 'B0AAA0001,SKU-7' },
    });
    // Nur im Reiter Product Ads; ohne Suche fehlt das Feld (ältere Ansichten haben es nicht).
    const elsewhere = viewState('explorer', filters, {
      explorer: explorerStateFromRoute('/ads/explorer/campaigns', { q: 'B0AAA0001' }),
      columns: null,
    });
    expect(elsewhere.explorer && 'productSearch' in elsewhere.explorer).toBe(false);
    const plain = viewState('explorer', filters, {
      explorer: explorerStateFromRoute('/ads/explorer/campaigns', {}),
      columns: null,
    });
    expect(plain.explorer && 'productSearch' in plain.explorer).toBe(false);
    expect(explorerTarget(plain).query).toEqual({});
  });

  it('Ziel im Explorer: Pfad der Ebene und nur die Parameter der Ansicht', () => {
    const explorer = explorerStateFromRoute('/ads/explorer/targets', { campaign: CAMPAIGN });
    const state = viewState('explorer', filters, { explorer, columns: null });
    expect(explorerTarget(state)).toEqual({
      path: '/ads/explorer/targets',
      query: { campaign: CAMPAIGN },
    });
  });

  it('erkennt die aktive Ansicht unabhängig von der Reihenfolge der IDs', () => {
    const views = [
      { id: 'a', state: viewState('dashboard', DEFAULT_FILTER_STATE) },
      { id: 'b', state: viewState('dashboard', filters) },
    ];
    const current = viewState('dashboard', { ...filters, profileIds: [PROFILE_A, PROFILE_B] });
    expect(matchingView(views, current)?.id).toBe('b');
    // Schlüssel in anderer Reihenfolge (so liefert die DB jsonb zurück).
    const reordered = JSON.parse(
      JSON.stringify(
        views[1]!.state,
        Object.keys(views[1]!.state.filters)
          .reverse()
          .concat('filters', 'period', 'preset', 'range', 'from', 'to'),
      ),
    ) as typeof current;
    expect(matchingView([{ id: 'c', state: reordered }], current)?.id).toBe('c');
    expect(
      matchingView(views, viewState('dashboard', { ...filters, comparison: 'off' })),
    ).toBeNull();
  });
});

describe('Tag-Filter in Ansichten (phase-3.md 3.7)', () => {
  const T1 = '00000000-0000-4000-8000-0000000000d1';
  const T2 = '00000000-0000-4000-8000-0000000000d2';

  it('gehört zur Ansicht und kommt beim Laden zurück', () => {
    const state = viewState('dashboard', { ...DEFAULT_FILTER_STATE, tagIds: [T2, T1] });
    expect(state.filters.tagIds).toEqual([T1, T2]);
    expect(filtersFromView(state).tagIds).toEqual([T1, T2]);
  });

  it('ohne Tag-Filter bleibt die Ansicht wie vor 3.7 gespeichert (aktive Ansicht wird erkannt)', () => {
    const plain = viewState('dashboard', DEFAULT_FILTER_STATE);
    expect('tagIds' in plain.filters).toBe(false);
    const views = [{ id: 'ohne', state: plain }];
    expect(matchingView(views, viewState('dashboard', DEFAULT_FILTER_STATE))?.id).toBe('ohne');
    expect(
      matchingView(views, viewState('dashboard', { ...DEFAULT_FILTER_STATE, tagIds: [T1] })),
    ).toBeNull();
  });
});
