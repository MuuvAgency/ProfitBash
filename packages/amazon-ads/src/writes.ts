import { z } from 'zod';
import type { ConnectionRef } from './access-token';
import type { AdsEndpointDeps, RequestOptions } from './client';
import {
  AmazonAdsError,
  AmazonAdsHttpError,
  AmazonAdsNetworkError,
  AmazonAdsResponseError,
} from './errors';
import { isPlainDecimal, jsonDecimal, stringifyJsonLossless } from './json';
import {
  cleanMessage,
  errorCode,
  indexedReader,
  requireId,
  WriteNotSupportedError,
  type Endpoint,
  type ItemOutcome,
  type MappedOperation,
  type Pending,
  type WriteDialect,
} from './write-endpoints';
import { SB_DIALECT, SD_DIALECT } from './writes-sb-sd';

/**
 * Schreibaufträge an Amazon (`docs/tasks/phase-3.md` 3.2a, ADR 005): ein eigenes, schmales Modell
 * (`AmazonAdsWriteOperation`), das hier auf die Endpunkte je Anzeigentyp abgebildet wird. Jobs und Datenbank kennen
 * die Endpunkte nicht. Umgesetzt für **Sponsored Products v3** (geprüft am 2026-10-08 gegen die OpenAPI-Spec
 * `SponsoredProducts_prod_3p.json`), **Sponsored Brands** (v4, Keywords und Targets v3) und **Sponsored Display**
 * (3.2c, geprüft am 2026-10-09 gegen die Specs von Amazon; Abbildung und Antwortformen in `writes-sb-sd.ts`).
 *
 * SP v3 in Kürze:
 * - `PUT /sp/<entity>` ändert bis zu 1000 Entities je Aufruf, Content-Type und Accept je Entity
 *   (`application/vnd.sp<Entity>.v3+json`). Zustände beim Update: nur `ENABLED` | `PAUSED`.
 * - Archivieren geht über `POST /sp/<entity>/delete` mit einem ID-Filter (setzt den Zustand auf `ARCHIVED`).
 * - Negatives anlegen über `POST /sp/negativeKeywords`, `/sp/campaignNegativeKeywords`, `/sp/negativeTargets`,
 *   `/sp/campaignNegativeTargets`.
 * - Antwort `207` mit `{ <entities>: { success: [{ index, <id> }], error: [{ index, errors: [...] }] } }`: Erfolg
 *   und Fehler **je Eintrag** (Teilfehler), `index` zeigt in das Array der Anfrage.
 * - Gebote und Budgets sind JSON-Zahlen: geschrieben wird der Decimal-String als Zahl-Literal (`jsonDecimal`).
 *
 * Wiederholungen: 429 immer (HTTP-Kern, Anfrage-Budget je Profil). 5xx und Netzwerkfehler nur bei Updates und beim
 * Archivieren (sie setzen denselben Zielwert); Anlagen werden nicht wiederholt (sonst doppelte Negatives).
 */

/** Höchstzahl der Einträge je Aufruf bei SP v3 (`maxItems: 1000` in allen Schreib-Endpunkten); SB und SD: weniger. */
export const MAX_WRITE_BATCH_SIZE = 1000;

export type AmazonAdsWriteState = 'ENABLED' | 'PAUSED';

/** Gebotsstrategie im eigenen Modell (wie `amazon_ads_campaigns.bidding_strategy`). */
export type AmazonAdsBiddingStrategy = 'SALES_DOWN_ONLY' | 'SALES_UP_AND_DOWN' | 'NONE';

export interface AmazonAdsPlacementAdjustment {
  /** `PLACEMENT_TOP` | `PLACEMENT_REST_OF_SEARCH` | `PLACEMENT_PRODUCT_PAGE` | `SITE_AMAZON_BUSINESS`. */
  placement: string;
  /** Ganze Prozent, 0 bis 900. */
  percentage: string;
}

interface OperationBase {
  /** Kennung des Aufrufers (z. B. ID der Änderung); kommt im Ergebnis zurück. */
  ref: string;
}

/**
 * Kampagne und Ad Group der Entity. Sponsored Brands v3 verlangt sie bei Keywords, Targets und Negatives in jeder
 * Änderung (auch beim Archivieren); SP und SD brauchen sie nicht.
 */
