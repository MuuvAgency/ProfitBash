import { comparableSearchTerm, Dec } from '@profitbash/engine';
import {
  AD_CHANGE_PLACEMENTS,
  adChangeFieldKind,
  adChangeValueIssue,
  compareDecimal,
  isAdChangePlacementField,
  type AdChangeCreateNegativeInput,
  type AdChangeEntityType,
  type AdChangeField,
  type AdChangeInput,
  type AdChangeNegative,
  type AdChangeRejection,
} from '@profitbash/shared';
import { and, eq, inArray, isNull, sql, type SQLWrapper } from 'drizzle-orm';
import type { DbOrTx } from './audit';
import {
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsProductAds,
  amazonAdsProfiles,
  amazonAdsTargets,
} from './schema';

/**
 * Gemeinsame Bausteine der Schreibschicht für Änderungen (`ad-changes.ts` für Nutzer, `ad-change-processing.ts`
 * für den Job): Stand der Entities lesen, Werte vergleichen, Negatives prüfen. Nicht aus `index.ts` exportiert.
 *
 * `ProfileScope` begrenzt jede Abfrage auf Profile: für Nutzer die sichtbaren (`visibleProfilesScope()`, ADR 002),
 * für den Job das Profil der Übermittlung.
 */

export interface ProfileScope {
  ids: SQLWrapper | string[];
}

/** Stücke für `IN (…)`-Listen und Mehrfach-Inserts (Parametergrenze von Postgres). */
export const CHUNK = 1000;

export function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

// ---------------------------------------------------------------------------
// Stand der Entities
// ---------------------------------------------------------------------------

export interface EntitySnapshot {
  id: string;
  organizationId: string;
  profileId: string;
  profileCurrency: string;
  campaignId: string;
  adGroupId: string | null;
  adProduct: string;
  state: string | null;
  removedAt: Date | null;
  budgetAmount?: string | null;
  budgetCurrencyCode?: string | null;
  budgetType?: string | null;
  biddingStrategy?: string | null;
  extra?: Record<string, unknown>;
  defaultBid?: string | null;
  defaultBidCurrencyCode?: string | null;
  bid?: string | null;
  bidCurrencyCode?: string | null;
}

const p = amazonAdsProfiles;

/** Entities eines Typs in sichtbaren Profilen, nach interner ID. Unbekannte und unsichtbare fehlen. */
export async function loadEntities(
  db: DbOrTx,
  scope: ProfileScope,
  entityType: AdChangeEntityType,
  entityIds: readonly string[],
): Promise<Map<string, EntitySnapshot>> {
  const found = new Map<string, EntitySnapshot>();
  for (const part of chunks([...new Set(entityIds)])) {
    let rows: EntitySnapshot[];
    if (entityType === 'campaign') {
      const c = amazonAdsCampaigns;
      const selected = await db
        .select({
          id: c.id,
          organizationId: c.organizationId,
          profileId: c.profileId,
          profileCurrency: p.currencyCode,
          adProduct: c.adProduct,
          state: c.state,
          removedAt: c.removedAt,
          budgetAmount: c.budgetAmount,
          budgetCurrencyCode: c.budgetCurrencyCode,
          budgetType: c.budgetType,
          biddingStrategy: c.biddingStrategy,
          extra: c.extra,
        })
        .from(c)
        .innerJoin(p, eq(p.id, c.profileId))
        .where(and(inArray(c.id, part), inArray(c.profileId, scope.ids)));
      rows = selected.map((row) => ({ ...row, campaignId: row.id, adGroupId: null }));
    } else if (entityType === 'ad_group') {
      const g = amazonAdsAdGroups;
      const selected = await db
        .select({
          id: g.id,
          organizationId: g.organizationId,
          profileId: g.profileId,
          profileCurrency: p.currencyCode,
          campaignId: g.campaignId,
          adProduct: g.adProduct,
          state: g.state,
          removedAt: g.removedAt,
          defaultBid: g.defaultBid,
          defaultBidCurrencyCode: g.defaultBidCurrencyCode,
        })
        .from(g)
        .innerJoin(p, eq(p.id, g.profileId))
        .where(and(inArray(g.id, part), inArray(g.profileId, scope.ids)));
      rows = selected.map((row) => ({ ...row, adGroupId: row.id }));
    } else if (entityType === 'target') {
      const t = amazonAdsTargets;
      rows = await db
        .select({
          id: t.id,
          organizationId: t.organizationId,
          profileId: t.profileId,
          profileCurrency: p.currencyCode,
          campaignId: t.campaignId,
          adGroupId: t.adGroupId,
          adProduct: t.adProduct,
          state: t.state,
          removedAt: t.removedAt,
          bid: t.bid,
          bidCurrencyCode: t.bidCurrencyCode,
        })
        .from(t)
        .innerJoin(p, eq(p.id, t.profileId))
        .where(and(inArray(t.id, part), inArray(t.profileId, scope.ids)));
    } else {
      const e = entityType === 'product_ad' ? amazonAdsProductAds : amazonAdsNegativeTargets;
      rows = await db
        .select({
          id: e.id,
          organizationId: e.organizationId,
          profileId: e.profileId,
          profileCurrency: p.currencyCode,
          campaignId: e.campaignId,
          adGroupId: e.adGroupId,
          adProduct: e.adProduct,
          state: e.state,
          removedAt: e.removedAt,
        })
        .from(e)
        .innerJoin(p, eq(p.id, e.profileId))
        .where(and(inArray(e.id, part), inArray(e.profileId, scope.ids)));
    }
    for (const row of rows) found.set(row.id, row);
  }
  return found;
}

