import type { ConnectionRef } from './access-token';
import type { AdsEndpointDeps, RequestOptions } from './client';
import { isPlainDecimal, jsonDecimal } from './json';
import { PLACEMENT_PERCENTAGE_LIMIT } from './limits';
import { requireId, type Endpoint, type Pending } from './write-endpoints';
import { SD_CREATE_ENDPOINTS } from './writes-sb-sd';
import {
  AmazonAdsWriteAbortedError,
  sendBatch,
  SP_BIDDING_STRATEGIES,
  SP_NEGATIVE_CREATE_ENDPOINTS,
  spCreateEndpoint,
  type AmazonAdsBiddingStrategy,
  type AmazonAdsPlacementAdjustment,
  type AmazonAdsWriteResult,
  type AmazonAdsWriteState,
  type ApplyChangesResult,
  type BatchOutcome,
} from './writes';

/**
 * Neue Kampagnen-Strukturen für **Sponsored Products v3** über die API anlegen (`docs/tasks/phase-4.md` 4.4, ADR 005,
 * geprüft am 2026-10-09 gegen die OpenAPI-Spec `SponsoredProducts_prod_3p.json`), seit 4.9 auch für **Sponsored
 * Display v3** (Entities mit Präfix `sd`, geprüft am 2026-10-10 gegen die SD-3.0-Spec: Listen ohne Hülle, IDs als
 * JSON-Zahl, Zustände klein, Startdatum `YYYYMMDD`, Taktik `T00020`/`T00030`, Ziele nur mit `adGroupId`). Eigenes, schmales Modell wie bei
 * `applyChanges`: Eine Operation nennt ihre Eltern über `ref` (in derselben Eingabe oder schon angelegt), der Client
 * setzt die neuen IDs aus den Antworten von Amazon ein.
 *
 * - Reihenfolge: Kampagnen → Ad Groups → Product Ads, Keywords, Targets, negative Keywords, negative Targets.
 * - `POST /sp/<entity>` legt bis zu 1000 Entities je Aufruf an, Antwort `207` mit Erfolg und Fehler je `index`
 *   (dieselbe Form wie bei Updates, `indexedReader`).
 * - Kinder einer gescheiterten oder unklaren Elternanlage scheitern mit `PARENT_NOT_CREATED`, Kinder eines nicht
 *   gesendeten Elternteils bleiben `unsent`. Fortsetzen nach Drosselung über `created` (ref → Amazon-ID).
 * - Anlagen werden nie wiederholt (5xx und Netzwerkfehler → `unknown`), sonst entstünden Kampagnen doppelt.
 */

