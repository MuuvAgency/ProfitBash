import { parseJsonLossless } from './json';
import {
  amazonAdsValueLimitIssue,
  MAX_KEYWORD_LENGTH,
  negativeKeywordLimitIssue,
  type AmazonAdsValueLimitIssue,
} from './limits';
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
 * Archivieren und neue Negatives an, seit 4.4 auch neue Kampagnen, Ad Groups, Product Ads, Keywords und Targets,
 * und antwortet wie Amazon mit `207` und einem Ergebnis je Eintrag. Gebote, Budgets und Platzierungen außerhalb der
 * Grenzen des Marktplatzes, zu lange Keywords (`limits.ts`) und Product Ads mit der falschen Produkt-ID für den
 * Kontotyp lehnt er je Eintrag ab, damit Teilfehler ohne API-Zugang vorführbar sind.
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
  ...routesFor('campaigns', 'Campaign', 'campaigns', 'campaignId', 'campaignIdFilter', true),
  ...routesFor('adGroups', 'AdGroup', 'adGroups', 'adGroupId', 'adGroupIdFilter', true),
  ...routesFor('keywords', 'Keyword', 'keywords', 'keywordId', 'keywordIdFilter', true),
  ...routesFor(
    'targets',
    'TargetingClause',
    'targetingClauses',
    'targetId',
    'targetIdFilter',
    true,
  ),
  ...routesFor('productAds', 'ProductAd', 'productAds', 'adId', 'adIdFilter', true),
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
  /** Neu angelegte Entities (4.4; Keywords, Targets und Negatives in `targets`). */
  created: {
    campaigns: MockCampaign[];
    adGroups: MockAdGroup[];
    targets: MockTarget[];
    ads: MockAd[];
  };
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

/** Platzierungen aus `dynamicBidding` (Prozent als Quelltext). */
function placementsOf(
  bidding: { placementBidding?: unknown } | undefined,
): Array<{ placement: string; percentage: string }> | undefined {
  return Array.isArray(bidding?.placementBidding)
    ? (bidding.placementBidding as Array<Record<string, unknown>>).flatMap((entry) => {
        const percentage = text(entry.percentage);
        return typeof entry.placement === 'string' && percentage !== undefined
          ? [{ placement: entry.placement, percentage }]
          : [];
      })
    : undefined;
}