const DECIMAL = /^\d+(\.\d+)?$/;

/** Gebotsanpassung einer Platzierung aus `extra.placementBidAdjustments` (`[{ placement, percentage }]`). */
export function placementPercentage(extra: Record<string, unknown> | undefined, placement: string) {
  const adjustments = extra?.placementBidAdjustments;
  if (!Array.isArray(adjustments)) return null;
  for (const entry of adjustments as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { placement: name, percentage } = entry as Record<string, unknown>;
    if (name !== placement) continue;
    const text = typeof percentage === 'number' ? String(percentage) : percentage;
    return typeof text === 'string' && DECIMAL.test(text) ? text : null;
  }
  return null;
}

export const isArchived = (state: string | null) => state?.toUpperCase() === 'ARCHIVED';

export interface CurrentValue {
  value: string | null;
  currencyCode: string | null;
}

/** Stand eines Felds oder der Grund, warum es sich nicht ändern lässt. */
export function currentValue(
  entity: EntitySnapshot | undefined,
  field: AdChangeField,
): CurrentValue | AdChangeRejection {
  if (!entity) return 'notFound';
  if (entity.removedAt !== null) return 'entityRemoved';
  if (isArchived(entity.state)) return 'entityArchived';
  switch (field) {
    case 'state':
      return { value: entity.state, currencyCode: null };
    case 'budget':
      if (entity.budgetType !== 'DAILY') return 'budgetNotDaily';
      return {
        value: entity.budgetAmount ?? null,
        currencyCode: entity.budgetCurrencyCode ?? entity.profileCurrency,
      };
    case 'default_bid':
      return {
        value: entity.defaultBid ?? null,
        currencyCode: entity.defaultBidCurrencyCode ?? entity.profileCurrency,
      };
    case 'bid':
      return {
        value: entity.bid ?? null,
        currencyCode: entity.bidCurrencyCode ?? entity.profileCurrency,
      };
    case 'bidding_strategy':
      if (entity.adProduct !== 'SPONSORED_PRODUCTS') return 'adProductNotSupported';
      return { value: entity.biddingStrategy ?? null, currencyCode: null };
    default:
      if (entity.adProduct !== 'SPONSORED_PRODUCTS') return 'adProductNotSupported';
      return {
        value: placementPercentage(entity.extra, AD_CHANGE_PLACEMENTS[field]),
        currencyCode: null,
      };
  }
}

/**
 * Vergleichswert für die ±50-%-Warnung (F6) je Änderung: Ein Target ohne eigenes Gebot bietet mit dem Standardgebot
 * seiner Ad Group, ein neues Gebot wird deshalb damit verglichen. Nur für Gebote ohne Wert vorher.
 */
