import { jsonDecimal } from './json';
import {
  collectOutcomes,
  flatFailure,
  indexedReader,
  requireId,
  WriteNotSupportedError,
  type Endpoint,
  type MappedOperation,
  type ResponseEntry,
  type WriteDialect,
} from './write-endpoints';
import type {
  AmazonAdsArchiveOperation,
  AmazonAdsCreateNegativeOperation,
  AmazonAdsUpdateOperation,
} from './writes';

/**
 * Schreib-Endpunkte für **Sponsored Brands** und **Sponsored Display** (`docs/tasks/phase-3.md` 3.2c, ADR 005),
 * geprüft am 2026-10-09 gegen die OpenAPI-Specs von Amazon (`SponsoredBrands_prod_3p.json` für v4, dazu die
 * v3-Specs `sponsored-brands/3-0` und `sponsored-display/3-0`).
 *
 * Sponsored Brands:
 * - Kampagnen, Ad Groups und Ads über **v4** (`/sb/v4/...`): wie SP v3 mit `success`/`error` je `index`, IDs als
 *   Text, aber höchstens **10 Einträge je Aufruf**. Archivieren über `.../delete` mit ID-Filter.
 * - Keywords, Produkt-Targets und Negatives über **v3** (`/sb/keywords`, `/sb/targets`, `/sb/negativeKeywords`,
 *   `/sb/negativeTargets`): höchstens 100 je Aufruf, **IDs als JSON-Zahl**, Zustände klein geschrieben, Kampagne
 *   und Ad Group stehen in jedem Eintrag. Archivieren über den Zustand `archived`. Keywords antworten mit einer
 *   Liste in der Reihenfolge der Anfrage, Targets mit Erfolgs- und Fehlerlisten je `targetRequestIndex`.
 * - Nicht vorhanden: Gebotsstrategie und Platzierungen im eigenen Modell (SB kennt `bidOptimization` und andere
 *   Platzierungen), Standardgebot der Ad Group, Negatives auf Kampagnenebene.
 *
 * Sponsored Display (v3, alles `application/json`): Listen von Einträgen, IDs als JSON-Zahl, Zustände klein;
 * Antwort als Liste `{ code, description, <id> }` in der Reihenfolge der Anfrage. Archivieren über den Zustand
 * `archived`. Negatives nur als negative ASIN in der Ad Group. Keine Keywords.
 */

/** Höchstzahl je Aufruf: SB v4 laut Spec 10, SB v3 100. */
const SB_V4_BATCH_SIZE = 10;
const SB_V3_BATCH_SIZE = 100;
/**
 * Die SD-Spec nennt keine Höchstzahl; Amazons Leitfäden nennen 100 Einträge je Aufruf. Beim ersten echten Lauf
 * prüfen (ADR 005, offene Punkte).
 */
const SD_BATCH_SIZE = 100;

const JSON_TYPE = 'application/json';

/** ID als JSON-Zahl mit genau den Ziffern der ID (v3 erwartet `integer`, IDs passen nicht immer in `number`). */
const numericId = (value: string) => jsonDecimal(requireId(value));
const lower = (state: string) => state.toLowerCase();

const notSupported = (message: string): never => {
  throw new WriteNotSupportedError(message);
};

function parents(op: { amazonCampaignId?: string; amazonAdGroupId?: string }) {
  if (op.amazonCampaignId === undefined || op.amazonAdGroupId === undefined) {
    throw new TypeError('Kampagne und Ad Group der Entity fehlen.');
  }
  return { adGroupId: numericId(op.amazonAdGroupId), campaignId: numericId(op.amazonCampaignId) };
}

// --- Antwortformen ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Liste `{ code, description, <idKey> }` in der Reihenfolge der Anfrage (SB-Keywords v3, SD): `SUCCESS` heißt
 * angenommen, alles andere ist der Grund der Ablehnung.
 */
function orderedReader(idKey: string): Endpoint['read'] {
  return (response, batch) => {
    if (!Array.isArray(response)) return null;
    const entries = (response as unknown[])
      .slice(0, batch.length)
      .flatMap((entry, index): ResponseEntry[] => {
        if (!isRecord(entry)) return [];
        return typeof entry.code === 'string' && entry.code.toUpperCase() === 'SUCCESS'
          ? [{ index, ok: true, id: entry[idKey] }]
          : [{ index, ok: false, outcome: flatFailure(entry.code, entry.description) }];
      });
    return collectOutcomes(batch, entries);
  };
}