export type AmazonAdsCreateOperation = { ref: string } & (
  | {
      entity: 'campaign';
      name: string;
      targetingType: 'AUTO' | 'MANUAL';
      state: AmazonAdsWriteState;
      /** Tagesbudget als Decimal-String in der Währung des Profils. */
      dailyBudget: string;
      /** `YYYY-MM-DD` (Zeitzone des Marktplatzes; Amazon nimmt ohne Angabe heute). */
      startDate: string;
      biddingStrategy: AmazonAdsBiddingStrategy;
      placements: AmazonAdsPlacementAdjustment[];
      amazonPortfolioId: string | null;
      /**
       * Ausspielung außerhalb von Amazon (`offAmazonSettings.offAmazonBudgetControlStrategy`): `increaseReach` →
       * `MAXIMIZE_REACH`, `limitSpend` → `MINIMIZE_SPEND`; `null` lässt die Voreinstellung von Amazon.
       */
      offAmazon: 'increaseReach' | 'limitSpend' | null;
    }
  | {
      entity: 'adGroup';
      campaignRef: string;
      name: string;
      defaultBid: string;
      state: AmazonAdsWriteState;
    }
  | {
      entity: 'productAd';
      campaignRef: string;
      adGroupRef: string;
      /** Genau eins von beiden: `sku` bei Sellern, `asin` bei Vendoren (laut Spec je Kontotyp). */
      sku: string | null;
      asin: string | null;
      state: AmazonAdsWriteState;
    }
  | {
      entity: 'keyword';
      campaignRef: string;
      adGroupRef: string;
      keywordText: string;
      matchType: 'EXACT' | 'PHRASE' | 'BROAD';
      /** `null`: Standardgebot der Ad Group. */
      bid: string | null;
      state: AmazonAdsWriteState;
    }
  | {
      entity: 'target';
      campaignRef: string;
      adGroupRef: string;
      /** `value`: ASIN bzw. bei `ASIN_CATEGORY_SAME_AS` die ID der Kategorie. */
      expression: {
        type: 'ASIN_SAME_AS' | 'ASIN_EXPANDED_FROM' | 'ASIN_CATEGORY_SAME_AS';
        value: string;
      };
      bid: string | null;
      state: AmazonAdsWriteState;
    }
  | {
      entity: 'negativeKeyword';
      campaignRef: string;
      adGroupRef: string;
      keywordText: string;
      matchType: 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE';
    }
  | { entity: 'negativeTarget'; campaignRef: string; adGroupRef: string; asin: string }
  | {
      entity: 'sdCampaign';
      name: string;
      state: AmazonAdsWriteState;
      dailyBudget: string;
      /** `YYYY-MM-DD`; die API nimmt `YYYYMMDD`. */
      startDate: string;
      /** `T00020` kontextbezogen, `T00030` Zielgruppen. */
      tactic: 'T00020' | 'T00030';
      /** vCPM nur freigeschaltet (F-S7); gehört zur Optimierung `reach`. */
      costType: 'cpc' | 'vcpm';
      amazonPortfolioId: string | null;
    }
  | {
      entity: 'sdAdGroup';
      campaignRef: string;
      name: string;
      defaultBid: string;
      bidOptimization: 'clicks' | 'conversions' | 'reach';
      state: AmazonAdsWriteState;
    }
  | {
      entity: 'sdProductAd';
      campaignRef: string;
      adGroupRef: string;
      sku: string | null;
      asin: string | null;
      state: AmazonAdsWriteState;
    }
  | {
      entity: 'sdTarget';
      campaignRef: string;
      adGroupRef: string;
      /** Kontext (ASIN, Kategorie) oder Zielgruppe der beworbenen Produkte mit Rückblick. */
      expression:
        | { type: 'asinSameAs' | 'asinCategorySameAs'; value: string }
        | { type: 'views' | 'purchases'; lookbackDays: number };
      bid: string | null;
      state: AmazonAdsWriteState;
    }
  | { entity: 'sdNegativeTarget'; campaignRef: string; adGroupRef: string; asin: string }
);

export type AmazonAdsCreateEntity = AmazonAdsCreateOperation['entity'];