export async function loadComparisonBids(
  db: DbOrTx,
  changes: readonly {
    id: string;
    field: string | null;
    before: string | null;
    adGroupId: string | null;
  }[],
): Promise<Map<string, string>> {
  const open = changes.filter(
    (change) => change.field === 'bid' && change.before === null && change.adGroupId !== null,
  );
  const defaultBids = new Map<string, string>();
  for (const part of chunks([...new Set(open.map((change) => change.adGroupId!))])) {
    for (const adGroup of await db
      .select({ id: amazonAdsAdGroups.id, defaultBid: amazonAdsAdGroups.defaultBid })
      .from(amazonAdsAdGroups)
      .where(inArray(amazonAdsAdGroups.id, part))) {
      if (adGroup.defaultBid !== null) defaultBids.set(adGroup.id, adGroup.defaultBid);
    }
  }
  const result = new Map<string, string>();
  for (const change of open) {
    const defaultBid = defaultBids.get(change.adGroupId!);
    if (defaultBid !== undefined) result.set(change.id, defaultBid);
  }
  return result;
}

export type ResolvedAdChangeInput = Exclude<AdChangeInput, { operation: 'adjust' }>;

/**
 * Rechnet Anpassungen (±Prozent, ±Betrag; 3.5) in Feldänderungen um. Ausgangswert ist der Stand der Entity, nie ein
 * schon vorgemerkter Wert (dieselbe Anpassung zweimal ergibt denselben Wert); ein Target ohne eigenes Gebot bietet
 * mit dem Standardgebot seiner Ad Group. Gerundet wird kaufmännisch auf zwei Nachkommastellen. `null` an der Stelle
 * einer abgelehnten Anpassung, der Grund steht in `rejected` (nach Index).
 */
export async function resolveAdjustments(
  db: DbOrTx,
  scope: ProfileScope,
  inputs: readonly AdChangeInput[],
): Promise<{
  changes: (ResolvedAdChangeInput | null)[];
  rejected: Map<number, AdChangeRejection>;
}> {
  const rejected = new Map<number, AdChangeRejection>();
  const idsByType = new Map<AdChangeEntityType, string[]>();
  for (const input of inputs) {
    if (input.operation !== 'adjust') continue;
    const list = idsByType.get(input.entityType) ?? [];
    list.push(input.entityId);
    idsByType.set(input.entityType, list);
  }
  if (idsByType.size === 0) return { changes: inputs as ResolvedAdChangeInput[], rejected };

  const entities = new Map<string, EntitySnapshot>();
  for (const [entityType, entityIds] of idsByType) {
    for (const [id, entity] of await loadEntities(db, scope, entityType, entityIds)) {
      entities.set(`${entityType}:${id}`, entity);
    }
  }
  const adGroupIds = new Set<string>();
  for (const [key, entity] of entities) {
    if (key.startsWith('target:') && entity.bid == null && entity.adGroupId !== null) {
      adGroupIds.add(entity.adGroupId);
    }
  }
  const defaultBids = new Map<string, string>();
  for (const part of chunks([...adGroupIds])) {
    for (const adGroup of await db
      .select({ id: amazonAdsAdGroups.id, defaultBid: amazonAdsAdGroups.defaultBid })
      .from(amazonAdsAdGroups)
      .where(inArray(amazonAdsAdGroups.id, part))) {
      if (adGroup.defaultBid !== null) defaultBids.set(adGroup.id, adGroup.defaultBid);
    }
  }

  const changes = inputs.map((input, index): ResolvedAdChangeInput | null => {
    if (input.operation !== 'adjust') return input;
    const entity = entities.get(`${input.entityType}:${input.entityId}`);
    const current = currentValue(entity, input.field);
    if (typeof current === 'string') {
      rejected.set(index, current);
      return null;
    }
    const base =
      current.value ??
      (input.field === 'bid' && entity!.adGroupId !== null
        ? (defaultBids.get(entity!.adGroupId) ?? null)
        : null);
    if (base === null || !DECIMAL.test(base)) {
      rejected.set(index, 'noCurrentValue');
      return null;
    }
    const start = new Dec(base);
    const result =
      input.mode === 'percent'
        ? start.times(new Dec(input.value).dividedBy(100).plus(1))
        : start.plus(input.value);
    const value = result.toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2);
    if (result.isNegative() || adChangeValueIssue(input.entityType, input.field, value) !== null) {
      rejected.set(index, 'resultOutOfRange');
      return null;
    }
    return {
      operation: 'update',
      entityType: input.entityType,
      entityId: input.entityId,
      field: input.field,
      value,
    };
  });
  return { changes, rejected };
}

