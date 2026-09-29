import { describe, expect, it } from 'vitest';
import {
  childLevel,
  drillQuery,
  EXPLORER_TABS,
  explorerStateFromRoute,
  explorerQuery,
  explorerStateToQuery,
  levelFromPath,
  parseProductTerms,
  pathForLevel,
} from './state';

const CAMPAIGN = '00000000-0000-4000-8000-0000000000ca';
const AD_GROUP = '00000000-0000-4000-8000-0000000000ad';
const PORTFOLIO = '00000000-0000-4000-8000-0000000000bf';

describe('Reiter und Pfade (F6)', () => {
  it('sieben Reiter in der Reihenfolge von F6', () => {
    expect(EXPLORER_TABS.map((tab) => tab.level)).toEqual([
      'portfolio',
      'campaign',
      'adGroup',
      'target',
      'productAd',
      'searchTerm',
      'negative',
    ]);
  });

  it('Ebene aus dem Pfad, Standard Kampagnen', () => {
    expect(levelFromPath('/ads/explorer/targets')).toBe('target');
    expect(levelFromPath('/ads/explorer/search-terms')).toBe('searchTerm');
    expect(levelFromPath('/ads/explorer')).toBe('campaign');
    expect(levelFromPath('/ads/explorer/unbekannt')).toBe('campaign');
    expect(pathForLevel('productAd')).toBe('/ads/explorer/product-ads');
  });

  it('Drill-Down: Portfolio → Kampagnen → Ad Groups → Targets, danach nichts', () => {
    expect(childLevel('portfolio')).toBe('campaign');
    expect(childLevel('campaign')).toBe('adGroup');
    expect(childLevel('adGroup')).toBe('target');
    expect(childLevel('target')).toBeNull();
    expect(childLevel('negative')).toBeNull();
  });
});

describe('explorerStateFromRoute', () => {
  it('liest Ebene, Drill-Down (je eine ID), entfernte, Ad-Typen und Chart-Kennzahlen', () => {
    const state = explorerStateFromRoute('/ads/explorer/targets', {
      campaign: CAMPAIGN,
      adGroup: AD_GROUP,
      removed: '1',
      adp: 'SPONSORED_BRANDS,SPONSORED_DISPLAY',
      m1: 'clicks',
      m2: 'acos',
    });
    expect(state).toEqual({
      level: 'target',
      drill: { portfolioId: null, campaignId: CAMPAIGN, adGroupId: AD_GROUP },
      includeRemoved: true,
      adProducts: ['SPONSORED_BRANDS', 'SPONSORED_DISPLAY'],
      chartMetrics: ['clicks', 'acos'],
      sort: null,
      productSearch: [],
    });
  });

  it('Standard: keine Einschränkung, Chart Spend und Umsatz', () => {
    expect(explorerStateFromRoute('/ads/explorer', {})).toEqual({
      level: 'campaign',
      drill: { portfolioId: null, campaignId: null, adGroupId: null },
      includeRemoved: false,
      adProducts: [],
      chartMetrics: ['cost', 'sales'],
      sort: null,
      productSearch: [],
    });
  });

  it('Sortierung als eine Spalte mit Richtung (`sort=cost.desc`)', () => {
    expect(explorerStateFromRoute('/ads/explorer', { sort: 'acos.asc' }).sort).toEqual({
      column: 'acos',
      direction: 'asc',
    });
    expect(explorerStateFromRoute('/ads/explorer', { sort: 'acos' }).sort).toBeNull();
    expect(explorerStateFromRoute('/ads/explorer', { sort: '<x>.desc' }).sort).toBeNull();
  });

  it('ungültige Werte werden ignoriert', () => {
    const state = explorerStateFromRoute('/ads/explorer/campaigns', {
      campaign: 'kein-uuid',
      adp: 'TV',
      m1: 'irgendwas',
    });
    expect(state.drill.campaignId).toBeNull();
    expect(state.adProducts).toEqual([]);
    expect(state.chartMetrics).toEqual(['cost', 'sales']);
  });
});

describe('Drill-Down-Links', () => {
  it('Klick auf eine Zeile filtert die nächste Ebene; obere Ebenen bleiben', () => {
    const base = { clients: 'c1', period: 'last7' };
    expect(drillQuery(base, 'campaign', CAMPAIGN, { portfolioId: PORTFOLIO })).toEqual({
      path: '/ads/explorer/ad-groups',
      query: { clients: 'c1', period: 'last7', portfolio: PORTFOLIO, campaign: CAMPAIGN },
    });
    expect(
      drillQuery(base, 'adGroup', AD_GROUP, { portfolioId: null, campaignId: CAMPAIGN }),
    ).toEqual({
      path: '/ads/explorer/targets',
      query: { clients: 'c1', period: 'last7', campaign: CAMPAIGN, adGroup: AD_GROUP },
    });
  });
});

