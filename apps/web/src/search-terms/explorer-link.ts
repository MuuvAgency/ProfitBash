import { DEFAULT_FILTER_STATE } from '../analytics/filters';
import { filterLink } from '../analytics/useAnalyticsFilters';
import {
  DEFAULT_CHART_METRICS,
  drillQuery,
  EXPLORER_BASE_PATH,
  explorerStateToQuery,
} from '../explorer/state';

/**
 * Sprung von einer Zeile der Suchbegriff-Analyse in den Explorer (2b.2e), gebaut wie die Links des Explorers selbst:
 * Auswahl der Filterleiste über `filterLink` (Client der Analyse, Datei-Zeitraum als eigener Zeitraum), Zustand des
 * Explorers über `explorerStateToQuery`, Drill-Down über `drillQuery`. Vergleich, Währung und Attribution stehen auf
 * den Standardwerten des Explorers.
 *
 * Bewusst ohne einzelne Profile: Die Profilauswahl steht nie in der URL (nur der Merker `pf=1`, der beim Leser dessen
 * letzte eigene Auswahl meint). Client und Drill-Down legen die Zeilen schon fest; so bedeutet der Link in jedem Tab
 * und für jeden Leser dasselbe.
 */

export interface ExplorerLinkSource {
  /** Client des Profils, `null` = Profil ohne Client. */
  clientId: string | null;
  periodStart: string;
  periodEnd: string;
}

export interface ExplorerLinkRow {
  campaignId: string | null;
  adGroupId: string | null;
}

export type ExplorerLinkLevel = 'campaign' | 'adGroup';

/**
 * Ziel für Kampagne (ihre Ad Groups) bzw. Ad Group (ihre Targets, die Kampagne als Drill-Down darüber). `null`, wenn
 * die Entity im Profil fehlt (die Datei kann eine Teilmenge sein): Dann bleibt der Name reiner Text.
 */
export function explorerEntityLink(
  source: ExplorerLinkSource,
  level: ExplorerLinkLevel,
  row: ExplorerLinkRow,
) {
  const id = level === 'campaign' ? row.campaignId : row.adGroupId;
  if (!id) return null;
  const filters = filterLink(EXPLORER_BASE_PATH, {
    ...DEFAULT_FILTER_STATE,
    clientIds: source.clientId ? [source.clientId] : [],
    withoutClient: source.clientId === null,
    profileIds: null,
    period: { preset: 'custom', range: { from: source.periodStart, to: source.periodEnd } },
  });
  // „Entfernte anzeigen“: Die Analyse kennt auch inzwischen archivierte Kampagnen und Ad Groups (ältere Datei), der
  // Explorer blendet sie sonst aus und bliebe leer.
  const explorer = explorerStateToQuery({
    drill: { portfolioId: null, campaignId: null, adGroupId: null },
    includeRemoved: true,
    adProducts: [],
    chartMetrics: DEFAULT_CHART_METRICS,
    sort: null,
    productSearch: [],
  });
  const target = drillQuery({ ...filters.query, ...explorer }, level, id, {
    campaignId: row.campaignId,
  });
  return { path: target.path, query: target.query, state: filters.state };
}
