import { describe, expect, it } from 'vitest';
import type { LocationQuery } from 'vue-router';
import { filterStateFromQuery, parseStoredFilters } from '../analytics/filters';
import { explorerStateFromRoute } from '../explorer/state';
import { explorerEntityLink, type ExplorerLinkSource } from './explorer-link';

const CLIENT = '00000000-0000-4000-8000-0000000000c1';
const CAMPAIGN = '00000000-0000-4000-8000-0000000000d1';
const AD_GROUP = '00000000-0000-4000-8000-0000000000e1';

const source = (patch: Partial<ExplorerLinkSource> = {}): ExplorerLinkSource => ({
  clientId: CLIENT,
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  ...patch,
});

describe('Sprung aus der Suchbegriff-Analyse in den Explorer', () => {
  it('Kampagne: Ad Groups der Kampagne, Client und Datei-Zeitraum in der Filterleiste', () => {
    const link = explorerEntityLink(source(), 'campaign', {
      campaignId: CAMPAIGN,
      adGroupId: AD_GROUP,
    });
    expect(link).toMatchObject({
      path: '/ads/explorer/ad-groups',
      query: {
        clients: CLIENT,
        period: 'custom',
        from: '2026-09-01',
        to: '2026-09-30',
        campaign: CAMPAIGN,
      },
    });
    expect(link?.query).not.toHaveProperty('adGroup');
  });

  it('zeigt auch entfernte Entities: Die Datei kann älter sein als das Archivieren der Kampagne', () => {
    for (const level of ['campaign', 'adGroup'] as const) {
      const link = explorerEntityLink(source(), level, {
        campaignId: CAMPAIGN,
        adGroupId: AD_GROUP,
      })!;
      expect(link.query).toMatchObject({ removed: '1' });
      expect(explorerStateFromRoute(link.path, link.query as LocationQuery).includeRemoved).toBe(
        true,
      );
    }
  });

  it('Ad Group: Targets der Ad Group, die Kampagne bleibt als Drill-Down darüber', () => {
    const link = explorerEntityLink(source(), 'adGroup', {
      campaignId: CAMPAIGN,
      adGroupId: AD_GROUP,
    });
    expect(link).toMatchObject({
      path: '/ads/explorer/targets',
      query: { campaign: CAMPAIGN, adGroup: AD_GROUP, period: 'custom' },
    });
  });

  it('der Link bedeutet überall dasselbe: ohne Verlaufseintrag (neuer Tab, kopierter Link) dieselbe Auswahl', () => {
    const link = explorerEntityLink(source(), 'adGroup', {
      campaignId: CAMPAIGN,
      adGroupId: AD_GROUP,
    })!;
    const query = link.query as LocationQuery;
    const expected = {
      clientIds: [CLIENT],
      withoutClient: false,
      profileIds: null,
      period: { preset: 'custom', range: { from: '2026-09-01', to: '2026-09-30' } },
    };
    const withEntry = filterStateFromQuery(query, parseStoredFilters(link.state.analyticsFilters));
    expect(withEntry).toMatchObject(expected);
    // Die letzte eigene Auswahl eines anderen Lesers (anderes Profil desselben Clients) ändert nichts.
    const foreign = { ...withEntry, profileIds: ['00000000-0000-4000-8000-0000000000a9'] };
    expect(filterStateFromQuery(query, foreign)).toEqual(withEntry);
    expect(filterStateFromQuery(query, null)).toEqual(withEntry);
    expect(link.query).not.toHaveProperty('pf');
    const state = explorerStateFromRoute(link.path, query);
    expect(state.level).toBe('target');
    expect(state.drill).toEqual({ portfolioId: null, campaignId: CAMPAIGN, adGroupId: AD_GROUP });
  });

  it('Profil ohne Client: „Ohne Client“ statt einer Client-ID', () => {
    const link = explorerEntityLink(source({ clientId: null }), 'campaign', {
      campaignId: CAMPAIGN,
      adGroupId: null,
    })!;
    expect(link.query).toMatchObject({ nc: '1' });
    expect(link.query).not.toHaveProperty('clients');
    expect(link.query).not.toHaveProperty('pf');
  });

  it('kein Link, wenn die Entity im Profil fehlt (die Datei kann eine Teilmenge sein)', () => {
    expect(
      explorerEntityLink(source(), 'campaign', { campaignId: null, adGroupId: AD_GROUP }),
    ).toBeNull();
    expect(
      explorerEntityLink(source(), 'adGroup', { campaignId: CAMPAIGN, adGroupId: null }),
    ).toBeNull();
  });

  it('Ad Group ohne bekannte Kampagne: Link nur mit der Ad Group', () => {
    const link = explorerEntityLink(source(), 'adGroup', {
      campaignId: null,
      adGroupId: AD_GROUP,
    })!;
    expect(link.query).toMatchObject({ adGroup: AD_GROUP });
    expect(link.query).not.toHaveProperty('campaign');
  });
});
