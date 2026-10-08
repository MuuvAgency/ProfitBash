import { z } from 'zod';
import type { ConnectionRef } from './access-token';
import type { AdsEndpointDeps, RequestOptions } from './client';
import {
  AmazonAdsHttpError,
  AmazonAdsNetworkError,
  AmazonAdsReauthRequiredError,
  AmazonAdsResponseError,
} from './errors';
import { jsonDecimal, stringifyJsonLossless } from './json';
import { amazonIdSchema } from './profiles';

/**
 * Schreibaufträge an Amazon (`docs/tasks/phase-3.md` 3.2a, ADR 005): ein eigenes, schmales Modell
 * (`AmazonAdsWriteOperation`), das hier auf die Endpunkte je Anzeigentyp abgebildet wird. Jobs und Datenbank kennen
 * die Endpunkte nicht. Umgesetzt für **Sponsored Products v3**, geprüft am 2026-10-08 gegen die OpenAPI-Spec
 * (`SponsoredProducts_prod_3p.json`); SB und SD folgen mit 3.2c.
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

/** Höchstzahl der Einträge je Aufruf (SP v3: `maxItems: 1000` in allen Schreib-Endpunkten). */
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
    | { entity: 'keyword' | 'target'; state?: AmazonAdsWriteState; bid?: string }
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

export type AmazonAdsArchiveOperation = OperationBase & {
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
    /** Nicht gesendet bzw. von Amazon gedrosselt: unverändert, später erneut senden. */
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
  /** Amazon drosselt: frühestens nach dieser Zeit weitersenden (`null`: keine Angabe bzw. nicht gedrosselt). */
  retryAfterMs: number | null;
}

// ---------------------------------------------------------------------------
// Endpunkte (SP v3)
// ---------------------------------------------------------------------------

interface Endpoint {
  operation: string;
  method: 'PUT' | 'POST';
  path: string;
  contentType: string;
  /** Schlüssel der ID im Erfolgs-Eintrag der Antwort. */
  idKey: string;
  /** 5xx und Netzwerkfehler wiederholen (nur, wenn eine Wiederholung nichts doppelt anlegt). */
  idempotent: boolean;
  body: (items: unknown[]) => unknown;
}

const vnd = (entity: string) => `application/vnd.sp${entity}.v3+json`;

const list = (key: string) => (items: unknown[]) => ({ [key]: items });
const filter = (key: string) => (ids: unknown[]) => ({ [key]: { include: ids } });

const UPDATE_ENDPOINTS: Record<AmazonAdsUpdateOperation['entity'], Endpoint> = {
  campaign: {
    operation: 'sp.campaigns.update',
    method: 'PUT',
    path: '/sp/campaigns',
    contentType: vnd('Campaign'),
    idKey: 'campaignId',
    idempotent: true,
    body: list('campaigns'),
  },
  adGroup: {
    operation: 'sp.adGroups.update',
    method: 'PUT',
    path: '/sp/adGroups',
    contentType: vnd('AdGroup'),
    idKey: 'adGroupId',
    idempotent: true,
    body: list('adGroups'),
  },
  keyword: {
    operation: 'sp.keywords.update',
    method: 'PUT',
    path: '/sp/keywords',
    contentType: vnd('Keyword'),
    idKey: 'keywordId',
    idempotent: true,
    body: list('keywords'),
  },
  target: {
    operation: 'sp.targets.update',
    method: 'PUT',
    path: '/sp/targets',
    contentType: vnd('TargetingClause'),
    idKey: 'targetId',
    idempotent: true,
    body: list('targetingClauses'),
  },
  productAd: {
    operation: 'sp.productAds.update',
    method: 'PUT',
    path: '/sp/productAds',
    contentType: vnd('ProductAd'),
    idKey: 'adId',
    idempotent: true,
    body: list('productAds'),
  },
};

