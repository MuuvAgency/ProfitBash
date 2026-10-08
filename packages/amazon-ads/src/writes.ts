import { z } from 'zod';
import type { ConnectionRef } from './access-token';
import type { AdsEndpointDeps, RequestOptions } from './client';
import {
  AmazonAdsError,
  AmazonAdsHttpError,
  AmazonAdsNetworkError,
  AmazonAdsResponseError,
} from './errors';
import { sanitize } from './http';
import { isPlainDecimal, jsonDecimal, stringifyJsonLossless } from './json';
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
// Endpunkte (SP v3)
// ---------------------------------------------------------------------------

interface Endpoint {
  operation: string;
  method: 'PUT' | 'POST';
  path: string;
  contentType: string;
  /** Schlüssel der ID im Erfolgs-Eintrag der Antwort. */
  idKey: string;
  /** Schlüssel des Ergebnisses in der Antwort (`campaigns`, `keywords` …). */
  responseKey: string;
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
    responseKey: 'campaigns',
    body: list('campaigns'),
  },
  adGroup: {
    operation: 'sp.adGroups.update',
    method: 'PUT',
    path: '/sp/adGroups',
    contentType: vnd('AdGroup'),
    idKey: 'adGroupId',
    idempotent: true,
    responseKey: 'adGroups',
    body: list('adGroups'),
  },
  keyword: {
    operation: 'sp.keywords.update',
    method: 'PUT',
    path: '/sp/keywords',
    contentType: vnd('Keyword'),
    idKey: 'keywordId',
    idempotent: true,
    responseKey: 'keywords',
    body: list('keywords'),
  },
  target: {
    operation: 'sp.targets.update',
    method: 'PUT',
    path: '/sp/targets',
    contentType: vnd('TargetingClause'),
    idKey: 'targetId',
    idempotent: true,
    responseKey: 'targetingClauses',
    body: list('targetingClauses'),
  },
  productAd: {
    operation: 'sp.productAds.update',
    method: 'PUT',
    path: '/sp/productAds',
    contentType: vnd('ProductAd'),
    idKey: 'adId',
    idempotent: true,
    responseKey: 'productAds',
    body: list('productAds'),
  },
};

const archive = (
  path: string,
  entity: string,
  idKey: string,
  filterKey: string,
  responseKey: string = path,
): Endpoint => ({
  operation: `sp.${path}.archive`,
  method: 'POST',
  path: `/sp/${path}/delete`,
  contentType: vnd(entity),
  idKey,
  idempotent: true,
  responseKey,
  body: filter(filterKey),
});

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

