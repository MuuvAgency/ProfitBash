import { parseJsonLossless } from './json';
import { amazonAdsValueLimitIssue, type AmazonAdsValueLimitIssue } from './limits';
import type {
  MockAccount,
  MockAd,
  MockAdGroup,
  MockCampaign,
  MockProfile,
  MockTarget,
} from './mock-data';

/**
 * Schreib-Endpunkte des Mock-Anbieters (Sponsored Products v3, `docs/tasks/phase-3.md` 3.2a): nimmt Updates,
 * Archivieren und neue Negatives an und antwortet wie Amazon mit `207` und einem Ergebnis je Eintrag. Gebote und
 * Budgets außerhalb der Grenzen des Marktplatzes (`limits.ts`) lehnt er je Eintrag ab, damit Teilfehler ohne
 * API-Zugang vorführbar sind.
 *
 * Angenommene Änderungen merkt sich der Mock **im laufenden Prozess** (`overlay`, Dominik 2026-10-08): Der nächste
 * Export liefert sie mit, damit die Demo stimmig bleibt und der Revert nicht fälschlich „bei Amazon geändert“ meldet.
 * Nach einem Neustart liefert der Mock wieder die erzeugten Demo-Daten.
 */

export interface MockWriteSimulation {
  /** So viele Schreibaufrufe beantwortet der Mock zuerst mit 429 (`Retry-After: 120`). Standard 0. */
  throttledWrites?: number;
}

interface WriteRoute {
  method: 'PUT' | 'POST';
  path: string;
  contentType: string;
  /** Schlüssel der Liste in Anfrage und Antwort. */
  listKey: string;
  idKey: string;
  kind: 'update' | 'archive' | 'create';
  /** Bei `archive`: Schlüssel des ID-Filters. */
  filterKey?: string;
}

const vnd = (entity: string) => `application/vnd.sp${entity}.v3+json`;

function routesFor(
  path: string,
  entity: string,
  listKey: string,
  idKey: string,
  filterKey: string,
  creatable: boolean,
): WriteRoute[] {
  const base = { contentType: vnd(entity), listKey, idKey };
  return [
    { ...base, method: 'PUT', path: `/sp/${path}`, kind: 'update' },
    { ...base, method: 'POST', path: `/sp/${path}/delete`, kind: 'archive', filterKey },
    ...(creatable
      ? [{ ...base, method: 'POST' as const, path: `/sp/${path}`, kind: 'create' as const }]
      : []),
  ];
}

const WRITE_ROUTES: readonly WriteRoute[] = [
  ...routesFor('campaigns', 'Campaign', 'campaigns', 'campaignId', 'campaignIdFilter', false),
  ...routesFor('adGroups', 'AdGroup', 'adGroups', 'adGroupId', 'adGroupIdFilter', false),
  ...routesFor('keywords', 'Keyword', 'keywords', 'keywordId', 'keywordIdFilter', false),
  ...routesFor(
    'targets',
    'TargetingClause',
    'targetingClauses',
    'targetId',
    'targetIdFilter',
    false,
  ),
  ...routesFor('productAds', 'ProductAd', 'productAds', 'adId', 'adIdFilter', false),
  ...routesFor(
    'negativeKeywords',
    'NegativeKeyword',
    'negativeKeywords',
    'negativeKeywordId',
    'negativeKeywordIdFilter',
    true,
  ),
  ...routesFor(
    'campaignNegativeKeywords',
    'CampaignNegativeKeyword',
    'campaignNegativeKeywords',
    'campaignNegativeKeywordId',
    'campaignNegativeKeywordIdFilter',
    true,
  ),
  ...routesFor(
    'negativeTargets',
    'NegativeTargetingClause',
    'negativeTargetingClauses',
    'targetId',
    'negativeTargetIdFilter',
    true,
  ),
  ...routesFor(
    'campaignNegativeTargets',
    'CampaignNegativeTargetingClause',
    'campaignNegativeTargetingClauses',
    'campaignNegativeTargetingClauseId',
    'campaignNegativeTargetIdFilter',
    true,
  ),
];

/** Land für die Grenzen aus der Währung des Mock-Profils (die Mock-Profile tragen kein Land). */
const COUNTRY_BY_CURRENCY: Readonly<Record<string, string>> = {
  EUR: 'DE',
  GBP: 'UK',
  SEK: 'SE',
  PLN: 'PL',
  TRY: 'TR',
  USD: 'US',
  CAD: 'CA',
};