/** Gleicher Wert? Beträge als Zahl verglichen (`0.5` = `0.50`); eine fehlende Platzierung gilt als 0 %. */
export function sameValue(field: AdChangeField, a: string | null, b: string): boolean {
  if (adChangeFieldKind(field) === 'enum') return a === b;
  const left = a ?? (isAdChangePlacementField(field) ? '0' : null);
  return left !== null && compareDecimal(left, b) === 0;
}

/** Vorher/nachher in den Spalten der Tabelle: Texte in `*_value`, Zahlen in `*_amount`. */
export function valueColumns(field: AdChangeField, before: string | null, after: string) {
  return adChangeFieldKind(field) === 'enum'
    ? { oldValue: before, newValue: after, oldAmount: null, newAmount: null }
    : { oldValue: null, newValue: null, oldAmount: before, newAmount: after };
}

// ---------------------------------------------------------------------------
// Negatives anlegen
// ---------------------------------------------------------------------------

export const negativeKey = (negative: AdChangeNegative) =>
  negative.type === 'keyword'
    ? `keyword:${negative.matchType}:${comparableSearchTerm(negative.keywordText)}`
    : `product:${negative.asin}`;

/** Schlüssel eines vorhandenen Negatives in derselben Form; `null`, wenn es kein Keyword bzw. keine ASIN ist. */
export function existingNegativeKey(row: {
  targetType: string;
  keywordText: string | null;
  matchType: string | null;
  asin: string | null;
}): string | null {
  if (row.targetType === 'keyword' && row.keywordText !== null && row.matchType !== null) {
    const matchType = row.matchType.toUpperCase().replace(/^NEGATIVE_?/, '');
    return `keyword:${matchType}:${comparableSearchTerm(row.keywordText)}`;
  }
  return row.asin ? `product:${row.asin.toUpperCase()}` : null;
}

export interface NegativeParent {
  organizationId: string;
  profileId: string;
}

/** Prüft Kampagne, Ad Group und vorhandene Negatives; liefert das Profil oder den Grund der Ablehnung. */
export async function checkNegative(
  db: DbOrTx,
  scope: ProfileScope,
  input: Pick<AdChangeCreateNegativeInput, 'campaignId' | 'adGroupId' | 'negative'>,
): Promise<NegativeParent | AdChangeRejection> {
  const campaign = (await loadEntities(db, scope, 'campaign', [input.campaignId])).get(
    input.campaignId,
  );
  if (!campaign) return 'notFound';
  if (campaign.removedAt !== null) return 'entityRemoved';
  if (isArchived(campaign.state)) return 'entityArchived';
  if (input.adGroupId !== null) {
    const adGroup = (await loadEntities(db, scope, 'ad_group', [input.adGroupId])).get(
      input.adGroupId,
    );
    if (!adGroup || adGroup.campaignId !== campaign.id) return 'notFound';
    if (adGroup.removedAt !== null) return 'entityRemoved';
    if (isArchived(adGroup.state)) return 'entityArchived';
  }
  const n = amazonAdsNegativeTargets;
  const existing = await db
    .select({
      targetType: n.targetType,
      keywordText: n.keywordText,
      matchType: n.matchType,
      asin: sql<string | null>`${n.expression}->>'asin'`,
    })
    .from(n)
    .where(
      and(
        eq(n.campaignId, campaign.id),
        input.adGroupId === null ? isNull(n.adGroupId) : eq(n.adGroupId, input.adGroupId),
        eq(n.targetType, input.negative.type),
        isNull(n.removedAt),
        sql`upper(${n.state}) <> 'ARCHIVED'`,
      ),
    );
  const key = negativeKey(input.negative);
  if (existing.some((row) => existingNegativeKey(row) === key)) return 'alreadyExists';
  return { organizationId: campaign.organizationId, profileId: campaign.profileId };
}
