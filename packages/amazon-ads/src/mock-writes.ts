import { parseJsonLossless } from './json';
import { amazonAdsValueLimitIssue, type AmazonAdsValueLimitIssue } from './limits';
import type { MockProfile } from './mock-data';

/**
 * Schreib-Endpunkte des Mock-Anbieters (Sponsored Products v3, `docs/tasks/phase-3.md` 3.2a): nimmt Updates,
 * Archivieren und neue Negatives an und antwortet wie Amazon mit `207` und einem Ergebnis je Eintrag. Gebote und
 * Budgets außerhalb der Grenzen des Marktplatzes (`limits.ts`) lehnt er je Eintrag ab, damit Teilfehler ohne
 * API-Zugang vorführbar sind.
 *
 * Der Mock merkt sich die Änderungen nicht: Der nächste Export liefert wieder die erzeugten Demo-Daten.
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

export function createMockWrites(simulation: MockWriteSimulation) {
  let throttled = simulation.throttledWrites ?? 0;
  /** Laufende Nummer für neue IDs, nur in diesem Prozess. */
  let created = 0;

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

  return async function handleWrite(
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
        return;
      }
      const entry = item as Record<string, unknown>;
      if (route.kind === 'create') {
        created += 1;
        success.push({ index, [route.idKey]: String(880_000_000_000 + created) });
        return;
      }
      const failure = updateError(route, entry, index, country);
      if (failure) error.push({ index, errors: [failure] });
      else success.push({ index, [route.idKey]: entry[route.idKey] });
    });
    return new Response(JSON.stringify({ [route.listKey]: { success, error } }), {
      status: 207,
      headers: { 'Content-Type': route.contentType },
    });
  };
}