/** Gemerkte Änderungen eines Profils. */
interface ProfileOverlay {
  campaigns: Map<
    string,
    Partial<Pick<MockCampaign, 'state' | 'budget' | 'bidStrategy' | 'placements'>>
  >;
  adGroups: Map<string, { state?: string; defaultBid?: string }>;
  /** Keywords, Targets und Negatives (im Export eine gemeinsame Liste). */
  targets: Map<string, { state?: string; bid?: string }>;
  ads: Map<string, { state?: string }>;
  createdNegatives: MockTarget[];
}

type OverlayCollection = 'campaigns' | 'adGroups' | 'targets' | 'ads';

const COLLECTION_BY_LIST_KEY: Readonly<Record<string, OverlayCollection>> = {
  campaigns: 'campaigns',
  adGroups: 'adGroups',
  productAds: 'ads',
};

/** Strategie der Schreib-API → Schreibweise des Exports. */
const EXPORT_STRATEGIES: Readonly<Record<string, string>> = {
  LEGACY_FOR_SALES: 'SALES_DOWN_ONLY',
  AUTO_FOR_SALES: 'SALES_UP_AND_DOWN',
  MANUAL: 'NONE',
};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;

export function createMockWrites(simulation: MockWriteSimulation) {
  let throttled = simulation.throttledWrites ?? 0;
  /** Laufende Nummer für neue IDs; mit dem Startzeitpunkt, damit ein neuer Prozess keine früheren IDs vergibt. */
  let created = 0;
  const idPrefix = `88${Date.now()}`;
  const overlays = new Map<string, ProfileOverlay>();

  function overlayOf(profile: MockProfile): ProfileOverlay {
    let overlay = overlays.get(profile.amazonProfileId);
    if (!overlay) {
      overlay = {
        campaigns: new Map(),
        adGroups: new Map(),
        targets: new Map(),
        ads: new Map(),
        createdNegatives: [],
      };
      overlays.set(profile.amazonProfileId, overlay);
    }
    return overlay;
  }

  function remember(
    profile: MockProfile,
    route: WriteRoute,
    id: string,
    patch: Record<string, unknown>,
  ) {
    const collection = COLLECTION_BY_LIST_KEY[route.listKey] ?? 'targets';
    const map = overlayOf(profile)[collection] as Map<string, Record<string, unknown>>;
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    map.set(id, { ...map.get(id), ...defined });
  }

  function rememberUpdate(profile: MockProfile, route: WriteRoute, item: Record<string, unknown>) {
    const id = text(item[route.idKey]);
    if (id === undefined) return;
    const bidding = item.dynamicBidding as
      { strategy?: unknown; placementBidding?: unknown } | undefined;
    const placements = Array.isArray(bidding?.placementBidding)
      ? (bidding.placementBidding as Array<Record<string, unknown>>).flatMap((entry) => {
          const percentage = text(entry.percentage);
          return typeof entry.placement === 'string' && percentage !== undefined
            ? [{ placement: entry.placement, percentage }]
            : [];
        })
      : undefined;
    remember(profile, route, id, {
      state: text(item.state),
      bid: text(item.bid),
      defaultBid: text(item.defaultBid),
      budget: text((item.budget as { budget?: unknown } | undefined)?.budget),
      bidStrategy:
        typeof bidding?.strategy === 'string' ? EXPORT_STRATEGIES[bidding.strategy] : undefined,
      placements,
    });
  }

  function rememberNegative(profile: MockProfile, id: string, item: Record<string, unknown>) {
    const campaignId = text(item.campaignId);
    if (campaignId === undefined) return;
    const expression = Array.isArray(item.expression)
      ? (item.expression as Array<Record<string, unknown>>)[0]
      : undefined;
    const keyword = typeof item.keywordText === 'string';
    overlayOf(profile).createdNegatives.push({
      id,
      campaignId,
      adGroupId: text(item.adGroupId) ?? null,
      state: 'ENABLED',
      negative: true,
      targetType: keyword ? 'KEYWORD' : 'PRODUCT',
      details: keyword
        ? {
            matchType: String(item.matchType).replace(/^NEGATIVE_/, ''),
            keyword: item.keywordText,
          }
        : { matchType: 'PRODUCT_EXACT', asin: text(expression?.value) },
      bid: null,
    });
  }

  /** Das Konto mit den gemerkten Änderungen des Profils (für die Exports). */
  function overlay(account: MockAccount): MockAccount {
    const changes = overlays.get(account.profile.amazonProfileId);
    if (!changes) return account;
    const patched = <T extends { id: string }>(items: T[], patches: Map<string, Partial<T>>) =>
      patches.size === 0
        ? items
        : items.map((item) => (patches.has(item.id) ? { ...item, ...patches.get(item.id) } : item));
    return {
      ...account,
      campaigns: patched<MockCampaign>(account.campaigns, changes.campaigns),
      adGroups: patched<MockAdGroup>(account.adGroups, changes.adGroups),
      targets: patched<MockTarget>(
        [...account.targets, ...changes.createdNegatives],
        changes.targets,
      ),
      ads: patched<MockAd>(account.ads, changes.ads),
    };
  }

  function limitError(
    type: 'biddingError' | 'budgetError',
    reason: string,
    location: string,
    issue: AmazonAdsValueLimitIssue,
  ) {
    return {
      errorType: type,
      errorValue: {
        [type]: {
          reason,
          cause: { location },
          lowerLimit: issue.min,
          upperLimit: issue.max,
          message: `Mock: Wert außerhalb der Grenzen des Marktplatzes (${issue.min} bis ${issue.max}).`,
        },
      },
    };
  }

  /** Fehler eines Update-Eintrags oder `null`. */
  function updateError(
    route: WriteRoute,
    item: Record<string, unknown>,
    index: number,
    country: string,
  ) {
    const check = (field: 'bid' | 'default_bid' | 'budget', value: unknown) =>
      typeof value === 'string' || typeof value === 'number'
        ? amazonAdsValueLimitIssue({
            adProduct: 'SPONSORED_PRODUCTS',
            countryCode: country,
            field,
            value: String(value),
          })
        : null;
    const at = `$.${route.listKey}[${index}]`;
    const bid = check('bid', item.bid) ?? check('default_bid', item.defaultBid);
    if (bid) {
      const field = item.bid !== undefined ? 'bid' : 'defaultBid';
      return limitError('biddingError', 'BID_OUT_OF_MARKET_PLACE_RANGE', `${at}.${field}`, bid);
    }
    const budget = (item.budget as { budget?: unknown } | undefined)?.budget;
    const budgetIssue = check('budget', budget);
    if (budgetIssue) {
      return limitError(
        'budgetError',
        'BUDGET_OUT_OF_MARKET_PLACE_RANGE',
        `${at}.budget.budget`,
        budgetIssue,
      );
    }
    return null;
  }

  async function handleWrite(
    request: Request,
    url: URL,
    profile: MockProfile | undefined,
  ): Promise<Response | null> {
    const route = WRITE_ROUTES.find((r) => r.method === request.method && r.path === url.pathname);
    if (!route) return null;
    if (!profile) {
      return Response.json(
        { code: 'FORBIDDEN', details: 'Mock: Profil unbekannt.' },
        { status: 403 },
      );
    }
    if (request.headers.get('content-type') !== route.contentType) {
      return Response.json(
        { code: 'UNSUPPORTED_MEDIA_TYPE', details: 'Mock: falscher Content-Type.' },
        { status: 415 },
      );
    }
    if (throttled > 0) {
      throttled -= 1;
      return Response.json(
        { code: 'THROTTLED', message: 'Mock: zu viele Anfragen.' },
        { status: 429, headers: { 'Retry-After': '120' } },
      );
    }

    // Beträge als Quelltext-String: Der Mock rechnet wie der Client nie über `number`.
    const body = parseJsonLossless(await request.text(), { decimals: 'string' }) as Record<
      string,
      unknown
    >;
    const items =
      route.kind === 'archive'
        ? ((body[route.filterKey!] as { include?: unknown[] } | undefined)?.include ?? [])
        : ((body[route.listKey] as unknown[] | undefined) ?? []);
    const country = COUNTRY_BY_CURRENCY[profile.currencyCode] ?? '';
    const success: Record<string, unknown>[] = [];
    const error: Record<string, unknown>[] = [];
    items.forEach((item, index) => {
      if (route.kind === 'archive') {
        success.push({ index, [route.idKey]: item });
        const id = text(item);
        if (id !== undefined) remember(profile, route, id, { state: 'ARCHIVED' });
        return;
      }
      const entry = item as Record<string, unknown>;
      if (route.kind === 'create') {
        created += 1;
        const id = `${idPrefix}${String(created).padStart(4, '0')}`;
        success.push({ index, [route.idKey]: id });
        rememberNegative(profile, id, entry);
        return;
      }
      const failure = updateError(route, entry, index, country);
      if (failure) error.push({ index, errors: [failure] });
      else {
        success.push({ index, [route.idKey]: entry[route.idKey] });
        rememberUpdate(profile, route, entry);
      }
    });
    return new Response(JSON.stringify({ [route.listKey]: { success, error } }), {
      status: 207,
      headers: { 'Content-Type': route.contentType },
    });
  }

  return { handleWrite, overlay };
}
