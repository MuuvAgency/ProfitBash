import { and, eq, getTableColumns, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DbOrTx } from './audit';
import {
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsPortfolios,
  amazonAdsProductAds,
  amazonAdsTargets,
} from './schema';

/**
 * Werbe-Entities je Profil schreiben (Phase 1, 1.5). Systemzugriff der Jobs ohne Nutzerkontext und
 * ohne `audit_events` (nachvollziehbar über `job_runs`), an Organisation und Profil gebunden: Die
 * zusammengesetzten FKs lehnen ein Profil einer anderen Organisation ab.
 *
 * Die Upserts nehmen **normalisierte Datensätze** (eigene Typen), nie Antworttypen der Amazon-API.
 * So nutzen Entity-Sync (1.7) und ein späterer Datei-Import (1.11) dieselbe Schreibschicht.
 *
 * Fehlt die Elternebene eines Datensatzes, entsteht sie als Platzhalter (`synced_at` leer), Eltern
 * zuerst. Der Entity-Sync füllt Platzhalter, sobald Amazon die Entity liefert.
 */

export interface EntityScope {
  organizationId: string;
  profileId: string;
}

export interface EntityWriteScope extends EntityScope {
  /** Wird `synced_at`. */
  now: Date;
}

/** Zähler eines Upserts (für `job_runs.counters`). */
export interface EntityUpsertCounts {
  /** Neu angelegt. */
  created: number;
  /** Vorhanden und geändert (auch wieder aufgetaucht); unveränderte zählen nicht. */
  updated: number;
  /** Platzhalter, die dieser Upsert gefüllt hat. */
  placeholdersFilled: number;
  /** Fehlende Eltern, die als Platzhalter entstanden sind. */
  placeholdersCreated: number;
}

interface EntityFields {
  amazonUpdatedAt: Date | null;
  extra: Record<string, unknown>;
}

export interface PortfolioRecord extends EntityFields {
  amazonPortfolioId: string;
  name: string;
  state: string;
  budgetAmount: string | null;
  budgetCurrencyCode: string | null;
  budgetPolicy: string | null;
  budgetStartDate: string | null;
  budgetEndDate: string | null;
  inBudget: boolean | null;
}