const archive = (path: string, entity: string, idKey: string, filterKey: string): Endpoint => ({
  operation: `sp.${path}.archive`,
  method: 'POST',
  path: `/sp/${path}/delete`,
  contentType: vnd(entity),
  idKey,
  idempotent: true,
  body: filter(filterKey),
});

const ARCHIVE_ENDPOINTS: Record<AmazonAdsArchiveEntity, Endpoint> = {
  campaign: archive('campaigns', 'Campaign', 'campaignId', 'campaignIdFilter'),
  adGroup: archive('adGroups', 'AdGroup', 'adGroupId', 'adGroupIdFilter'),
  keyword: archive('keywords', 'Keyword', 'keywordId', 'keywordIdFilter'),
  target: archive('targets', 'TargetingClause', 'targetId', 'targetIdFilter'),
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
  ),
  campaignNegativeTarget: archive(
    'campaignNegativeTargets',
    'CampaignNegativeTargetingClause',
    'campaignNegativeTargetingClauseId',
    'campaignNegativeTargetIdFilter',
  ),
};

type CreateKind =
  'negativeKeyword' | 'campaignNegativeKeyword' | 'negativeTarget' | 'campaignNegativeTarget';

const create = (path: string, entity: string, idKey: string, listKey: string): Endpoint => ({
  operation: `sp.${path}.create`,
  method: 'POST',
  path: `/sp/${path}`,
  contentType: vnd(entity),
  idKey,
  idempotent: false,
  body: list(listKey),
});

const CREATE_ENDPOINTS: Record<CreateKind, Endpoint> = {
  negativeKeyword: create(
    'negativeKeywords',
    'NegativeKeyword',
    'negativeKeywordId',
    'negativeKeywords',
  ),
  campaignNegativeKeyword: create(
    'campaignNegativeKeywords',
    'CampaignNegativeKeyword',
    'campaignNegativeKeywordId',
    'campaignNegativeKeywords',
  ),
  negativeTarget: create(
    'negativeTargets',
    'NegativeTargetingClause',
    'targetId',
    'negativeTargetingClauses',
  ),
  campaignNegativeTarget: create(
    'campaignNegativeTargets',
    'CampaignNegativeTargetingClause',
    'campaignNegativeTargetingClauseId',
    'campaignNegativeTargetingClauses',
  ),
};

/** Reihenfolge der Aufrufe: erst Updates (Kampagne vor ihren Kindern), dann Archivieren, zuletzt Anlagen. */
const ENDPOINT_ORDER: readonly Endpoint[] = [
  ...Object.values(UPDATE_ENDPOINTS),
  ...Object.values(ARCHIVE_ENDPOINTS),
  ...Object.values(CREATE_ENDPOINTS),
];

const STRATEGIES: Record<AmazonAdsBiddingStrategy, string> = {
  SALES_DOWN_ONLY: 'LEGACY_FOR_SALES',
  SALES_UP_AND_DOWN: 'AUTO_FOR_SALES',
  NONE: 'MANUAL',
};

// ---------------------------------------------------------------------------
// Abbildung der Änderungen
// ---------------------------------------------------------------------------