const create = (path: string, entity: string, idKey: string, listKey: string): Endpoint => ({
  operation: `sp.${path}.create`,
  method: 'POST',
  path: `/sp/${path}`,
  contentType: vnd(entity),
  idKey,
  idempotent: false,
  responseKey: listKey,
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
  const item: Record<string, unknown> = { [endpoint.idKey]: requireId(op.amazonId) };
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
  if (!/^\d+$/.test(value) || !isPlainDecimal(value)) {
    throw new TypeError('Prozentsatz einer Platzierung ist keine ganze Zahl.');
  }
  return value;
}

function requireId(value: string): string {
  if (!/^\d+$/.test(value)) throw new TypeError('Amazon-ID besteht nicht nur aus Ziffern.');
  return value;
}

function createTarget(op: AmazonAdsCreateNegativeOperation): { endpoint: Endpoint; item: unknown } {
  const parent = {
    campaignId: requireId(op.amazonCampaignId),
    ...(op.amazonAdGroupId !== null && { adGroupId: requireId(op.amazonAdGroupId) }),
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

/** Gelesen wird nur der Schlüssel des Endpunkts (`responseKey`); weitere Felder der Antwort stören nicht. */
const mutationResponseSchema = z.record(z.string(), z.unknown());

const MAX_MESSAGE_LENGTH = 300;
const ERROR_CODE = /^[A-Za-z0-9_]{1,64}$/;

/** Text von Amazon für die Anzeige: ohne Steuerzeichen und Tokens, Leerraum zusammengefasst, gekürzt. */
function cleanMessage(text: string): string {
  return sanitize(text.replace(/\s+/gu, ' ').trim(), MAX_MESSAGE_LENGTH - 1);
}

type ItemOutcome = AmazonAdsWriteResult extends infer R
  ? R extends { ref: string }
    ? Omit<R, 'ref'>
    : never
  : never;

/** Ergebnis eines Fehler-Eintrags der 207-Antwort. */
function failureOf(errors: z.output<typeof mutationErrorSchema>[] | null | undefined): ItemOutcome {
  const first = errors?.[0];
  const errorType = first?.errorType ?? null;
  const detail = errorType ? first?.errorValue?.[errorType] : undefined;
  const fields =
    typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : {};
  const message = typeof fields.message === 'string' ? cleanMessage(fields.message) : '';
  // Kein Urteil über die Änderung: Amazon hat sie gedrosselt bzw. ist selbst gescheitert.
  if (errorType === 'throttledError') return { status: 'unsent' };
  if (errorType === 'internalServerError') {
    return { status: 'unknown', message: message || 'Interner Fehler bei Amazon.' };
  }
  const code = [fields.reason, errorType].find(
    (value): value is string => typeof value === 'string' && ERROR_CODE.test(value),
  );
  return {
    status: 'failed',
    code: code ?? 'UNKNOWN',
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
  /** ID der geänderten Entity (Updates, Archivieren); `null` bei Anlagen. */
  amazonId: string | null;
}

const OPERATION = 'sp.applyChanges';

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
  if (input.adProduct !== 'SPONSORED_PRODUCTS') {
    input.operations.forEach((_, position) =>
      fail(
        position,
        'AD_PRODUCT_NOT_SUPPORTED',
        'Änderungen über die API gibt es bisher nur für Sponsored Products.',
      ),
    );
    return { results, throttled: false, retryAfterMs: null };
  }

  const byEndpoint = new Map<Endpoint, Pending[]>();
  /** Je Endpunkt jede Entity nur einmal: Die Antwort wird über den Index zugeordnet. */
  const seen = new Set<string>();
  const add = (endpoint: Endpoint, pending: Pending) => {
    if (pending.amazonId !== null) {
      const key = `${endpoint.path}:${pending.amazonId}`;
      if (seen.has(key)) {
        fail(
          pending.position,
          'DUPLICATE_OPERATION',
          'Dieselbe Entity steht in diesem Aufruf schon einmal; Felder einer Entity gehören in eine Änderung.',
        );
        return;
      }
      seen.add(key);
    }
    const group = byEndpoint.get(endpoint) ?? [];
    group.push(pending);
    byEndpoint.set(endpoint, group);
  };
  input.operations.forEach((op, position) => {
    try {
      if (op.type === 'update') {
        const item = updateItem(op);
        if (item === null) {
          fail(position, 'NOTHING_TO_CHANGE', 'Die Änderung nennt kein Feld.');
          return;
        }
        add(UPDATE_ENDPOINTS[op.entity], { position, ref: op.ref, item, amazonId: op.amazonId });
      } else if (op.type === 'archive') {
        const amazonId = requireId(op.amazonId);
        add(ARCHIVE_ENDPOINTS[op.entity], { position, ref: op.ref, item: amazonId, amazonId });
      } else {
        const { endpoint, item } = createTarget(op);
        add(endpoint, { position, ref: op.ref, item, amazonId: null });
      }
    } catch (error) {
      // Ein ungültiger Wert betrifft nur diese Änderung (`jsonDecimal` und `requireId` werfen `TypeError`).
      if (!(error instanceof TypeError) && !(error instanceof SyntaxError)) throw error;
      fail(
        position,
        'INVALID_VALUE',
        'Die Änderung enthält einen ungültigen Wert oder eine ungültige ID.',
      );
    }
  });

  let throttled = false;
  let retryAfterMs: number | null = null;
  sending: for (const endpoint of ENDPOINT_ORDER) {
    const group = byEndpoint.get(endpoint);
    if (!group) continue;
    for (let start = 0; start < group.length; start += MAX_WRITE_BATCH_SIZE) {
      const batch = group.slice(start, start + MAX_WRITE_BATCH_SIZE);
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

type BatchOutcome =
  { type: 'throttled'; retryAfterMs: number | null } | { type: 'done'; results: ItemOutcome[] };

/**
 * Sendet ein Stück an einen Endpunkt. Wirft, wenn der Lauf nicht weitergehen kann: kein Zugriff (401, 403), Fehler
 * beim Holen des Access-Tokens (dann wurde nichts gesendet) oder Unerwartetes.
 */
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
          error.code !== null && ERROR_CODE.test(error.code) ? error.code : `HTTP_${error.status}`,
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

  const parsed = mutationResultSchema.safeParse(response[endpoint.responseKey]);
  if (!parsed.success) {
    return all({ status: 'unknown', message: 'Die Antwort von Amazon war nicht lesbar.' });
  }
  const outcomes: ItemOutcome[] = batch.map(() => ({
    status: 'unknown',
    message: 'Amazon hat für diese Änderung kein Ergebnis genannt.',
  }));
  /** Wie oft die Antwort einen Index nennt: mehr als einmal ist widersprüchlich. */
  const mentions = new Map<number, number>();
  const mention = (index: number) => mentions.set(index, (mentions.get(index) ?? 0) + 1);
  for (const success of parsed.data.success) {
    const pending = batch[success.index];
    if (!pending) continue;
    mention(success.index);
    const id = amazonIdSchema.safeParse(success[endpoint.idKey]);
    if (pending.amazonId !== null && id.success && id.data !== pending.amazonId) {
      outcomes[success.index] = {
        status: 'unknown',
        message: 'Amazon hat für diese Änderung eine andere ID genannt.',
      };
      continue;
    }
    outcomes[success.index] = {
      status: 'applied',
      amazonId: id.success ? id.data : pending.amazonId,
    };
  }
  for (const failure of parsed.data.error) {
    if (!batch[failure.index]) continue;
    mention(failure.index);
    outcomes[failure.index] = failureOf(failure.errors);
  }
  for (const [index, count] of mentions) {
    if (count > 1) {
      outcomes[index] = {
        status: 'unknown',
        message: 'Amazon hat für diese Änderung widersprüchliche Ergebnisse genannt.',
      };
    }
  }
  return { type: 'done', results: outcomes };
}