/** `{ <prefix>SuccessResults: [{ targetId, targetRequestIndex }], <prefix>ErrorResults: [{ code, details, … }] }`. */
function targetResultsReader(prefix: 'updateTarget' | 'createTarget'): Endpoint['read'] {
  return (response, batch) => {
    if (!isRecord(response)) return null;
    const rows = (key: string) => {
      const value = response[key];
      return Array.isArray(value) ? (value as unknown[]).filter(isRecord) : [];
    };
    const indexOf = (row: Record<string, unknown>) =>
      typeof row.targetRequestIndex === 'number' && Number.isInteger(row.targetRequestIndex)
        ? row.targetRequestIndex
        : -1;
    return collectOutcomes(batch, [
      ...rows(`${prefix}SuccessResults`).map((row): ResponseEntry => ({
        index: indexOf(row),
        ok: true,
        id: row.targetId,
      })),
      ...rows(`${prefix}ErrorResults`).map((row): ResponseEntry => ({
        index: indexOf(row),
        ok: false,
        outcome: flatFailure(row.code, row.details),
      })),
    ]);
  };
}

// ---------------------------------------------------------------------------
// Sponsored Brands
// ---------------------------------------------------------------------------

const sbV4Type = (resource: string) => `application/vnd.sb${resource}resource.v4+json`;

function sbV4(
  path: 'campaigns' | 'adGroups' | 'ads',
  resource: string,
  idKey: string,
): { update: Endpoint; archive: Endpoint } {
  const base = {
    contentType: sbV4Type(resource),
    accept: sbV4Type(resource),
    batchSize: SB_V4_BATCH_SIZE,
    idempotent: true,
    read: indexedReader(path, idKey),
  };
  return {
    update: {
      ...base,
      operation: `sb.${path}.update`,
      method: 'PUT',
      path: `/sb/v4/${path}`,
      body: (items) => ({ [path]: items }),
    },
    archive: {
      ...base,
      operation: `sb.${path}.archive`,
      method: 'POST',
      path: `/sb/v4/${path}/delete`,
      body: (ids) => ({ [`${idKey}Filter`]: { include: ids } }),
    },
  };
}

const SB_CAMPAIGNS = sbV4('campaigns', 'campaign', 'campaignId');
const SB_AD_GROUPS = sbV4('adGroups', 'adgroup', 'adGroupId');
const SB_ADS = sbV4('ads', 'ad', 'adId');

const sbV3 = (
  operation: string,
  method: Endpoint['method'],
  path: string,
  accept: string,
  body: Endpoint['body'],
  read: Endpoint['read'],
): Endpoint => ({
  operation,
  method,
  path,
  contentType: JSON_TYPE,
  accept,
  batchSize: SB_V3_BATCH_SIZE,
  // Anlagen (`POST`) werden nicht wiederholt, sonst entstünden doppelte Negatives.
  idempotent: method === 'PUT',
  body,
  read,
});

const asList = (items: unknown[]) => items;
const KEYWORD_RESPONSE = 'application/vnd.sbkeywordresponse.v3+json';

/** Updates und Archivieren (Zustand `archived`) teilen sich den Endpunkt. */
const SB_KEYWORDS = sbV3(
  'sb.keywords.update',
  'PUT',
  '/sb/keywords',
  KEYWORD_RESPONSE,
  asList,
  orderedReader('keywordId'),
);
const SB_TARGETS = sbV3(
  'sb.targets.update',
  'PUT',
  '/sb/targets',
  'application/vnd.updatetargetsresponse.v3+json',
  (targets) => ({ targets }),
  targetResultsReader('updateTarget'),
);
const SB_NEGATIVE_KEYWORDS_UPDATE = sbV3(
  'sb.negativeKeywords.update',
  'PUT',
  '/sb/negativeKeywords',
  KEYWORD_RESPONSE,
  asList,
  orderedReader('keywordId'),
);
const SB_NEGATIVE_TARGETS_UPDATE = sbV3(
  'sb.negativeTargets.update',
  'PUT',
  '/sb/negativeTargets',
  'application/vnd.updatenegativetargetsresponse.v3+json',
  (negativeTargets) => ({ negativeTargets }),
  targetResultsReader('updateTarget'),
);
const SB_NEGATIVE_KEYWORDS_CREATE = sbV3(
  'sb.negativeKeywords.create',
  'POST',
  '/sb/negativeKeywords',
  KEYWORD_RESPONSE,
  asList,
  orderedReader('keywordId'),
);
const SB_NEGATIVE_TARGETS_CREATE = sbV3(
  'sb.negativeTargets.create',
  'POST',
  '/sb/negativeTargets',
  'application/vnd.sbcreatenegativetargetsrequest.v3+json',
  (negativeTargets) => ({ negativeTargets }),
  targetResultsReader('createTarget'),
);

/** `null`, wenn der Eintrag außer den IDs nichts nennt. */
const changed = (item: Record<string, unknown>, idKeys: number) =>
  Object.keys(item).length > idKeys ? item : null;