describe('Drill-Down von einer oberen Ebene', () => {
  it('verwirft Drill-IDs unterhalb der geklickten Ebene', () => {
    expect(
      drillQuery({}, 'campaign', CAMPAIGN, {
        portfolioId: PORTFOLIO,
        campaignId: 'alt',
        adGroupId: AD_GROUP,
      }),
    ).toEqual({
      path: '/ads/explorer/ad-groups',
      query: { portfolio: PORTFOLIO, campaign: CAMPAIGN },
    });
    expect(drillQuery({ adGroup: AD_GROUP, campaign: 'alt' }, 'portfolio', PORTFOLIO, {})).toEqual({
      path: '/ads/explorer/campaigns',
      query: { portfolio: PORTFOLIO },
    });
  });
});

describe('explorerQuery (Filter für die API)', () => {
  it('Drill-Down und entfernte Entities', () => {
    expect(
      explorerQuery({
        level: 'target',
        drill: { portfolioId: null, campaignId: CAMPAIGN, adGroupId: AD_GROUP },
        includeRemoved: true,
        adProducts: ['SPONSORED_PRODUCTS'],
        chartMetrics: ['cost', 'sales'],
        sort: null,
        productSearch: [],
      }),
    ).toEqual({
      level: 'target',
      adProducts: ['SPONSORED_PRODUCTS'],
      filter: { campaignIds: [CAMPAIGN], adGroupIds: [AD_GROUP], includeRemoved: true },
    });
  });
});

describe('explorerStateToQuery (Ansicht laden)', () => {
  it('schreibt nur Abweichungen vom Standard und liest sie gleich zurück', () => {
    const state = {
      level: 'target' as const,
      drill: { portfolioId: null, campaignId: CAMPAIGN, adGroupId: AD_GROUP },
      includeRemoved: true,
      adProducts: ['SPONSORED_BRANDS' as const, 'SPONSORED_PRODUCTS' as const],
      chartMetrics: ['clicks', 'sales'] as ['clicks', 'sales'],
      sort: { column: 'cost', direction: 'desc' as const },
      productSearch: [],
    };
    const query = explorerStateToQuery(state);
    expect(query).toEqual({
      campaign: CAMPAIGN,
      adGroup: AD_GROUP,
      removed: '1',
      adp: 'SPONSORED_PRODUCTS,SPONSORED_BRANDS',
      m1: 'clicks',
      sort: 'cost.desc',
    });
    expect(explorerStateFromRoute(pathForLevel('target'), query)).toEqual({
      ...state,
      adProducts: ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS'],
    });
    expect(
      explorerStateToQuery({ ...explorerStateFromRoute('/ads/explorer', {}), adProducts: [] }),
    ).toEqual({});
  });
});

describe('Suche nach ASIN/SKU (F10, 2.11)', () => {
  it('Eingabe: Leerzeichen, Komma, Semikolon oder Zeilenumbruch trennen, doppelte fallen weg', () => {
    expect(parseProductTerms(' B0AAA0001, b0aaa0001\nSKU-7;  B0BBB0002\t')).toEqual([
      'B0AAA0001',
      'SKU-7',
      'B0BBB0002',
    ]);
    expect(parseProductTerms('   ')).toEqual([]);
    expect(
      parseProductTerms(Array.from({ length: 120 }, (_, i) => `A${i}`).join(' ')),
    ).toHaveLength(100);
    expect(parseProductTerms(`${'x'.repeat(61)} OK`)).toEqual(['OK']);
  });

  it('steht als `q` in der URL und wirkt nur im Reiter Product Ads', () => {
    const state = explorerStateFromRoute('/ads/explorer/product-ads', { q: 'B0AAA0001,SKU-7' });
    expect(state.productSearch).toEqual(['B0AAA0001', 'SKU-7']);
    expect(explorerQuery(state).filter).toEqual({ productSearch: ['B0AAA0001', 'SKU-7'] });
    expect(explorerStateToQuery(state)).toEqual({ q: 'B0AAA0001,SKU-7' });
    const campaigns = explorerStateFromRoute('/ads/explorer/campaigns', { q: 'B0AAA0001' });
    expect(explorerQuery(campaigns).filter).toEqual({});
  });
});