interface ParentIds {
  amazonCampaignId?: string;
  amazonAdGroupId?: string;
}

export type AmazonAdsUpdateOperation = OperationBase & { type: 'update'; amazonId: string } & (
    | {
        entity: 'campaign';
        state?: AmazonAdsWriteState;
        /** Tagesbudget als Decimal-String in der Währung des Profils. */
        dailyBudget?: string;
        /**
         * Gebotsstrategie **und** alle Platzierungen der Kampagne: Amazon ersetzt `dynamicBidding` als Ganzes, wer
         * eines von beiden ändert, schickt deshalb immer den vollständigen Stand.
         */
        bidding?: {
          strategy: AmazonAdsBiddingStrategy;
          placements: AmazonAdsPlacementAdjustment[];
        };
      }
    | { entity: 'adGroup'; state?: AmazonAdsWriteState; defaultBid?: string }
    /** `keyword`: Keyword-Targets; `target`: Produkt-, Kategorie- und Auto-Targets. */
    | ({ entity: 'keyword' | 'target'; state?: AmazonAdsWriteState; bid?: string } & ParentIds)
    | { entity: 'productAd'; state?: AmazonAdsWriteState }
  );

export type AmazonAdsArchiveEntity =
  | 'campaign'
  | 'adGroup'
  | 'keyword'
  | 'target'
  | 'productAd'
  | 'negativeKeyword'
  | 'campaignNegativeKeyword'
  | 'negativeTarget'
  | 'campaignNegativeTarget';

export type AmazonAdsArchiveOperation = OperationBase &
  ParentIds & {
    type: 'archive';
    entity: AmazonAdsArchiveEntity;
    amazonId: string;
  };

export type AmazonAdsCreateNegativeOperation = OperationBase & {
  type: 'createNegative';
  amazonCampaignId: string;
  /** `null`: Negative auf Kampagnenebene. */
  amazonAdGroupId: string | null;
  negative:
    | { type: 'keyword'; keywordText: string; matchType: 'EXACT' | 'PHRASE' }
    | { type: 'product'; asin: string };
};

export type AmazonAdsWriteOperation =
  AmazonAdsUpdateOperation | AmazonAdsArchiveOperation | AmazonAdsCreateNegativeOperation;

export type AmazonAdsWriteResult = { ref: string } &
  /** Amazon hat die Änderung angenommen. `amazonId`: die geänderte bzw. neu vergebene ID, soweit genannt. */
  (
    | { status: 'applied'; amazonId: string | null }
    /** Amazon hat die Änderung abgelehnt (Grund und Text von Amazon) oder sie ließ sich nicht abbilden. */
    | { status: 'failed'; code: string; message: string }
    /**
     * Nicht gesendet bzw. von Amazon gedrosselt: später erneut senden. (Randfall: Lief ein erster Versuch in einen
     * Timeout und der Wiederholversuch in die Drosselung, kann ein Update oder Archivieren schon gewirkt haben; ein
     * erneutes Senden setzt denselben Zielwert.)
     */
    | { status: 'unsent' }
    /** Ausgang unklar (5xx, Netzwerkfehler, unlesbare Antwort): kann angewendet sein, vor erneutem Senden prüfen. */
    | { status: 'unknown'; message: string }
  );

export interface ApplyChangesInput {
  amazonProfileId: string;
  /** `SPONSORED_PRODUCTS` | `SPONSORED_BRANDS` | `SPONSORED_DISPLAY`: Ad-Typ aller Änderungen dieses Aufrufs. */
  adProduct: string;
  operations: readonly AmazonAdsWriteOperation[];
}

export interface ApplyChangesResult {
  /** Je Änderung ein Ergebnis, in der Reihenfolge der Eingabe. */
  results: AmazonAdsWriteResult[];
  /** Amazon hat gedrosselt: Änderungen mit `unsent` später erneut senden. */
  throttled: boolean;
  /** Bei Drosselung: frühestens nach dieser Zeit weitersenden, falls Amazon sie nennt. */
  retryAfterMs: number | null;
}