/** Eintrag im Body des Endpunkts, oder `null`, wenn die Änderung nichts ändert. */
function updateItem(op: AmazonAdsUpdateOperation): Record<string, unknown> | null {
  const endpoint = UPDATE_ENDPOINTS[op.entity];
  const item: Record<string, unknown> = { [endpoint.idKey]: op.amazonId };
  if (op.state !== undefined) item.state = op.state;
  if (op.entity === 'campaign') {
    if (op.dailyBudget !== undefined) {
      item.budget = { budgetType: 'DAILY', budget: jsonDecimal(op.dailyBudget) };
    }
    if (op.bidding !== undefined) {
      item.dynamicBidding = {
        strategy: STRATEGIES[op.bidding.strategy],
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
  if (!/^\d+$/.test(value))
    throw new TypeError('Prozentsatz einer Platzierung ist keine ganze Zahl.');
  return value;
}

function createTarget(op: AmazonAdsCreateNegativeOperation): { endpoint: Endpoint; item: unknown } {
  const parent = {
    campaignId: op.amazonCampaignId,
    ...(op.amazonAdGroupId !== null && { adGroupId: op.amazonAdGroupId }),
  };
  const onCampaign = op.amazonAdGroupId === null;
  if (op.negative.type === 'keyword') {
    return {
      endpoint: CREATE_ENDPOINTS[onCampaign ? 'campaignNegativeKeyword' : 'negativeKeyword'],
      item: {
        ...parent,
        keywordText: op.negative.keywordText,
        matchType: `NEGATIVE_${op.negative.matchType}`,
        state: 'ENABLED',
      },
    };
  }
  return {
    endpoint: CREATE_ENDPOINTS[onCampaign ? 'campaignNegativeTarget' : 'negativeTarget'],
    item: {
      ...parent,
      expression: [{ type: 'ASIN_SAME_AS', value: op.negative.asin }],
      state: 'ENABLED',
    },
  };
}

// ---------------------------------------------------------------------------
// Antworten
// ---------------------------------------------------------------------------

const mutationErrorSchema = z.looseObject({
  errorType: z.string().nullish(),
  errorValue: z.record(z.string(), z.unknown()).nullish(),
});

const mutationResultSchema = z.object({
  success: z
    .array(z.looseObject({ index: z.int().min(0) }))
    .nullish()
    .transform((value) => value ?? []),
  error: z
    .array(z.looseObject({ index: z.int().min(0), errors: z.array(mutationErrorSchema).nullish() }))
    .nullish()
    .transform((value) => value ?? []),
});

/** Genau ein Schlüssel je Antwort (`campaigns`, `keywords` …); gelesen wird der erste. */
const mutationResponseSchema = z.record(z.string(), mutationResultSchema);

const MAX_MESSAGE_LENGTH = 300;

/** Text von Amazon für die Anzeige: Leerraum zusammengefasst, gekürzt. */
function cleanMessage(text: string): string {
  const clean = text.replace(/\s+/gu, ' ').trim();
  return clean.length > MAX_MESSAGE_LENGTH ? `${clean.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : clean;
}

function failureOf(errors: z.output<typeof mutationErrorSchema>[] | null | undefined) {
  const first = errors?.[0];
  const errorType = first?.errorType ?? null;
  const detail = errorType ? first?.errorValue?.[errorType] : undefined;
  const fields =
    typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : {};
  const reason = typeof fields.reason === 'string' && fields.reason !== '' ? fields.reason : null;
  const message = typeof fields.message === 'string' ? cleanMessage(fields.message) : '';
  return {
    code: reason ?? errorType ?? 'UNKNOWN',
    message: message || 'Amazon hat die Änderung ohne Begründung abgelehnt.',
  };
}

// ---------------------------------------------------------------------------
// Senden
// ---------------------------------------------------------------------------

interface Pending {
  /** Position in `operations` (und im Ergebnis). */
  position: number;
  ref: string;
  /** Eintrag im Body bzw. ID im Filter. */
  item: unknown;
  /** ID, falls die Antwort keine nennt (Updates, Archivieren). */
  amazonId: string | null;
}

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
  if (input.adProduct !== 'SPONSORED_PRODUCTS') {
    return {
      results: input.operations.map((op) => ({
        ref: op.ref,
        status: 'failed',
        code: 'AD_PRODUCT_NOT_SUPPORTED',
        message: 'Änderungen über die API gibt es bisher nur für Sponsored Products.',
      })),
      retryAfterMs: null,
    };
  }

  const byEndpoint = new Map<Endpoint, Pending[]>();
  const add = (endpoint: Endpoint, pending: Pending) => {
    const group = byEndpoint.get(endpoint) ?? [];
    group.push(pending);
    byEndpoint.set(endpoint, group);
  };
  input.operations.forEach((op, position) => {
    if (op.type === 'update') {
      const item = updateItem(op);
      if (item === null) {
        results[position] = {
          ref: op.ref,
          status: 'failed',
          code: 'NOTHING_TO_CHANGE',
          message: 'Die Änderung nennt kein Feld.',
        };
        return;
      }
      add(UPDATE_ENDPOINTS[op.entity], { position, ref: op.ref, item, amazonId: op.amazonId });
    } else if (op.type === 'archive') {
      add(ARCHIVE_ENDPOINTS[op.entity], {
        position,
        ref: op.ref,
        item: op.amazonId,
        amazonId: op.amazonId,
      });
    } else {
      const { endpoint, item } = createTarget(op);
      add(endpoint, { position, ref: op.ref, item, amazonId: null });
    }
  });

  let retryAfterMs: number | null = null;
  sending: for (const endpoint of ENDPOINT_ORDER) {
    const group = byEndpoint.get(endpoint);
    if (!group) continue;
    for (let start = 0; start < group.length; start += MAX_WRITE_BATCH_SIZE) {
      const batch = group.slice(start, start + MAX_WRITE_BATCH_SIZE);
      const outcome = await sendBatch(
        deps,
        connection,
        input.amazonProfileId,
        endpoint,
        batch,
        options,
      );
      if (outcome.type === 'throttled') {
        // Alles Weitere bleibt `unsent`: Der Aufrufer sendet es nach der Wartezeit erneut.
        retryAfterMs = outcome.retryAfterMs;
        break sending;
      }
      batch.forEach((pending, index) => {
        results[pending.position] = { ref: pending.ref, ...outcome.results[index]! };
      });
    }
  }
  return { results, retryAfterMs };
}

type ItemOutcome = AmazonAdsWriteResult extends infer R
  ? R extends { ref: string }
    ? Omit<R, 'ref'>
    : never
  : never;

type BatchOutcome =
  { type: 'throttled'; retryAfterMs: number | null } | { type: 'done'; results: ItemOutcome[] };

async function sendBatch(
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
  let response: z.output<typeof mutationResponseSchema>;
  try {
    response = await deps.request(connection, {
      operation: endpoint.operation,
      method: endpoint.method,
      path: endpoint.path,
      amazonProfileId,
      headers: { 'Content-Type': endpoint.contentType, Accept: endpoint.contentType },
      body: stringifyJsonLossless(endpoint.body(batch.map((pending) => pending.item))),
      schema: mutationResponseSchema,
      retryServerErrors: endpoint.idempotent,
      ...(options.meter && { meter: options.meter }),
    });
  } catch (error) {
    if (error instanceof AmazonAdsReauthRequiredError) throw error;
    if (error instanceof AmazonAdsHttpError) {
      if (error.status === 429) return { type: 'throttled', retryAfterMs: error.retryAfterMs };
      // Kein Zugriff auf Profil oder Connection: kein Ergebnis je Änderung, der Aufrufer bricht ab.
      if (error.status === 401 || error.status === 403) throw error;
      if (error.status >= 500) {
        return all({
          status: 'unknown',
          message: `Amazon antwortete mit einem Fehler (${error.status}).`,
        });
      }
      return all({
        status: 'failed',
        code: error.code ?? `HTTP_${error.status}`,
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

  const result = Object.values(response)[0];
  const outcomes: ItemOutcome[] = batch.map(() => ({
    status: 'unknown',
    message: 'Amazon hat für diese Änderung kein Ergebnis genannt.',
  }));
  for (const success of result?.success ?? []) {
    const pending = batch[success.index];
    if (!pending) continue;
    const id = amazonIdSchema.safeParse(success[endpoint.idKey]);
    outcomes[success.index] = {
      status: 'applied',
      amazonId: id.success ? id.data : pending.amazonId,
    };
  }
  for (const failure of result?.error ?? []) {
    if (!batch[failure.index]) continue;
    outcomes[failure.index] = { status: 'failed', ...failureOf(failure.errors) };
  }
  return { type: 'done', results: outcomes };
}