function sbUpdate(op: AmazonAdsUpdateOperation): MappedOperation | null {
  const mapped = (endpoint: Endpoint, item: Record<string, unknown> | null) =>
    item && { endpoint, item, amazonId: op.amazonId };
  const state = op.state !== undefined && { state: op.state };
  switch (op.entity) {
    case 'campaign': {
      if (op.bidding !== undefined) {
        notSupported(
          'Gebotsstrategie und Platzierungen lassen sich für Sponsored Brands nicht über ProfitBash ändern.',
        );
      }
      return mapped(
        SB_CAMPAIGNS.update,
        changed(
          {
            campaignId: requireId(op.amazonId),
            ...state,
            ...(op.dailyBudget !== undefined && { budget: jsonDecimal(op.dailyBudget) }),
          },
          1,
        ),
      );
    }
    case 'adGroup': {
      if (op.defaultBid !== undefined) {
        notSupported('Ad Groups von Sponsored Brands haben kein Standardgebot.');
      }
      return mapped(
        SB_AD_GROUPS.update,
        changed({ adGroupId: requireId(op.amazonId), ...state }, 1),
      );
    }
    case 'productAd':
      return mapped(SB_ADS.update, changed({ adId: requireId(op.amazonId), ...state }, 1));
    case 'keyword':
    case 'target': {
      const idKey = op.entity === 'keyword' ? 'keywordId' : 'targetId';
      return mapped(
        op.entity === 'keyword' ? SB_KEYWORDS : SB_TARGETS,
        changed(
          {
            [idKey]: numericId(op.amazonId),
            ...parents(op),
            ...(op.state !== undefined && { state: lower(op.state) }),
            ...(op.bid !== undefined && { bid: jsonDecimal(op.bid) }),
          },
          3,
        ),
      );
    }
  }
}

function sbArchive(op: AmazonAdsArchiveOperation): MappedOperation {
  const amazonId = requireId(op.amazonId);
  const viaFilter = (endpoint: Endpoint) => ({ endpoint, item: amazonId, amazonId });
  const archived = { state: 'archived' };
  switch (op.entity) {
    case 'campaign':
      return viaFilter(SB_CAMPAIGNS.archive);
    case 'adGroup':
      return viaFilter(SB_AD_GROUPS.archive);
    case 'productAd':
      return viaFilter(SB_ADS.archive);
    case 'keyword':
      return {
        endpoint: SB_KEYWORDS,
        item: { keywordId: numericId(amazonId), ...parents(op), ...archived },
        amazonId,
      };
    case 'target':
      return {
        endpoint: SB_TARGETS,
        item: { targetId: numericId(amazonId), ...parents(op), ...archived },
        amazonId,
      };
    case 'negativeKeyword':
      return {
        endpoint: SB_NEGATIVE_KEYWORDS_UPDATE,
        item: { keywordId: numericId(amazonId), ...parents(op), ...archived },
        amazonId,
      };
    case 'negativeTarget':
      return {
        endpoint: SB_NEGATIVE_TARGETS_UPDATE,
        item: { targetId: numericId(amazonId), adGroupId: parents(op).adGroupId, ...archived },
        amazonId,
      };
    case 'campaignNegativeKeyword':
    case 'campaignNegativeTarget':
      return notSupported('Sponsored Brands kennt keine Negatives auf Kampagnenebene.');
  }
}

function sbCreate(op: AmazonAdsCreateNegativeOperation): MappedOperation {
  if (op.amazonAdGroupId === null) {
    return notSupported('Sponsored Brands kennt keine Negatives auf Kampagnenebene.');
  }
  const parent = parents({
    amazonCampaignId: op.amazonCampaignId,
    amazonAdGroupId: op.amazonAdGroupId,
  });
  return op.negative.type === 'keyword'
    ? {
        endpoint: SB_NEGATIVE_KEYWORDS_CREATE,
        amazonId: null,
        item: {
          ...parent,
          keywordText: op.negative.keywordText,
          matchType: op.negative.matchType === 'EXACT' ? 'negativeExact' : 'negativePhrase',
        },
      }
    : {
        endpoint: SB_NEGATIVE_TARGETS_CREATE,
        amazonId: null,
        item: { ...parent, expressions: [{ type: 'asinSameAs', value: op.negative.asin }] },
      };
}

export const SB_DIALECT: WriteDialect = {
  map: (op) =>
    op.type === 'update' ? sbUpdate(op) : op.type === 'archive' ? sbArchive(op) : sbCreate(op),
  order: [
    SB_CAMPAIGNS.update,
    SB_AD_GROUPS.update,
    SB_KEYWORDS,
    SB_TARGETS,
    SB_ADS.update,
    SB_NEGATIVE_KEYWORDS_UPDATE,
    SB_NEGATIVE_TARGETS_UPDATE,
    SB_CAMPAIGNS.archive,
    SB_AD_GROUPS.archive,
    SB_ADS.archive,
    SB_NEGATIVE_KEYWORDS_CREATE,
    SB_NEGATIVE_TARGETS_CREATE,
  ],
};