export interface ApplyCreatesInput {
  amazonProfileId: string;
  operations: readonly AmazonAdsCreateOperation[];
  /**
   * In einem früheren Lauf schon angelegt: ref → Amazon-ID (Fortsetzen nach Drosselung). Diese refs werden nicht
   * erneut gesendet (Ergebnis `applied` mit der bekannten ID), dienen aber als Eltern.
   */
  created?: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Endpunkte
// ---------------------------------------------------------------------------

const ENDPOINTS: Record<AmazonAdsCreateEntity, Endpoint> = {
  campaign: spCreateEndpoint('campaigns', 'Campaign', 'campaignId', 'campaigns'),
  adGroup: spCreateEndpoint('adGroups', 'AdGroup', 'adGroupId', 'adGroups'),
  productAd: spCreateEndpoint('productAds', 'ProductAd', 'adId', 'productAds'),
  keyword: spCreateEndpoint('keywords', 'Keyword', 'keywordId', 'keywords'),
  target: spCreateEndpoint('targets', 'TargetingClause', 'targetId', 'targetingClauses'),
  negativeKeyword: SP_NEGATIVE_CREATE_ENDPOINTS.negativeKeyword,
  negativeTarget: SP_NEGATIVE_CREATE_ENDPOINTS.negativeTarget,
  sdCampaign: SD_CREATE_ENDPOINTS.campaign,
  sdAdGroup: SD_CREATE_ENDPOINTS.adGroup,
  sdProductAd: SD_CREATE_ENDPOINTS.productAd,
  sdTarget: SD_CREATE_ENDPOINTS.target,
  sdNegativeTarget: SD_CREATE_ENDPOINTS.negativeTarget,
};

/** Reihenfolge der Aufrufe: Eltern vor Kindern. */
const ORDER: readonly AmazonAdsCreateEntity[] = [
  'campaign',
  'adGroup',
  'productAd',
  'keyword',
  'target',
  'negativeKeyword',
  'negativeTarget',
  'sdCampaign',
  'sdAdGroup',
  'sdProductAd',
  'sdTarget',
  'sdNegativeTarget',
];

const isSd = (entity: AmazonAdsCreateEntity) => entity.startsWith('sd');
/** Elternart je Anzeigentyp: SP-Kinder unter SP-Eltern, SD-Kinder unter SD-Eltern. */
const parentEntity = (entity: AmazonAdsCreateEntity, level: 'campaign' | 'adGroup') =>
  isSd(entity) ? (level === 'campaign' ? 'sdCampaign' : 'sdAdGroup') : level;
const SD_LOOKBACK_DAYS: ReadonlySet<number> = new Set([7, 14, 30, 60, 90, 180, 365]);
const SD_OPTIMIZATIONS: ReadonlySet<string> = new Set(['clicks', 'conversions', 'reach']);

const OFF_AMAZON = { increaseReach: 'MAXIMIZE_REACH', limitSpend: 'MINIMIZE_SPEND' } as const;

const STATES: ReadonlySet<string> = new Set(['ENABLED', 'PAUSED']);
const PLACEMENTS: ReadonlySet<string> = new Set([
  'PLACEMENT_TOP',
  'PLACEMENT_REST_OF_SEARCH',
  'PLACEMENT_PRODUCT_PAGE',
  'SITE_AMAZON_BUSINESS',
]);
const MATCH_TYPES: ReadonlySet<string> = new Set(['EXACT', 'PHRASE', 'BROAD']);
const NEGATIVE_MATCH_TYPES: ReadonlySet<string> = new Set(['NEGATIVE_EXACT', 'NEGATIVE_PHRASE']);
const EXPRESSION_TYPES: ReadonlySet<string> = new Set([
  'ASIN_SAME_AS',
  'ASIN_EXPANDED_FROM',
  'ASIN_CATEGORY_SAME_AS',
]);
const ASIN = /^[A-Z0-9]{10}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------------------------------------------------------------------------
// Prüfen und Abbilden (ohne Eltern-IDs; die kommen erst beim Senden dazu)
// ---------------------------------------------------------------------------

function oneOf<T extends string>(allowed: ReadonlySet<string>, value: T): T {
  if (!allowed.has(value)) throw new TypeError(`Unbekannter Wert: ${value}`);
  return value;
}

function text(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('Leerer Text.');
  return value;
}

function asin(value: string): string {
  if (!ASIN.test(value)) throw new TypeError('ASIN hat nicht 10 Zeichen A–Z/0–9.');
  return value;
}

function date(value: string): string {
  const match = DATE.exec(value);
  if (!match) throw new TypeError('Datum nicht im Format YYYY-MM-DD.');
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new TypeError('Datum existiert nicht.');
  }
  return value;
}

/** Ganze Prozent innerhalb von `PLACEMENT_PERCENTAGE_LIMIT` (0 bis 900). */
function percentage(value: string): unknown {
  if (!/^\d+$/.test(value) || !isPlainDecimal(value)) {
    throw new TypeError('Prozentsatz einer Platzierung ist keine ganze Zahl.');
  }
  const number = Number(value);
  if (
    number < Number(PLACEMENT_PERCENTAGE_LIMIT.min) ||
    number > Number(PLACEMENT_PERCENTAGE_LIMIT.max)
  ) {
    throw new TypeError('Prozentsatz einer Platzierung außerhalb von 0 bis 900.');
  }
  return jsonDecimal(value);
}

const optionalBid = (bid: string | null) => (bid === null ? {} : { bid: jsonDecimal(bid) });