/**
 * Der Lauf wurde abgebrochen, weil Profil oder Connection keinen Zugriff haben (401, 403, abgelehnter oder nicht
 * erneuerbarer Token) oder ein unerwarteter Fehler auftrat. `results` nennt, was bis dahin feststeht (schon
 * angewendete Änderungen!), der Rest ist `unsent`; `cause` ist der ursprüngliche Fehler.
 */
export class AmazonAdsWriteAbortedError extends AmazonAdsError {
  constructor(
    operation: string,
    public readonly results: AmazonAdsWriteResult[],
    cause: unknown,
  ) {
    super(`${operation}: Übermittlung abgebrochen, Teilergebnisse liegen vor.`, operation, {
      cause,
    });
    this.name = 'AmazonAdsWriteAbortedError';
  }
}

// ---------------------------------------------------------------------------
// Sponsored Products v3
// ---------------------------------------------------------------------------

const vnd = (entity: string) => `application/vnd.sp${entity}.v3+json`;

const list = (key: string) => (items: unknown[]) => ({ [key]: items });
const filter = (key: string) => (ids: unknown[]) => ({ [key]: { include: ids } });

const spEndpoint = (
  operation: string,
  method: Endpoint['method'],
  path: string,
  entity: string,
  idKey: string,
  responseKey: string,
  idempotent: boolean,
  body: Endpoint['body'],
): Endpoint => ({
  operation,
  method,
  path,
  contentType: vnd(entity),
  accept: vnd(entity),
  batchSize: MAX_WRITE_BATCH_SIZE,
  idempotent,
  body,
  read: indexedReader(responseKey, idKey),
});

const update = (path: string, entity: string, idKey: string, listKey: string = path): Endpoint =>
  spEndpoint(
    `sp.${path}.update`,
    'PUT',
    `/sp/${path}`,
    entity,
    idKey,
    listKey,
    true,
    list(listKey),
  );

const UPDATE_ENDPOINTS: Record<AmazonAdsUpdateOperation['entity'], Endpoint> = {
  campaign: update('campaigns', 'Campaign', 'campaignId'),
  adGroup: update('adGroups', 'AdGroup', 'adGroupId'),
  keyword: update('keywords', 'Keyword', 'keywordId'),
  target: update('targets', 'TargetingClause', 'targetId', 'targetingClauses'),
  productAd: update('productAds', 'ProductAd', 'adId'),
};
/** Schlüssel der ID im Eintrag je Entity. */
const UPDATE_ID_KEYS: Record<AmazonAdsUpdateOperation['entity'], string> = {
  campaign: 'campaignId',
  adGroup: 'adGroupId',
  keyword: 'keywordId',
  target: 'targetId',
  productAd: 'adId',
};

const archive = (
  path: string,
  entity: string,
  idKey: string,
  filterKey: string,
  responseKey: string = path,
): Endpoint =>
  spEndpoint(
    `sp.${path}.archive`,
    'POST',
    `/sp/${path}/delete`,
    entity,
    idKey,
    responseKey,
    true,
    filter(filterKey),
  );

const ARCHIVE_ENDPOINTS: Record<AmazonAdsArchiveEntity, Endpoint> = {
  campaign: archive('campaigns', 'Campaign', 'campaignId', 'campaignIdFilter'),
  adGroup: archive('adGroups', 'AdGroup', 'adGroupId', 'adGroupIdFilter'),
  keyword: archive('keywords', 'Keyword', 'keywordId', 'keywordIdFilter'),
  target: archive('targets', 'TargetingClause', 'targetId', 'targetIdFilter', 'targetingClauses'),
  productAd: archive('productAds', 'ProductAd', 'adId', 'adIdFilter'),
  negativeKeyword: archive(
    'negativeKeywords',
    'NegativeKeyword',
    'negativeKeywordId',
    'negativeKeywordIdFilter',
  ),
  campaignNegativeKeyword: archive(
    'campaignNegativeKeywords',
    'CampaignNegativeKeyword',
    'campaignNegativeKeywordId',
    'campaignNegativeKeywordIdFilter',
  ),
  negativeTarget: archive(
    'negativeTargets',
    'NegativeTargetingClause',
    'targetId',
    'negativeTargetIdFilter',
    'negativeTargetingClauses',
  ),
  campaignNegativeTarget: archive(
    'campaignNegativeTargets',
    'CampaignNegativeTargetingClause',
    'campaignNegativeTargetingClauseId',
    'campaignNegativeTargetIdFilter',
    'campaignNegativeTargetingClauses',
  ),
};