// ---------------------------------------------------------------------------
// Sponsored Display
// ---------------------------------------------------------------------------

const sd = (path: string, idKey: string, method: Endpoint['method'] = 'PUT'): Endpoint => ({
  operation: `sd.${path}.${method === 'PUT' ? 'update' : 'create'}`,
  method,
  path: `/sd/${path}`,
  contentType: JSON_TYPE,
  accept: JSON_TYPE,
  batchSize: SD_BATCH_SIZE,
  idempotent: method === 'PUT',
  body: asList,
  read: orderedReader(idKey),
});

/** Updates und Archivieren (Zustand `archived`) teilen sich je Entity den Endpunkt. */
const SD_CAMPAIGNS = sd('campaigns', 'campaignId');
const SD_AD_GROUPS = sd('adGroups', 'adGroupId');
const SD_TARGETS = sd('targets', 'targetId');
const SD_PRODUCT_ADS = sd('productAds', 'adId');
const SD_NEGATIVE_TARGETS = sd('negativeTargets', 'targetId');
const SD_NEGATIVE_TARGETS_CREATE = sd('negativeTargets', 'targetId', 'POST');

const SD_ENTITIES = {
  campaign: { endpoint: SD_CAMPAIGNS, idKey: 'campaignId' },
  adGroup: { endpoint: SD_AD_GROUPS, idKey: 'adGroupId' },
  target: { endpoint: SD_TARGETS, idKey: 'targetId' },
  productAd: { endpoint: SD_PRODUCT_ADS, idKey: 'adId' },
  negativeTarget: { endpoint: SD_NEGATIVE_TARGETS, idKey: 'targetId' },
} as const;

const SD_NO_KEYWORDS = 'Sponsored Display kennt keine Keywords.';

function sdUpdate(op: AmazonAdsUpdateOperation): MappedOperation | null {
  if (op.entity === 'keyword') return notSupported(SD_NO_KEYWORDS);
  if (op.entity === 'campaign' && op.bidding !== undefined) {
    return notSupported('Sponsored Display kennt keine Gebotsstrategie und keine Platzierungen.');
  }
  const { endpoint, idKey } = SD_ENTITIES[op.entity];
  const item = changed(
    {
      [idKey]: numericId(op.amazonId),
      ...(op.state !== undefined && { state: lower(op.state) }),
      ...(op.entity === 'campaign' &&
        op.dailyBudget !== undefined && { budget: jsonDecimal(op.dailyBudget) }),
      ...(op.entity === 'adGroup' &&
        op.defaultBid !== undefined && { defaultBid: jsonDecimal(op.defaultBid) }),
      ...(op.entity === 'target' && op.bid !== undefined && { bid: jsonDecimal(op.bid) }),
    },
    1,
  );
  return item && { endpoint, item, amazonId: op.amazonId };
}

function sdArchive(op: AmazonAdsArchiveOperation): MappedOperation {
  if (!(op.entity in SD_ENTITIES)) {
    return notSupported(
      op.entity === 'keyword' || op.entity === 'negativeKeyword'
        ? SD_NO_KEYWORDS
        : 'Sponsored Display kennt keine Negatives auf Kampagnenebene.',
    );
  }
  const { endpoint, idKey } = SD_ENTITIES[op.entity as keyof typeof SD_ENTITIES];
  const amazonId = requireId(op.amazonId);
  return { endpoint, item: { [idKey]: numericId(amazonId), state: 'archived' }, amazonId };
}

function sdCreate(op: AmazonAdsCreateNegativeOperation): MappedOperation {
  if (op.negative.type === 'keyword') return notSupported(SD_NO_KEYWORDS);
  if (op.amazonAdGroupId === null) {
    return notSupported('Sponsored Display kennt keine Negatives auf Kampagnenebene.');
  }
  return {
    endpoint: SD_NEGATIVE_TARGETS_CREATE,
    amazonId: null,
    item: {
      adGroupId: numericId(op.amazonAdGroupId),
      state: 'enabled',
      expressionType: 'manual',
      expression: [{ type: 'asinSameAs', value: op.negative.asin }],
    },
  };
}

export const SD_DIALECT: WriteDialect = {
  map: (op) =>
    op.type === 'update' ? sdUpdate(op) : op.type === 'archive' ? sdArchive(op) : sdCreate(op),
  order: [
    SD_CAMPAIGNS,
    SD_AD_GROUPS,
    SD_TARGETS,
    SD_PRODUCT_ADS,
    SD_NEGATIVE_TARGETS,
    SD_NEGATIVE_TARGETS_CREATE,
  ],
};