/** Eintrag ohne Eltern-IDs. Wirft `TypeError` bei ungültigen Werten. */
function body(op: AmazonAdsCreateOperation): Record<string, unknown> {
  switch (op.entity) {
    case 'campaign': {
      const placements = op.placements.map(({ placement, percentage: value }) => ({
        placement: oneOf(PLACEMENTS, placement),
        percentage: percentage(value),
      }));
      if (new Set(placements.map((p) => p.placement)).size !== placements.length) {
        throw new TypeError('Platzierung doppelt.');
      }
      const strategy = SP_BIDDING_STRATEGIES[op.biddingStrategy];
      if (!Object.hasOwn(SP_BIDDING_STRATEGIES, op.biddingStrategy) || strategy === undefined) {
        throw new TypeError('Unbekannte Gebotsstrategie.');
      }
      if (op.offAmazon !== null && !Object.hasOwn(OFF_AMAZON, op.offAmazon)) {
        throw new TypeError('Unbekannte Einstellung für Off-Amazon.');
      }
      return {
        name: text(op.name),
        targetingType: oneOf(new Set(['AUTO', 'MANUAL']), op.targetingType),
        state: oneOf(STATES, op.state),
        budget: { budgetType: 'DAILY', budget: jsonDecimal(op.dailyBudget) },
        startDate: date(op.startDate),
        dynamicBidding: { strategy, placementBidding: placements },
        // Portfolio-IDs sind in SP v3 Text (`type: string`).
        ...(op.amazonPortfolioId !== null && { portfolioId: requireId(op.amazonPortfolioId) }),
        ...(op.offAmazon !== null && {
          offAmazonSettings: { offAmazonBudgetControlStrategy: OFF_AMAZON[op.offAmazon] },
        }),
      };
    }
    case 'adGroup':
      return {
        name: text(op.name),
        defaultBid: jsonDecimal(op.defaultBid),
        state: oneOf(STATES, op.state),
      };
    case 'productAd': {
      // Laut Spec: `sku` nur bei Sellern, `asin` nur bei Vendoren. Den Kontotyp kennt der Aufrufer.
      if ((op.sku === null) === (op.asin === null)) {
        throw new TypeError('Product Ad braucht genau eins von SKU und ASIN.');
      }
      return {
        ...(op.sku !== null ? { sku: text(op.sku) } : { asin: asin(op.asin!) }),
        state: oneOf(STATES, op.state),
      };
    }
    case 'keyword':
      return {
        keywordText: text(op.keywordText),
        matchType: oneOf(MATCH_TYPES, op.matchType),
        state: oneOf(STATES, op.state),
        ...optionalBid(op.bid),
      };
    case 'target': {
      const type = oneOf(EXPRESSION_TYPES, op.expression.type);
      const value =
        type === 'ASIN_CATEGORY_SAME_AS'
          ? requireId(op.expression.value)
          : asin(op.expression.value);
      return {
        expressionType: 'MANUAL',
        expression: [{ type, value }],
        state: oneOf(STATES, op.state),
        ...optionalBid(op.bid),
      };
    }
    case 'negativeKeyword':
      return {
        keywordText: text(op.keywordText),
        matchType: oneOf(NEGATIVE_MATCH_TYPES, op.matchType),
        state: 'ENABLED',
      };
    case 'negativeTarget':
      return { expression: [{ type: 'ASIN_SAME_AS', value: asin(op.asin) }], state: 'ENABLED' };
    case 'sdCampaign':
      return {
        name: text(op.name),
        state: oneOf(STATES, op.state).toLowerCase(),
        budgetType: 'daily',
        budget: jsonDecimal(op.dailyBudget),
        startDate: date(op.startDate).replaceAll('-', ''),
        tactic: oneOf(new Set(['T00020', 'T00030']), op.tactic),
        costType: oneOf(new Set(['cpc', 'vcpm']), op.costType),
        // Portfolio-IDs sind in SD v3 `integer`.
        ...(op.amazonPortfolioId !== null && {
          portfolioId: jsonDecimal(requireId(op.amazonPortfolioId)),
        }),
      };
    case 'sdAdGroup':
      return {
        name: text(op.name),
        defaultBid: jsonDecimal(op.defaultBid),
        bidOptimization: oneOf(SD_OPTIMIZATIONS, op.bidOptimization),
        state: oneOf(STATES, op.state).toLowerCase(),
      };
    case 'sdProductAd':
      if ((op.sku === null) === (op.asin === null)) {
        throw new TypeError('Product Ad braucht genau eins von SKU und ASIN.');
      }
      return {
        ...(op.sku !== null ? { sku: text(op.sku) } : { asin: asin(op.asin!) }),
        state: oneOf(STATES, op.state).toLowerCase(),
      };
    case 'sdTarget': {
      const { expression } = op;
      let predicate: unknown;
      if (expression.type === 'views' || expression.type === 'purchases') {
        if (!SD_LOOKBACK_DAYS.has(expression.lookbackDays)) {
          throw new TypeError('Rückblick einer Zielgruppe nicht 7, 14, 30, 60, 90, 180 oder 365.');
        }
        // Wer die beworbenen Produkte selbst angesehen bzw. gekauft hat (`exactProduct`).
        predicate = {
          type: expression.type,
          value: [{ type: 'exactProduct' }, { type: 'lookback', value: String(expression.lookbackDays) }],
        };
      } else if (expression.type === 'asinSameAs') {
        predicate = { type: 'asinSameAs', value: asin(expression.value) };
      } else if (expression.type === 'asinCategorySameAs') {
        predicate = { type: 'asinCategorySameAs', value: requireId(expression.value) };
      } else {
        throw new TypeError('Unbekannter Ausdruck.');
      }
      return {
        expressionType: 'manual',
        expression: [predicate],
        state: oneOf(STATES, op.state).toLowerCase(),
        ...optionalBid(op.bid),
      };
    }
    case 'sdNegativeTarget':
      return {
        expressionType: 'manual',
        expression: [{ type: 'asinSameAs', value: asin(op.asin) }],
        state: 'enabled',
      };
  }
}