export interface CampaignRecord extends EntityFields {
  amazonCampaignId: string;
  amazonPortfolioId: string | null;
  adProduct: string;
  name: string;
  state: string;
  targetingType: string | null;
  budgetAmount: string | null;
  budgetCurrencyCode: string | null;
  budgetType: string | null;
  biddingStrategy: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface AdGroupRecord extends EntityFields {
  amazonAdGroupId: string;
  amazonCampaignId: string;
  adProduct: string;
  name: string;
  state: string;
  defaultBid: string | null;
  defaultBidCurrencyCode: string | null;
}

export interface TargetRecord extends EntityFields {
  amazonTargetId: string;
  amazonCampaignId: string;
  /** `null` bei Targets auf Kampagnenebene. */
  amazonAdGroupId: string | null;
  adProduct: string;
  targetType: string;
  keywordText: string | null;
  matchType: string | null;
  expression: unknown;
  state: string;
  bid: string | null;
  bidCurrencyCode: string | null;
}

export interface NegativeTargetRecord extends EntityFields {
  amazonTargetId: string;
  level: 'campaign' | 'ad_group';
  amazonCampaignId: string;
  amazonAdGroupId: string | null;
  adProduct: string;
  targetType: string;
  keywordText: string | null;
  matchType: string | null;
  expression: unknown;
  state: string;
}

export interface ProductAdRecord extends EntityFields {
  amazonAdId: string;
  amazonCampaignId: string;
  amazonAdGroupId: string;
  adProduct: string;
  asin: string | null;
  sku: string | null;
  state: string;
}

// ---------------------------------------------------------------------------
// Upserts
// ---------------------------------------------------------------------------

export async function upsertPortfolios(
  db: DbOrTx,
  scope: EntityWriteScope,
  records: readonly PortfolioRecord[],
): Promise<EntityUpsertCounts> {
  const rows = lastById(records, (r) => r.amazonPortfolioId).map((record) => ({
    ...record,
    ...rowScope(scope),
  }));
  return upsertRows(db, scope, entityTable(amazonAdsPortfolios, 'amazonPortfolioId'), rows, 0);
}

export async function upsertCampaigns(
  db: DbOrTx,
  scope: EntityWriteScope,
  records: readonly CampaignRecord[],
): Promise<EntityUpsertCounts> {
  const unique = lastById(records, (r) => r.amazonCampaignId);
  const portfolios = await ensurePortfolios(
    db,
    scope,
    unique.flatMap((r) =>
      r.amazonPortfolioId ? [{ amazonPortfolioId: r.amazonPortfolioId }] : [],
    ),
  );
  const rows = unique.map(({ amazonPortfolioId, ...record }) => ({
    ...record,
    ...rowScope(scope),
    portfolioId: amazonPortfolioId ? portfolios.ids.get(amazonPortfolioId)! : null,
  }));
  return upsertRows(
    db,
    scope,
    entityTable(amazonAdsCampaigns, 'amazonCampaignId'),
    rows,
    portfolios.created,
  );
}

export async function upsertAdGroups(
  db: DbOrTx,
  scope: EntityWriteScope,
  records: readonly AdGroupRecord[],
): Promise<EntityUpsertCounts> {
  const unique = lastById(records, (r) => r.amazonAdGroupId);
  const campaigns = await ensureCampaigns(db, scope, unique);
  const rows = unique.map(({ amazonCampaignId, ...record }) => ({
    ...record,
    ...rowScope(scope),
    campaignId: campaigns.ids.get(amazonCampaignId)!,
  }));
  return upsertRows(
    db,
    scope,
    entityTable(amazonAdsAdGroups, 'amazonAdGroupId'),
    rows,
    campaigns.created,
  );
}

export async function upsertTargets(
  db: DbOrTx,
  scope: EntityWriteScope,
  records: readonly TargetRecord[],
): Promise<EntityUpsertCounts> {
  const unique = lastById(records, (r) => r.amazonTargetId);
  const parents = await ensureParents(db, scope, unique);
  const rows = unique.map(({ amazonCampaignId, amazonAdGroupId, ...record }) => ({
    ...record,
    ...rowScope(scope),
    campaignId: parents.campaigns.get(amazonCampaignId)!,
    adGroupId: amazonAdGroupId === null ? null : parents.adGroups.get(amazonAdGroupId)!,
  }));
  return upsertRows(
    db,
    scope,
    entityTable(amazonAdsTargets, 'amazonTargetId'),
    rows,
    parents.created,
  );
}

export async function upsertNegativeTargets(
  db: DbOrTx,
  scope: EntityWriteScope,
  records: readonly NegativeTargetRecord[],
): Promise<EntityUpsertCounts> {
  const unique = lastById(records, (r) => r.amazonTargetId);
  const parents = await ensureParents(db, scope, unique);
  const rows = unique.map(({ amazonCampaignId, amazonAdGroupId, ...record }) => ({
    ...record,
    ...rowScope(scope),
    campaignId: parents.campaigns.get(amazonCampaignId)!,
    adGroupId: amazonAdGroupId === null ? null : parents.adGroups.get(amazonAdGroupId)!,
  }));
  return upsertRows(
    db,
    scope,
    entityTable(amazonAdsNegativeTargets, 'amazonTargetId'),
    rows,
    parents.created,
  );
}

export async function upsertProductAds(
  db: DbOrTx,
  scope: EntityWriteScope,
  records: readonly ProductAdRecord[],
): Promise<EntityUpsertCounts> {
  const unique = lastById(records, (r) => r.amazonAdId);
  const parents = await ensureParents(db, scope, unique);
  const rows = unique.map(({ amazonCampaignId, amazonAdGroupId, ...record }) => ({
    ...record,
    ...rowScope(scope),
    campaignId: parents.campaigns.get(amazonCampaignId)!,
    adGroupId: parents.adGroups.get(amazonAdGroupId)!,
  }));
  return upsertRows(
    db,
    scope,
    entityTable(amazonAdsProductAds, 'amazonAdId'),
    rows,
    parents.created,
  );
}

// ---------------------------------------------------------------------------
// Platzhalter (auch für den Report-Import, `amazon-ads-metrics.ts`)
// ---------------------------------------------------------------------------

/** Interne IDs je Amazon-ID und Zahl der neu angelegten Platzhalter (inkl. Eltern). */
export interface EnsuredEntities {
  ids: Map<string, string>;
  created: number;
}

export async function ensurePortfolios(
  db: DbOrTx,
  scope: EntityScope,
  refs: ReadonlyArray<{ amazonPortfolioId: string }>,
): Promise<EnsuredEntities> {
  const rows = firstById(refs, (r) => r.amazonPortfolioId).map((ref) => ({
    ...rowScope(scope),
    amazonPortfolioId: ref.amazonPortfolioId,
  }));
  return ensureRows(db, scope, entityTable(amazonAdsPortfolios, 'amazonPortfolioId'), rows);
}

export interface CampaignRef {
  amazonCampaignId: string;
  adProduct: string;
  /** Vorbelegung des Namens aus einer Report-Spalte. */
  campaignName?: string | null;
}

export async function ensureCampaigns(
  db: DbOrTx,
  scope: EntityScope,
  refs: readonly CampaignRef[],
): Promise<EnsuredEntities> {
  const rows = firstById(refs, (r) => r.amazonCampaignId).map((ref) => ({
    ...rowScope(scope),
    amazonCampaignId: ref.amazonCampaignId,
    adProduct: ref.adProduct,
    name: ref.campaignName ?? null,
  }));
  return ensureRows(db, scope, entityTable(amazonAdsCampaigns, 'amazonCampaignId'), rows);
}

export interface AdGroupRef extends CampaignRef {
  amazonAdGroupId: string;
  adGroupName?: string | null;
}

/** Ad Groups samt ihrer Kampagnen. `ids` enthält nur die Ad Groups. */
export async function ensureAdGroups(
  db: DbOrTx,
  scope: EntityScope,
  refs: readonly AdGroupRef[],
): Promise<EnsuredEntities & { campaigns: Map<string, string> }> {
  const campaigns = await ensureCampaigns(db, scope, refs);
  const rows = firstById(refs, (r) => r.amazonAdGroupId).map((ref) => ({
    ...rowScope(scope),
    campaignId: campaigns.ids.get(ref.amazonCampaignId)!,
    amazonAdGroupId: ref.amazonAdGroupId,
    adProduct: ref.adProduct,
    name: ref.adGroupName ?? null,
  }));
  const adGroups = await ensureRows(
    db,
    scope,
    entityTable(amazonAdsAdGroups, 'amazonAdGroupId'),
    rows,
  );
  return {
    ids: adGroups.ids,
    campaigns: campaigns.ids,
    created: campaigns.created + adGroups.created,
  };
}

export interface TargetRef extends CampaignRef {
  amazonTargetId: string;
  amazonAdGroupId: string | null;
  adGroupName?: string | null;
}

export async function ensureTargets(
  db: DbOrTx,
  scope: EntityScope,
  refs: readonly TargetRef[],
): Promise<EnsuredEntities> {
  const parents = await ensureParents(db, scope, refs);
  const rows = firstById(refs, (r) => r.amazonTargetId).map((ref) => ({
    ...rowScope(scope),
    campaignId: parents.campaigns.get(ref.amazonCampaignId)!,
    adGroupId: ref.amazonAdGroupId === null ? null : parents.adGroups.get(ref.amazonAdGroupId)!,
    amazonTargetId: ref.amazonTargetId,
    adProduct: ref.adProduct,
  }));
  const targets = await ensureRows(
    db,
    scope,
    entityTable(amazonAdsTargets, 'amazonTargetId'),
    rows,
  );
  return { ids: targets.ids, created: parents.created + targets.created };
}

export interface ProductAdRef extends AdGroupRef {
  amazonAdId: string;
  asin?: string | null;
  sku?: string | null;
}

export async function ensureProductAds(
  db: DbOrTx,
  scope: EntityScope,
  refs: readonly ProductAdRef[],
): Promise<EnsuredEntities> {
  const parents = await ensureParents(db, scope, refs);
  const rows = firstById(refs, (r) => r.amazonAdId).map((ref) => ({
    ...rowScope(scope),
    campaignId: parents.campaigns.get(ref.amazonCampaignId)!,
    adGroupId: parents.adGroups.get(ref.amazonAdGroupId)!,
    amazonAdId: ref.amazonAdId,
    adProduct: ref.adProduct,
    asin: ref.asin ?? null,
    sku: ref.sku ?? null,
  }));
  const ads = await ensureRows(db, scope, entityTable(amazonAdsProductAds, 'amazonAdId'), rows);
  return { ids: ads.ids, created: parents.created + ads.created };
}

// ---------------------------------------------------------------------------
// Intern
// ---------------------------------------------------------------------------

/** Parameter je Anweisung bleiben so weit unter Postgres' Grenze (65 535). */
const CHUNK_SIZE = 1000;

type EntityTable =
  | typeof amazonAdsPortfolios
  | typeof amazonAdsCampaigns
  | typeof amazonAdsAdGroups
  | typeof amazonAdsTargets
  | typeof amazonAdsNegativeTargets
  | typeof amazonAdsProductAds;

type AmazonIdKey =
  'amazonPortfolioId' | 'amazonCampaignId' | 'amazonAdGroupId' | 'amazonTargetId' | 'amazonAdId';

/** Spalten, die ein Upsert nie aus dem Datensatz übernimmt (Schlüssel und Verwaltung). */
const MANAGED_COLUMNS = new Set([
  'id',
  'organizationId',
  'profileId',
  'syncedAt',
  'removedAt',
  'createdAt',
  'updatedAt',
]);

/**
 * Schmale Sicht auf eine Entity-Tabelle für die gemeinsamen Upserts. Drizzles Typen tragen eine Union
 * von Tabellen nicht durch `insert`/`select`; typisiert sind deshalb die Zeilen (`Row`), die Tabelle
 * selbst läuft als `PgTable` mit den Verwaltungsspalten, die alle Entity-Tabellen haben.
 */
interface EntityTableView<Row> {
  table: PgTable;
  id: PgColumn;
  profileId: PgColumn;
  syncedAt: PgColumn;
  removedAt: PgColumn;
  amazonId: PgColumn;
  amazonIdOf: (row: Row) => string;
  /** Daten-Spalten (Schlüssel im Datensatz → Spalte), die ein Upsert übernimmt. */
  dataColumns: Array<[string, PgColumn]>;
}

function entityTable<T extends EntityTable, K extends AmazonIdKey & keyof T['$inferInsert']>(
  table: T,
  amazonIdKey: K,
): EntityTableView<T['$inferInsert'] & Record<K, string>> {
  const columns: Record<string, PgColumn> = getTableColumns(table);
  return {
    table,
    id: table.id,
    profileId: table.profileId,
    syncedAt: table.syncedAt,
    removedAt: table.removedAt,
    amazonId: columns[amazonIdKey]!,
    amazonIdOf: (row) => row[amazonIdKey],
    dataColumns: Object.entries(columns).filter(
      ([key]) => !MANAGED_COLUMNS.has(key) && key !== amazonIdKey,
    ),
  };
}

type InsertRow = PgTable['$inferInsert'];

/**
 * Upsert über (`profile_id`, Amazon-ID). Geändert wird nur, was sich unterscheidet (oder ein Platzhalter
 * bzw. entfernt war); bei allen gelieferten Entities wird `synced_at` gesetzt und `removed_at` gelöscht.
 */
async function upsertRows<Row extends object>(
  db: DbOrTx,
  scope: EntityWriteScope,
  view: EntityTableView<Row>,
  rows: readonly Row[],
  placeholdersCreated: number,
): Promise<EntityUpsertCounts> {
  const counts: EntityUpsertCounts = {
    created: 0,
    updated: 0,
    placeholdersFilled: 0,
    placeholdersCreated,
  };
  const excluded = (column: PgColumn) => sql.raw(`excluded."${column.name}"`);
  const set: Record<string, unknown> = {
    ...Object.fromEntries(view.dataColumns.map(([key, column]) => [key, excluded(column)])),
    syncedAt: scope.now,
    removedAt: null,
    updatedAt: scope.now,
  };
  const changed: SQL = sql`(${sql.join(
    view.dataColumns.map(([, column]) => sql`${column}`),
    sql`, `,
  )}) is distinct from (${sql.join(
    view.dataColumns.map(([, column]) => excluded(column)),
    sql`, `,
  )}) or ${view.syncedAt} is null or ${view.removedAt} is not null`;

  for (const chunk of chunks(rows)) {
    const ids = chunk.map(view.amazonIdOf);
    const inChunk = and(eq(view.profileId, scope.profileId), inArray(view.amazonId, ids));
    const placeholders = await db
      .select({ id: view.id })
      .from(view.table)
      .where(and(inChunk, isNull(view.syncedAt)));
    const written = await db
      .insert(view.table)
      .values(chunk.map((row): InsertRow => ({ ...row, syncedAt: scope.now, removedAt: null })))
      .onConflictDoUpdate({ target: [view.profileId, view.amazonId], set, setWhere: changed })
      // xmax = 0 nur bei frisch eingefügten Zeilen (Postgres-Systemspalte).
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    // Unveränderte Entities: nur bestätigen.
    await db
      .update(view.table)
      .set({ syncedAt: scope.now })
      .where(and(inChunk, or(isNull(view.syncedAt), ne(view.syncedAt, scope.now))));

    const created = written.filter((row) => row.inserted).length;
    counts.created += created;
    counts.placeholdersFilled += placeholders.length;
    counts.updated += written.length - created - placeholders.length;
  }
  return counts;
}

/** Legt fehlende Entities als Platzhalter an (vorhandene bleiben unberührt) und liefert alle IDs. */
async function ensureRows<Row extends object>(
  db: DbOrTx,
  scope: EntityScope,
  view: EntityTableView<Row>,
  rows: readonly Row[],
): Promise<EnsuredEntities> {
  const result: EnsuredEntities = { ids: new Map(), created: 0 };
  for (const chunk of chunks(rows)) {
    const created = await db
      .insert(view.table)
      .values(chunk.map((row): InsertRow => ({ ...row })))
      .onConflictDoNothing({ target: [view.profileId, view.amazonId] })
      .returning({ id: view.id });
    result.created += created.length;
    const found = await db
      .select({ id: view.id, amazonId: view.amazonId })
      .from(view.table)
      .where(
        and(
          eq(view.profileId, scope.profileId),
          inArray(view.amazonId, chunk.map(view.amazonIdOf)),
        ),
      );
    for (const row of found) result.ids.set(String(row.amazonId), String(row.id));
  }
  return result;
}

const rowScope = (scope: EntityScope) => ({
  organizationId: scope.organizationId,
  profileId: scope.profileId,
});

/** Kampagnen und (falls angegeben) Ad Groups als Platzhalter sicherstellen, Eltern zuerst. */
async function ensureParents(
  db: DbOrTx,
  scope: EntityScope,
  refs: ReadonlyArray<
    CampaignRef & { amazonAdGroupId: string | null; adGroupName?: string | null }
  >,
): Promise<{ campaigns: Map<string, string>; adGroups: Map<string, string>; created: number }> {
  const adGroupRefs = refs.flatMap((ref) =>
    ref.amazonAdGroupId === null ? [] : [{ ...ref, amazonAdGroupId: ref.amazonAdGroupId }],
  );
  const adGroups = await ensureAdGroups(db, scope, adGroupRefs);
  const campaigns = await ensureCampaigns(db, scope, refs);
  return {
    campaigns: campaigns.ids,
    adGroups: adGroups.ids,
    created: adGroups.created + campaigns.created,
  };
}

function* chunks<T>(items: readonly T[]): Generator<T[]> {
  for (let i = 0; i < items.length; i += CHUNK_SIZE) yield items.slice(i, i + CHUNK_SIZE);
}

/** Je Amazon-ID der letzte Datensatz (doppelte IDs in einer Lieferung: der spätere gilt). */
function lastById<T>(records: readonly T[], idOf: (record: T) => string): T[] {
  return [...new Map(records.map((record) => [idOf(record), record])).values()];
}

/** Je Amazon-ID der erste Verweis. */
function firstById<T>(refs: readonly T[], idOf: (ref: T) => string): T[] {
  const byId = new Map<string, T>();
  for (const ref of refs) if (!byId.has(idOf(ref))) byId.set(idOf(ref), ref);
  return [...byId.values()];
}