type CreateKind =
  'negativeKeyword' | 'campaignNegativeKeyword' | 'negativeTarget' | 'campaignNegativeTarget';

/** Anlage-Endpunkt von SP v3 (auch für neue Kampagnen-Strukturen in `creates.ts`): nie wiederholt. */
export const spCreateEndpoint = (
  path: string,
  entity: string,
  idKey: string,
  listKey: string,
): Endpoint =>
  spEndpoint(
    `sp.${path}.create`,
    'POST',
    `/sp/${path}`,
    entity,
    idKey,
    listKey,
    false,
    list(listKey),
  );

export const SP_NEGATIVE_CREATE_ENDPOINTS: Record<CreateKind, Endpoint> = {
  negativeKeyword: spCreateEndpoint(
    'negativeKeywords',
    'NegativeKeyword',
    'negativeKeywordId',
    'negativeKeywords',
  ),
  campaignNegativeKeyword: spCreateEndpoint(
    'campaignNegativeKeywords',
    'CampaignNegativeKeyword',
    'campaignNegativeKeywordId',
    'campaignNegativeKeywords',
  ),
  negativeTarget: spCreateEndpoint(
    'negativeTargets',
    'NegativeTargetingClause',
    'targetId',
    'negativeTargetingClauses',
  ),
  campaignNegativeTarget: spCreateEndpoint(
    'campaignNegativeTargets',
    'CampaignNegativeTargetingClause',
    'campaignNegativeTargetingClauseId',
    'campaignNegativeTargetingClauses',
  ),
};

/** Gebotsstrategie des eigenen Modells → `dynamicBidding.strategy` von SP v3. */
export const SP_BIDDING_STRATEGIES: Record<AmazonAdsBiddingStrategy, string> = {
  SALES_DOWN_ONLY: 'LEGACY_FOR_SALES',
  SALES_UP_AND_DOWN: 'AUTO_FOR_SALES',
  NONE: 'MANUAL',
};

/** Eintrag im Body des Endpunkts, oder `null`, wenn die Änderung nichts ändert. */
function updateItem(op: AmazonAdsUpdateOperation): Record<string, unknown> | null {
  const item: Record<string, unknown> = { [UPDATE_ID_KEYS[op.entity]]: requireId(op.amazonId) };
  if (op.state !== undefined) item.state = op.state;
  if (op.entity === 'campaign') {
    if (op.dailyBudget !== undefined) {
      item.budget = { budgetType: 'DAILY', budget: jsonDecimal(op.dailyBudget) };
    }
    if (op.bidding !== undefined) {
      item.dynamicBidding = {
        strategy: SP_BIDDING_STRATEGIES[op.bidding.strategy],
        placementBidding: op.bidding.placements.map(({ placement, percentage }) => ({
          placement,
          // Ganze Prozent (`integer` in der Spec); `jsonDecimal` prüft die Schreibweise.
          percentage: jsonDecimal(wholeNumber(percentage)),
        })),
      };
    }
  } else if (op.entity === 'adGroup') {
    if (op.defaultBid !== undefined) item.defaultBid = jsonDecimal(op.defaultBid);
  } else if (op.entity !== 'productAd') {
    if (op.bid !== undefined) item.bid = jsonDecimal(op.bid);
  }
  return Object.keys(item).length > 1 ? item : null;
}

function wholeNumber(value: string): string {
  if (!/^\d+$/.test(value) || !isPlainDecimal(value)) {
    throw new TypeError('Prozentsatz einer Platzierung ist keine ganze Zahl.');
  }
  return value;
}