/** Feste Mock-ASIN zu einer SKU (FNV-1a, 8 Hex-Ziffern). */
function mockAsinOf(sku: string): string {
  let value = 0x811c9dc5;
  for (let i = 0; i < sku.length; i += 1) {
    value ^= sku.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return `B0${value.toString(16).toUpperCase().padStart(8, '0')}`;
}

/** Fehler eines Eintrags wie in der 207-Antwort von SP v3. */
function entryError(type: string, reason: string, location: string, message: string) {
  return {
    errorType: type,
    errorValue: { [type]: { reason, cause: { location }, message: `Mock: ${message}` } },
  };
}

/**
 * Schreib-Endpunkte für SB (v4 und v3) und SD (3.2c): Der Mock bildet ihre Antwortformen nicht nach. Getestet sind
 * sie mit msw (`writes-sb-sd.test.ts`).
 */
const UNMOCKED_WRITE_PATH =
  /^\/(sb\/v4\/(campaigns|adGroups|ads)(\/delete)?|sb\/(keywords|targets|negativeKeywords|negativeTargets)|sd\/(campaigns|adGroups|targets|productAds|negativeTargets))$/;

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
        created: { campaigns: [], adGroups: [], targets: [], ads: [] },
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
    const placements = placementsOf(bidding);
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
    overlayOf(profile).created.targets.push({
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

  /** Neue Kampagne, Ad Group, Product Ad, Keyword oder Target (4.4); Negatives über `rememberNegative`. */
  function rememberCreate(
    profile: MockProfile,
    route: WriteRoute,
    id: string,
    item: Record<string, unknown>,
  ) {
    const created = overlayOf(profile).created;
    const state = text(item.state) ?? 'ENABLED';
    const campaignId = text(item.campaignId) ?? '';
    const adGroupId = text(item.adGroupId) ?? '';
    switch (route.listKey) {
      case 'campaigns': {
        const bidding = item.dynamicBidding as
          { strategy?: unknown; placementBidding?: unknown } | undefined;
        created.campaigns.push({
          id,
          adProduct: 'SPONSORED_PRODUCTS',
          name: String(item.name),
          state,
          targeting: String(item.targetingType),
          budget: text((item.budget as { budget?: unknown } | undefined)?.budget) ?? '0',
          bidStrategy:
            (typeof bidding?.strategy === 'string' && EXPORT_STRATEGIES[bidding.strategy]) ||
            'SALES_DOWN_ONLY',
          placements: placementsOf(bidding) ?? [],
          portfolioId: text(item.portfolioId) ?? null,
          ...(typeof item.startDate === 'string' && { startDate: item.startDate }),
        });
        return;
      }
      case 'adGroups':
        created.adGroups.push({
          id,
          campaignId,
          name: String(item.name),
          state,
          defaultBid: text(item.defaultBid) ?? null,
        });
        return;
      case 'productAds': {
        const sku = text(item.sku);
        created.ads.push({
          id,
          campaignId,
          adGroupId,
          state,
          adType: 'PRODUCT_AD',
          // Amazon löst die SKU zur ASIN auf; der Mock leitet eine feste ASIN aus der SKU ab.
          asins: [text(item.asin) ?? mockAsinOf(sku ?? id)],
          ...(sku !== undefined && { sku }),
        });
        return;
      }
      case 'keywords':
        created.targets.push({
          id,
          campaignId,
          adGroupId,
          state,
          negative: false,
          targetType: 'KEYWORD',
          details: { matchType: String(item.matchType), keyword: item.keywordText },
          bid: text(item.bid) ?? null,
        });
        return;
      case 'targetingClauses': {
        const expression = Array.isArray(item.expression)
          ? (item.expression as Array<Record<string, unknown>>)[0]
          : undefined;
        const value = text(expression?.value);
        const category = expression?.type === 'ASIN_CATEGORY_SAME_AS';
        created.targets.push({
          id,
          campaignId,
          adGroupId,
          state,
          negative: false,
          targetType: category ? 'PRODUCT_CATEGORY' : 'PRODUCT',
          details: category
            ? { productCategoryId: value }
            : {
                matchType:
                  expression?.type === 'ASIN_EXPANDED_FROM' ? 'PRODUCT_SIMILAR' : 'PRODUCT_EXACT',
                asin: value,
              },
          bid: text(item.bid) ?? null,
        });
        return;
      }
      default:
        rememberNegative(profile, id, item);
    }
  }

  /** Das Konto mit den gemerkten Änderungen des Profils (für die Exports). */
  function overlay(account: MockAccount): MockAccount {
    const changes = overlays.get(account.profile.amazonProfileId);
    if (!changes) return account;
    const patched = <T extends { id: string }>(items: T[], patches: Map<string, Partial<T>>) =>
      patches.size === 0
        ? items
        : items.map((item) => (patches.has(item.id) ? { ...item, ...patches.get(item.id) } : item));
    const { created } = changes;
    return {
      ...account,
      campaigns: patched<MockCampaign>(
        [...account.campaigns, ...created.campaigns],
        changes.campaigns,
      ),
      adGroups: patched<MockAdGroup>([...account.adGroups, ...created.adGroups], changes.adGroups),
      targets: patched<MockTarget>([...account.targets, ...created.targets], changes.targets),
      ads: patched<MockAd>([...account.ads, ...created.ads], changes.ads),
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

  /** Weitere Prüfungen einer Anlage (Gebote und Budgets prüft `updateError`) oder `null`. */
  function createError(
    route: WriteRoute,
    item: Record<string, unknown>,
    index: number,
    country: string,
    accountType: string,
  ) {
    const at = `$.${route.listKey}[${index}]`;
    const placements = placementsOf(item.dynamicBidding as { placementBidding?: unknown });
    for (const [position, { percentage }] of (placements ?? []).entries()) {
      const issue = amazonAdsValueLimitIssue({
        adProduct: 'SPONSORED_PRODUCTS',
        countryCode: country,
        field: 'placement',
        value: percentage,
      });
      if (issue) {
        return entryError(
          'rangeError',
          issue.code === 'aboveMaximum' ? 'TOO_HIGH' : 'TOO_LOW',
          `${at}.dynamicBidding.placementBidding[${position}].percentage`,
          `Prozentsatz außerhalb von ${issue.min} bis ${issue.max}.`,
        );
      }
    }
    const keywordText = item.keywordText;
    if (typeof keywordText === 'string') {
      const negative = /^NEGATIVE_(EXACT|PHRASE)$/.exec(String(item.matchType))?.[1] as
        'EXACT' | 'PHRASE' | undefined;
      const issue = negative
        ? negativeKeywordLimitIssue(keywordText, negative)
        : keywordText.length > MAX_KEYWORD_LENGTH
          ? { code: 'tooLong', max: MAX_KEYWORD_LENGTH }
          : null;
      if (issue) {
        return entryError(
          'rangeError',
          'TOO_HIGH',
          `${at}.keywordText`,
          issue.code === 'tooLong'
            ? `Keyword länger als ${issue.max} Zeichen.`
            : `Keyword mit mehr als ${issue.max} Wörtern.`,
        );
      }
    }
    if (route.listKey === 'productAds') {
      // Laut Spec: SKU nur bei Sellern, ASIN nur bei Vendoren.
      const vendor = accountType === 'vendor';
      const wrong = vendor
        ? item.sku !== undefined || item.asin === undefined
        : item.asin !== undefined || item.sku === undefined;
      if (wrong) {
        return entryError(
          'productIdentifierError',
          vendor ? 'INVALID_SKU' : 'INVALID_ASIN',
          `${at}.${vendor ? 'sku' : 'asin'}`,
          vendor
            ? 'Vendoren bewerben Produkte über die ASIN.'
            : 'Seller bewerben Produkte über die SKU.',
        );
      }
    }
    return null;
  }

  async function handleWrite(
    request: Request,
    url: URL,
    profile: MockProfile | undefined,
  ): Promise<Response | null> {
    if (UNMOCKED_WRITE_PATH.test(url.pathname) && request.method !== 'GET') {
      // Klarer Grund statt „nicht gefunden“: Der Client meldet ihn je Änderung.
      return Response.json(
        {
          code: 'MOCK_NOT_SUPPORTED',
          details:
            'Der Mock-Anbieter bildet Schreiben nur für Sponsored Products nach; Sponsored Brands und Sponsored Display gehen als Bulk-Datei oder gegen die echte API.',
        },
        { status: 400 },
      );
    }
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
        const failure =
          updateError(route, entry, index, country) ??
          createError(route, entry, index, country, profile.accountType);
        if (failure) {
          error.push({ index, errors: [failure] });
          return;
        }
        created += 1;
        const id = `${idPrefix}${String(created).padStart(4, '0')}`;
        success.push({ index, [route.idKey]: id });
        rememberCreate(profile, route, id, entry);
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