/** Eltern-IDs im Eintrag: SP als Text, SD als JSON-Zahl; SD-Ziele nennen nur die Ad Group (Spec). */
function parentFields(
  entity: AmazonAdsCreateEntity,
  campaignId: string | undefined,
  adGroupId: string | undefined,
): Record<string, unknown> {
  if (!isSd(entity)) {
    return {
      ...(campaignId !== undefined && { campaignId }),
      ...(adGroupId !== undefined && { adGroupId }),
    };
  }
  const number = (value: string) => jsonDecimal(requireId(value));
  const withCampaign = entity === 'sdAdGroup' || entity === 'sdProductAd';
  return {
    ...(withCampaign && campaignId !== undefined && { campaignId: number(campaignId) }),
    ...(adGroupId !== undefined && { adGroupId: number(adGroupId) }),
  };
}

// ---------------------------------------------------------------------------
// Senden
// ---------------------------------------------------------------------------

const OPERATION = 'ads.applyCreates';

const PARENT_NOT_CREATED = 'Die übergeordnete Kampagne bzw. Ad Group wurde nicht angelegt.';

export async function applyCreates(
  deps: AdsEndpointDeps,
  connection: ConnectionRef,
  input: ApplyCreatesInput,
  options: RequestOptions = {},
): Promise<ApplyChangesResult> {
  const { operations } = input;
  const created = input.created ?? new Map<string, string>();
  const results: AmazonAdsWriteResult[] = operations.map((op) => ({
    ref: op.ref,
    status: 'unsent',
  }));
  const fail = (position: number, code: string, message: string) => {
    results[position] = { ref: operations[position]!.ref, status: 'failed', code, message };
  };

  /** Position je ref (die erste; weitere mit derselben ref sind doppelt). */
  const positions = new Map<string, number>();
  operations.forEach((op, position) => {
    if (positions.has(op.ref)) {
      fail(position, 'DUPLICATE_OPERATION', 'Diese ref steht in diesem Aufruf schon einmal.');
    } else {
      positions.set(op.ref, position);
    }
  });

  /** Eltern-ref passt: schon angelegt oder eine Operation der erwarteten Art in dieser Eingabe. */
  const parentKnown = (ref: string, entity: AmazonAdsCreateEntity) => {
    if (created.has(ref)) return true;
    const position = positions.get(ref);
    return position !== undefined && operations[position]!.entity === entity;
  };

  const bodies = new Map<number, Record<string, unknown>>();
  operations.forEach((op, position) => {
    if (results[position]!.status !== 'unsent') return;
    const known = created.get(op.ref);
    if (known !== undefined) {
      results[position] = { ref: op.ref, status: 'applied', amazonId: known };
      return;
    }
    if (op.entity !== 'campaign' && op.entity !== 'sdCampaign') {
      let parentsValid = parentKnown(op.campaignRef, parentEntity(op.entity, 'campaign'));
      if (op.entity !== 'adGroup' && op.entity !== 'sdAdGroup') {
        parentsValid &&= parentKnown(op.adGroupRef, parentEntity(op.entity, 'adGroup'));
        // Die Ad Group muss zur genannten Kampagne gehören (prüfbar, wenn sie in dieser Eingabe steht).
        const group = operations[positions.get(op.adGroupRef) ?? -1];
        if (
          (group?.entity === 'adGroup' || group?.entity === 'sdAdGroup') &&
          !created.has(op.adGroupRef)
        ) {
          parentsValid &&= group.campaignRef === op.campaignRef;
        }
      }
      // SD: `reach` gehört zu vCPM, `clicks`/`conversions` zu CPC (Guide; prüfbar mit der Kampagne der Eingabe).
      const campaign = operations[positions.get(op.campaignRef) ?? -1];
      if (op.entity === 'sdAdGroup' && campaign?.entity === 'sdCampaign') {
        parentsValid &&= (op.bidOptimization === 'reach') === (campaign.costType === 'vcpm');
      }
      if (!parentsValid) {
        fail(
          position,
          'INVALID_VALUE',
          'Die Anlage nennt eine unbekannte oder unpassende Eltern-ref.',
        );
        return;
      }
    }
    try {
      bodies.set(position, body(op));
    } catch (error) {
      // Ein ungültiger Wert betrifft nur diese Anlage (`jsonDecimal`, `requireId` und die Prüfungen oben).
      if (!(error instanceof TypeError) && !(error instanceof SyntaxError)) throw error;
      fail(position, 'INVALID_VALUE', 'Die Anlage enthält einen ungültigen Wert.');
    }
  });

  /** ID einer Eltern-ref, oder warum es sie (noch) nicht gibt. */
  const parent = (ref: string): { id: string } | 'failed' | 'unsent' => {
    const known = created.get(ref);
    if (known !== undefined) return { id: known };
    const result = results[positions.get(ref)!]!;
    if (result.status === 'applied' && result.amazonId !== null) return { id: result.amazonId };
    return result.status === 'unsent' ? 'unsent' : 'failed';
  };

  let throttled = false;
  let retryAfterMs: number | null = null;
  sending: for (const entity of ORDER) {
    const endpoint = ENDPOINTS[entity];
    const group: Pending[] = [];
    operations.forEach((op, position) => {
      const fields = bodies.get(position);
      if (op.entity !== entity || fields === undefined) return;
      const refs = op.entity === 'campaign' || op.entity === 'sdCampaign' ? [] : [op.campaignRef];
      if (
        op.entity !== 'campaign' &&
        op.entity !== 'sdCampaign' &&
        op.entity !== 'adGroup' &&
        op.entity !== 'sdAdGroup'
      ) {
        refs.push(op.adGroupRef);
      }
      const found = refs.map(parent);
      if (found.includes('failed')) {
        fail(position, 'PARENT_NOT_CREATED', PARENT_NOT_CREATED);
        return;
      }
      if (found.includes('unsent')) return;
      const [campaignId, adGroupId] = found.map((p) => (p as { id: string }).id);
      group.push({
        position,
        ref: op.ref,
        item: { ...parentFields(op.entity, campaignId, adGroupId), ...fields },
        amazonId: null,
      });
    });

    for (let start = 0; start < group.length; start += endpoint.batchSize) {
      const batch = group.slice(start, start + endpoint.batchSize);
      let outcome: BatchOutcome;
      try {
        outcome = await sendBatch(
          deps,
          connection,
          input.amazonProfileId,
          endpoint,
          batch,
          options,
        );
      } catch (error) {
        // Was schon angelegt ist, darf nicht verloren gehen (sonst entstünde es beim nächsten Lauf doppelt).
        throw new AmazonAdsWriteAbortedError(OPERATION, results, error);
      }
      if (outcome.type === 'throttled') {
        throttled = true;
        retryAfterMs = outcome.retryAfterMs;
        break sending;
      }
      batch.forEach((pending, index) => {
        const result = outcome.results[index]!;
        if (result.status === 'unsent') throttled = true;
        // Angelegt, aber ohne ID: Die Entity gibt es vermutlich, ihre Kinder lassen sich trotzdem nicht anlegen.
        results[pending.position] =
          result.status === 'applied' && result.amazonId === null
            ? {
                ref: pending.ref,
                status: 'unknown',
                message: 'Amazon hat die Anlage ohne neue ID bestätigt.',
              }
            : { ref: pending.ref, ...result };
      });
    }
  }
  return { results, throttled, retryAfterMs };
}