function createTarget(op: AmazonAdsCreateNegativeOperation): MappedOperation {
  const parent = {
    campaignId: requireId(op.amazonCampaignId),
    ...(op.amazonAdGroupId !== null && { adGroupId: requireId(op.amazonAdGroupId) }),
  };
  const onCampaign = op.amazonAdGroupId === null;
  if (op.negative.type === 'keyword') {
    return {
      endpoint:
        SP_NEGATIVE_CREATE_ENDPOINTS[onCampaign ? 'campaignNegativeKeyword' : 'negativeKeyword'],
      amazonId: null,
      item: {
        ...parent,
        keywordText: op.negative.keywordText,
        matchType: `NEGATIVE_${op.negative.matchType}`,
        state: 'ENABLED',
      },
    };
  }
  return {
    endpoint:
      SP_NEGATIVE_CREATE_ENDPOINTS[onCampaign ? 'campaignNegativeTarget' : 'negativeTarget'],
    amazonId: null,
    item: {
      ...parent,
      expression: [{ type: 'ASIN_SAME_AS', value: op.negative.asin }],
      state: 'ENABLED',
    },
  };
}

const SP_DIALECT: WriteDialect = {
  map(op) {
    if (op.type === 'update') {
      const item = updateItem(op);
      return item && { endpoint: UPDATE_ENDPOINTS[op.entity], item, amazonId: op.amazonId };
    }
    if (op.type === 'archive') {
      const amazonId = requireId(op.amazonId);
      return { endpoint: ARCHIVE_ENDPOINTS[op.entity], item: amazonId, amazonId };
    }
    return createTarget(op);
  },
  order: [
    ...Object.values(UPDATE_ENDPOINTS),
    ...Object.values(ARCHIVE_ENDPOINTS),
    ...Object.values(SP_NEGATIVE_CREATE_ENDPOINTS),
  ],
};

const DIALECTS: Record<string, WriteDialect> = {
  SPONSORED_PRODUCTS: SP_DIALECT,
  SPONSORED_BRANDS: SB_DIALECT,
  SPONSORED_DISPLAY: SD_DIALECT,
};

// ---------------------------------------------------------------------------
// Senden
// ---------------------------------------------------------------------------

const OPERATION = 'ads.applyChanges';

export async function applyChanges(
  deps: AdsEndpointDeps,
  connection: ConnectionRef,
  input: ApplyChangesInput,
  options: RequestOptions = {},
): Promise<ApplyChangesResult> {
  const results: AmazonAdsWriteResult[] = input.operations.map((op) => ({
    ref: op.ref,
    status: 'unsent',
  }));
  const fail = (position: number, code: string, message: string) => {
    results[position] = { ref: input.operations[position]!.ref, status: 'failed', code, message };
  };
  const dialect = DIALECTS[input.adProduct];
  if (!dialect) {
    input.operations.forEach((_, position) =>
      fail(
        position,
        'AD_PRODUCT_NOT_SUPPORTED',
        'Änderungen über die API gibt es nur für Sponsored Products, Sponsored Brands und Sponsored Display.',
      ),
    );
    return { results, throttled: false, retryAfterMs: null };
  }

  const byEndpoint = new Map<Endpoint, Pending[]>();
  /** Je Endpunkt jede Entity nur einmal: Die Antwort wird über den Index bzw. die Reihenfolge zugeordnet. */
  const seen = new Set<string>();
  input.operations.forEach((op, position) => {
    let mapped: MappedOperation | null;
    try {
      mapped = dialect.map(op);
    } catch (error) {
      if (error instanceof WriteNotSupportedError) {
        fail(position, error.code, error.message);
        return;
      }
      // Ein ungültiger Wert betrifft nur diese Änderung (`jsonDecimal` und `requireId` werfen `TypeError`).
      if (!(error instanceof TypeError) && !(error instanceof SyntaxError)) throw error;
      fail(
        position,
        'INVALID_VALUE',
        'Die Änderung enthält einen ungültigen Wert oder eine ungültige ID.',
      );
      return;
    }
    if (mapped === null) {
      fail(position, 'NOTHING_TO_CHANGE', 'Die Änderung nennt kein Feld.');
      return;
    }
    const { endpoint, item, amazonId } = mapped;
    if (amazonId !== null) {
      const key = `${endpoint.method} ${endpoint.path}:${amazonId}`;
      if (seen.has(key)) {
        fail(
          position,
          'DUPLICATE_OPERATION',
          'Dieselbe Entity steht in diesem Aufruf schon einmal; Felder einer Entity gehören in eine Änderung.',
        );
        return;
      }
      seen.add(key);
    }
    const group = byEndpoint.get(endpoint) ?? [];
    group.push({ position, ref: op.ref, item, amazonId });
    byEndpoint.set(endpoint, group);
  });

  let throttled = false;
  let retryAfterMs: number | null = null;
  sending: for (const endpoint of dialect.order) {
    const group = byEndpoint.get(endpoint);
    if (!group) continue;
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
        // Was schon feststeht, darf nicht verloren gehen: Der Aufrufer hält es fest und behandelt dann die Ursache.
        throw new AmazonAdsWriteAbortedError(OPERATION, results, error);
      }
      if (outcome.type === 'throttled') {
        // Alles Weitere bleibt `unsent`: Der Aufrufer sendet es nach der Wartezeit erneut.
        throttled = true;
        retryAfterMs = outcome.retryAfterMs;
        break sending;
      }
      const done = outcome.results;
      batch.forEach((pending, index) => {
        const result = done[index]!;
        if (result.status === 'unsent') throttled = true;
        results[pending.position] = { ref: pending.ref, ...result };
      });
    }
  }
  return { results, throttled, retryAfterMs };
}

export type BatchOutcome =
  { type: 'throttled'; retryAfterMs: number | null } | { type: 'done'; results: ItemOutcome[] };

/** Die Form der Antwort kennt erst der Endpunkt (`read`). */
const anyResponseSchema = z.unknown();

/**
 * Sendet ein Stück an einen Endpunkt. Wirft, wenn der Lauf nicht weitergehen kann: kein Zugriff (401, 403), Fehler
 * beim Holen des Access-Tokens (dann wurde nichts gesendet) oder Unerwartetes.
 */
export async function sendBatch(
  deps: AdsEndpointDeps,
  connection: ConnectionRef,
  amazonProfileId: string,
  endpoint: Endpoint,
  batch: readonly Pending[],
  options: RequestOptions,
): Promise<BatchOutcome> {
  const all = (outcome: ItemOutcome): BatchOutcome => ({
    type: 'done',
    results: batch.map(() => outcome),
  });
  let response: unknown;
  try {
    response = await deps.request(connection, {
      operation: endpoint.operation,
      method: endpoint.method,
      path: endpoint.path,
      amazonProfileId,
      headers: { 'Content-Type': endpoint.contentType, Accept: endpoint.accept },
      body: stringifyJsonLossless(endpoint.body(batch.map((pending) => pending.item))),
      schema: anyResponseSchema,
      retryServerErrors: endpoint.idempotent,
      ...(options.meter && { meter: options.meter }),
    });
  } catch (error) {
    // Fehler anderer Aufrufe (Token holen bei LWA) sagen nichts über dieses Stück: Es wurde nicht gesendet.
    if (!(error instanceof AmazonAdsError) || error.operation !== endpoint.operation) throw error;
    if (error instanceof AmazonAdsHttpError) {
      if (error.status === 429) return { type: 'throttled', retryAfterMs: error.retryAfterMs };
      if (error.status === 401 || error.status === 403) throw error;
      if (error.status >= 500) {
        return all({
          status: 'unknown',
          message: `Amazon antwortete mit einem Fehler (${error.status}).`,
        });
      }
      return all({
        status: 'failed',
        code:
          error.code !== null
            ? errorCode(error.code, `HTTP_${error.status}`)
            : `HTTP_${error.status}`,
        message: error.details
          ? cleanMessage(error.details)
          : `Amazon hat den Aufruf abgelehnt (${error.status}).`,
      });
    }
    if (error instanceof AmazonAdsNetworkError) {
      return all({
        status: 'unknown',
        message: error.timedOut ? 'Zeitüberschreitung bei Amazon.' : 'Netzwerkfehler bei Amazon.',
      });
    }
    if (error instanceof AmazonAdsResponseError) {
      return all({ status: 'unknown', message: 'Die Antwort von Amazon war nicht lesbar.' });
    }
    throw error;
  }

  const outcomes = endpoint.read(response, batch);
  return outcomes === null
    ? all({ status: 'unknown', message: 'Die Antwort von Amazon war nicht lesbar.' })
    : { type: 'done', results: outcomes };
}
