import { and, between, eq, getTableColumns, getTableName, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  assertProfileInOrganization,
  ensureAdGroups,
  ensureCampaigns,
  ensureProductAds,
  ensureTargets,
  ProfileNotFoundError,
  type EnsuredEntities,
  type EntityScope,
} from './amazon-ads-entities';
import type { DbOrTx } from './audit';
import {
  amazonAdsAdGroupDailyMetrics,
  amazonAdsCampaignDailyMetrics,
  amazonAdsCampaigns,
  amazonAdsProductAdDailyMetrics,
  amazonAdsProfileMetricsImportedThrough,
  amazonAdsProfiles,
  amazonAdsSearchTermDailyMetrics,
  amazonAdsTargetDailyMetrics,
} from './schema';

/**
 * Tageskennzahlen aus Reports schreiben (Phase 1, 1.5). Systemzugriff der Jobs ohne Nutzerkontext und
 * ohne `audit_events`, an Organisation und Profil gebunden. Nimmt normalisierte Zeilen (eigene Typen),
 * nie Antworttypen der Amazon-API.
 *
 * Amazon liefert nur Tage mit Aktivität; fehlende Zeilen bedeuten 0. Ein Import ersetzt deshalb genau
 * den Ausschnitt (Profil, Ad-Typ, Tabelle, übergebene Tage): Upsert der gelieferten Zeilen, Löschen der
 * übrigen. Die Tage (`ranges`) sind die, die kein später angeforderter Report schon abdeckt (1.4);
 * Zeilen außerhalb werden übersprungen.
 */

/** Ganze Tage, beide Grenzen eingeschlossen (`YYYY-MM-DD`). */
export interface MetricsDateRange {
  startDate: string;
  endDate: string;
}

/**
 * Import abgelehnt, weil er Daten verlieren oder verfälschen würde (0 Zeilen für einen Ausschnitt, der
 * schon Kennzahlen hat; nur ungültige Zeilen; doppelte oder unvollständige Zeilen). Eine Wiederholung mit
 * derselben Datei ändert nichts; die Zustandsmaschine lässt den Auftrag deshalb sofort scheitern.
 */
export class MetricsImportRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricsImportRejectedError';
  }
}

export interface DailyMetricValues {
  impressions: number;
  clicks: number;
  /** Beträge als Decimal-String in der Währung des Profils. */
  cost: string;
  /** Attribution (F7). SB/SD: nur `*14d`, `*7d` bleibt `null`. */
  sales7d: string | null;
  sales14d: string | null;
  salesSameSku7d: string | null;
  salesSameSku14d: string | null;
  purchases7d: number | null;
  purchases14d: number | null;
  purchasesSameSku7d: number | null;
  purchasesSameSku14d: number | null;
  units7d: number | null;
  units14d: number | null;
  unitsSameSku7d: number | null;
  unitsSameSku14d: number | null;
  /** Nur Klicks (SB/SD, 14 Tage); `*14d` zählt dort Klicks und Views. SP: `null` (nur klick-basiert). */
  salesClicks14d: string | null;
  purchasesClicks14d: number | null;
  unitsClicks14d: number | null;
  /** Sichtbare Impressionen nach MRC (nur SD, Basis für vCPM). SP/SB: `null`. */
  viewableImpressions: number | null;
  /** Weitere Report-Spalten ohne eigene Spalte. */
  extra: Record<string, unknown>;
}

interface MetricRowBase extends DailyMetricValues {
  /** Tag in der Zeitzone des Profils (`YYYY-MM-DD`). */
  date: string;
  amazonCampaignId: string;
  /** Vorbelegung des Namens, falls die Kampagne als Platzhalter entsteht. */
  campaignName?: string | null;
}

export type CampaignDailyMetric = MetricRowBase;

export interface AdGroupDailyMetric extends MetricRowBase {
  amazonAdGroupId: string;
  adGroupName?: string | null;
}

export interface TargetDailyMetric extends MetricRowBase {
  /** `null` bei Targets auf Kampagnenebene. */
  amazonAdGroupId: string | null;
  adGroupName?: string | null;
  amazonTargetId: string;
}

export interface ProductAdDailyMetric extends MetricRowBase {
  amazonAdGroupId: string;
  adGroupName?: string | null;
  amazonAdId: string;
  asin?: string | null;
  sku?: string | null;
}

export interface SearchTermDailyMetric extends TargetDailyMetric {
  searchTerm: string;
}

export type DailyMetricsRows =
  | { level: 'campaign'; rows: readonly CampaignDailyMetric[] }
  | { level: 'adGroup'; rows: readonly AdGroupDailyMetric[] }
  | { level: 'target'; rows: readonly TargetDailyMetric[] }
  | { level: 'productAd'; rows: readonly ProductAdDailyMetric[] }
  | { level: 'searchTerm'; rows: readonly SearchTermDailyMetric[] };

export type DailyMetricsLevel = DailyMetricsRows['level'];

export type ReplaceDailyMetricsInput = {
  organizationId: string;
  profileId: string;
  /** Ad-Typ des Reports (`SPONSORED_PRODUCTS` …); gilt für alle Zeilen. */
  adProduct: string;
  /** Tage, die dieser Import ersetzt. */
  ranges: readonly MetricsDateRange[];
  /** Ungültige Zeilen der Datei: dann wird nichts gelöscht (kein stiller Datenverlust). */
  invalidRowCount: number;
  /** Wird `imported_at`. */
  now: Date;
} & DailyMetricsRows;

export interface ReplaceDailyMetricsResult {
  /** Geschriebene Zeilen. */
  rows: number;
  /** Zeilen außerhalb der übergebenen Tage. */
  skipped: number;
  /** Gelöschte Zeilen im Ausschnitt. */
  deleted: number;
  /** Als Platzhalter angelegte Entities (inkl. Eltern). */
  placeholdersCreated: number;
}

/**
 * Merkt „Daten bis“ je Profil und Ad-Typ (1.8, je Ad-Typ seit 1.9): der letzte Tag eines importierten
 * Kampagnen-Reports. Rückt nur vor (`greatest`), damit ein später importiertes Stück der Historie das
 * Datum nicht zurücksetzt. Das Profil selbst (auch `updated_at`) bleibt unverändert.
 */
export async function markMetricsImportedThrough(
  db: DbOrTx,
  input: { organizationId: string; profileId: string; adProduct: string; date: string },
): Promise<void> {
  const marks = amazonAdsProfileMetricsImportedThrough;
  // Aus dem Profil derselben Organisation gewählt: Ein fremdes Profil ergibt keine Zeile.
  const inserted = await db
    .insert(marks)
    .select(
      db
        .select({
          organizationId: amazonAdsProfiles.organizationId,
          profileId: amazonAdsProfiles.id,
          adProduct: sql`${input.adProduct}::text`.as('ad_product'),
          importedThrough: sql`${input.date}::date`.as('imported_through'),
        })
        .from(amazonAdsProfiles)
        .where(
          and(
            eq(amazonAdsProfiles.id, input.profileId),
            eq(amazonAdsProfiles.organizationId, input.organizationId),
          ),
        ),
    )
    .onConflictDoUpdate({
      target: [marks.profileId, marks.adProduct],
      set: { importedThrough: sql`greatest(${marks.importedThrough}, excluded.imported_through)` },
    })
    .returning({ profileId: marks.profileId });
  if (inserted.length === 0) throw new ProfileNotFoundError();
}

/**
 * Welche Ad-Typen der Sync für ein Profil anfordert (1.9): `always` für jedes Profil, `withCampaigns` nur,
 * wenn das Profil mindestens eine Kampagne dieses Ad-Typs hat (aus dem Entity-Sync, auch archivierte,
 * entfernte und Platzhalter). So bleiben Ad-Typen, die ein Profil nicht nutzt, aus Sync und „Daten bis“.
 */
export interface ReportAdProductSelection {
  always: readonly string[];
  withCampaigns: readonly string[];
}

/** Spalte über einen Alias, qualifiziert (in `select`-Feldern rendert Drizzle Spalten sonst ohne Tabelle). */
const aliased = (alias: string, column: PgColumn) =>
  sql`${sql.identifier(alias)}.${sql.identifier(column.name)}`;

/**
 * Die Ad-Typen aus `adProducts`, für die das Profil (`profileId`: Wert oder Spalte) mindestens eine
 * Kampagne hat. `exists` hält bei der ersten passenden Kampagne an.
 */
function adProductsWithCampaignsSql(adProducts: readonly string[], profileId: SQL | string): SQL {
  const campaign = 'campaign';
  return sql`select used.ad_product from unnest(${sql.param([...adProducts])}::text[]) as used(ad_product)
    where exists (
      select 1 from ${amazonAdsCampaigns} as ${sql.identifier(campaign)}
      where ${aliased(campaign, amazonAdsCampaigns.profileId)} = ${profileId}
        and ${aliased(campaign, amazonAdsCampaigns.adProduct)} = used.ad_product
    )`;
}

/** Die Ad-Typen eines Profils nach `selection`, in deren Reihenfolge (`always` zuerst). */
export async function selectReportAdProducts(
  db: DbOrTx,
  scope: EntityScope,
  selection: ReportAdProductSelection,
): Promise<string[]> {
  await assertProfileInOrganization(db, scope);
  const optional = selection.withCampaigns.filter((p) => !selection.always.includes(p));
  const used =
    optional.length === 0
      ? []
      : await db.execute<{ ad_product: string }>(
          adProductsWithCampaignsSql(optional, scope.profileId),
        );
  const usedSet = new Set(used.map((row) => row.ad_product));
  return [...new Set([...selection.always, ...optional.filter((p) => usedSet.has(p))])];
}

/**
 * „Daten bis“ eines Profils für ein `select` über `amazon_ads_profiles`: das Minimum über die Ad-Typen,
 * die der Sync für das Profil anfordert (wie `selectReportAdProducts`), leer, solange einem davon ein Tag
 * fehlt. So bremst ein hängender Ad-Typ die Anzeige, statt hinter dem Stand der anderen zu verschwinden;
 * ein Ad-Typ, den das Profil nicht nutzt, bremst nicht.
 */
export function metricsImportedThroughSql(selection: ReportAdProductSelection): SQL<string | null> {
  const always = [...new Set(selection.always)];
  const withCampaigns = [...new Set(selection.withCampaigns)];
  if (always.length === 0 && withCampaigns.length === 0) return sql<null>`null::text`;
  const marks = amazonAdsProfileMetricsImportedThrough;
  const mark = 'mark';
  const importedThrough = aliased(mark, marks.importedThrough);
  // Ausdrücklich qualifiziert: `"id"` träfe in den Unterabfragen sonst nicht das Profil.
  const profileId = aliased(getTableName(amazonAdsProfiles), amazonAdsProfiles.id);
  // Als Text (`YYYY-MM-DD`, unabhängig von `DateStyle`): Ein Tag ohne Uhrzeit, keine Umrechnung durch den Treiber.
  return sql<string | null>`(
    select case when count(*) > 0 and count(*) = count(${importedThrough})
      then to_char(min(${importedThrough}), 'YYYY-MM-DD') end
    from (
      select unnest(${sql.param(always)}::text[]) as ad_product
      union
      ${adProductsWithCampaignsSql(withCampaigns, profileId)}
    ) as selected
    left join ${marks} as ${sql.identifier(mark)}
      on ${aliased(mark, marks.profileId)} = ${profileId}
        and ${aliased(mark, marks.adProduct)} = selected.ad_product
  )`;
}

/**
 * Ersetzt die Kennzahlen einer Ebene in den übergebenen Tagen (eigene Transaktion bzw. Savepoint in der
 * des Aufrufers). Fehlende Entities entstehen als Platzhalter, Eltern zuerst.
 *
 * - Ungültige Zeilen in der Datei (`invalidRowCount > 0`): nur Upsert, kein Löschen.
 * - 0 Zeilen in den Tagen, obwohl der Ausschnitt Kennzahlen hat: `MetricsImportRejectedError`.
 * - Doppelte Zeilen (gleicher Tag und gleiche Entity bzw. gleicher Suchbegriff): Fehler.
 */
export async function replaceDailyMetrics(
  db: DbOrTx,
  input: ReplaceDailyMetricsInput,
): Promise<ReplaceDailyMetricsResult> {
  return db.transaction(async (tx) => {
    const [profile] = await tx
      .select({ currencyCode: amazonAdsProfiles.currencyCode })
      .from(amazonAdsProfiles)
      .where(
        and(
          eq(amazonAdsProfiles.id, input.profileId),
          eq(amazonAdsProfiles.organizationId, input.organizationId),
        ),
      );
    if (!profile) throw new ProfileNotFoundError();
    if (input.rows.length === 0 && input.invalidRowCount > 0) {
      // Sonst endete ein falsches Zeilen-Schema (1.6) als „importiert“ ohne Daten.
      throw new MetricsImportRejectedError('Der Report enthält nur ungültige Zeilen.');
    }

    const level = LEVELS[input.level];
    const rows = (input.rows as readonly MetricRow[]).filter((row) =>
      input.ranges.some((range) => row.date >= range.startDate && row.date <= range.endDate),
    );
    const result: ReplaceDailyMetricsResult = {
      rows: 0,
      skipped: input.rows.length - rows.length,
      deleted: 0,
      placeholdersCreated: 0,
    };
    if (input.ranges.length === 0) return result;
    assertNoDuplicates(input.level, rows, level.keyOf);

    const slice = and(
      eq(level.view.profileId, input.profileId),
      eq(level.view.adProduct, input.adProduct),
      or(...input.ranges.map((range) => between(level.view.date, range.startDate, range.endDate))),
    );

    if (rows.length === 0) {
      if (input.invalidRowCount === 0 && (await hasRows(tx, level.view, slice))) {
        throw new MetricsImportRejectedError(
          'Der Report enthält für Tage mit vorhandenen Kennzahlen keine Zeilen; die vorhandenen Kennzahlen bleiben erhalten.',
        );
      }
      return result;
    }

    const scope: EntityScope = { organizationId: input.organizationId, profileId: input.profileId };
    const entities = await level.ensure(tx, scope, input.adProduct, rows);
    result.placeholdersCreated = entities.created;

    const written: string[] = [];
    for (const chunk of chunks(rows)) {
      const inserted = await tx
        .insert(level.view.table)
        .values(
          chunk.map((row): InsertRow => ({
            ...metricValues(row),
            organizationId: input.organizationId,
            profileId: input.profileId,
            date: row.date,
            adProduct: input.adProduct,
            currencyCode: profile.currencyCode,
            importedAt: input.now,
            [level.entityKey]: entities.ids.get(level.amazonIdOf(row))!,
            ...level.extraKey(row),
          })),
        )
        .onConflictDoUpdate({ target: level.view.conflictTarget, set: level.view.set })
        .returning({ id: level.view.id });
      written.push(...inserted.map((row) => String(row.id)));
    }
    result.rows = written.length;

    if (input.invalidRowCount === 0) {
      const deleted = await tx
        .delete(level.view.table)
        .where(and(slice, sql`${level.view.id} <> all(${sql.param(written)}::uuid[])`))
        .returning({ id: level.view.id });
      result.deleted = deleted.length;
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// Intern
// ---------------------------------------------------------------------------

/** Parameter je Anweisung bleiben so weit unter Postgres' Grenze (65 535). */
const CHUNK_SIZE = 1000;

type MetricRow = MetricRowBase &
  Partial<
    Pick<SearchTermDailyMetric, 'amazonTargetId' | 'searchTerm'> &
      Pick<ProductAdDailyMetric, 'amazonAdId' | 'asin' | 'sku'>
  > & { amazonAdGroupId?: string | null; adGroupName?: string | null };

type InsertRow = PgTable['$inferInsert'];

type MetricsTable =
  | typeof amazonAdsCampaignDailyMetrics
  | typeof amazonAdsAdGroupDailyMetrics
  | typeof amazonAdsTargetDailyMetrics
  | typeof amazonAdsProductAdDailyMetrics
  | typeof amazonAdsSearchTermDailyMetrics;

/**
 * Schmale Sicht auf eine Kennzahl-Tabelle (Drizzles Typen tragen eine Union von Tabellen nicht durch
 * `insert`/`delete`).
 */
interface MetricsTableView {
  table: PgTable;
  id: PgColumn;
  profileId: PgColumn;
  adProduct: PgColumn;
  date: PgColumn;
  conflictTarget: PgColumn[];
  /** Kennzahlen, Währung und `imported_at` aus der neuen Zeile übernehmen. */
  set: Record<string, SQL>;
}

const METRIC_VALUE_KEYS = [
  'currencyCode',
  'impressions',
  'clicks',
  'cost',
  'sales7d',
  'sales14d',
  'salesSameSku7d',
  'salesSameSku14d',
  'purchases7d',
  'purchases14d',
  'purchasesSameSku7d',
  'purchasesSameSku14d',
  'units7d',
  'units14d',
  'unitsSameSku7d',
  'unitsSameSku14d',
  'salesClicks14d',
  'purchasesClicks14d',
  'unitsClicks14d',
  'viewableImpressions',
  'extra',
  'importedAt',
] as const;

function metricsTable(table: MetricsTable, conflictTarget: PgColumn[]): MetricsTableView {
  const columns: Record<string, PgColumn> = getTableColumns(table);
  return {
    table,
    id: table.id,
    profileId: table.profileId,
    adProduct: table.adProduct,
    date: table.date,
    conflictTarget,
    set: Object.fromEntries(
      METRIC_VALUE_KEYS.map((key) => [key, sql.raw(`excluded."${columns[key]!.name}"`)]),
    ),
  };
}

function metricValues(row: DailyMetricValues): DailyMetricValues {
  return {
    impressions: row.impressions,
    clicks: row.clicks,
    cost: row.cost,
    sales7d: row.sales7d,
    sales14d: row.sales14d,
    salesSameSku7d: row.salesSameSku7d,
    salesSameSku14d: row.salesSameSku14d,
    purchases7d: row.purchases7d,
    purchases14d: row.purchases14d,
    purchasesSameSku7d: row.purchasesSameSku7d,
    purchasesSameSku14d: row.purchasesSameSku14d,
    units7d: row.units7d,
    units14d: row.units14d,
    unitsSameSku7d: row.unitsSameSku7d,
    unitsSameSku14d: row.unitsSameSku14d,
    salesClicks14d: row.salesClicks14d,
    purchasesClicks14d: row.purchasesClicks14d,
    unitsClicks14d: row.unitsClicks14d,
    viewableImpressions: row.viewableImpressions,
    extra: row.extra,
  };
}

interface LevelConfig {
  view: MetricsTableView;
  /** Spalte mit der internen Entity-ID. */
  entityKey: string;
  amazonIdOf: (row: MetricRow) => string;
  /** Upsert-Schlüssel ohne Profil (für die Prüfung auf doppelte Zeilen). */
  keyOf: (row: MetricRow) => string;
  extraKey: (row: MetricRow) => Record<string, unknown>;
  ensure: (
    db: DbOrTx,
    scope: EntityScope,
    adProduct: string,
    rows: readonly MetricRow[],
  ) => Promise<EnsuredEntities>;
}

const required = (value: string | null | undefined, name: string): string => {
  if (value == null) throw new MetricsImportRejectedError(`Kennzahl-Zeile ohne ${name}.`);
  return value;
};

const targetRefs = (adProduct: string, rows: readonly MetricRow[]) =>
  rows.map((row) => ({
    amazonTargetId: required(row.amazonTargetId, 'Target-ID'),
    amazonAdGroupId: row.amazonAdGroupId ?? null,
    amazonCampaignId: row.amazonCampaignId,
    adProduct,
    campaignName: row.campaignName,
    adGroupName: row.adGroupName,
  }));

const LEVELS: Record<DailyMetricsLevel, LevelConfig> = {
  campaign: {
    view: metricsTable(amazonAdsCampaignDailyMetrics, [
      amazonAdsCampaignDailyMetrics.profileId,
      amazonAdsCampaignDailyMetrics.campaignId,
      amazonAdsCampaignDailyMetrics.date,
    ]),
    entityKey: 'campaignId',
    amazonIdOf: (row) => row.amazonCampaignId,
    keyOf: (row) => `${row.date}|${row.amazonCampaignId}`,
    extraKey: () => ({}),
    ensure: (db, scope, adProduct, rows) =>
      ensureCampaigns(
        db,
        scope,
        rows.map((row) => ({
          amazonCampaignId: row.amazonCampaignId,
          adProduct,
          campaignName: row.campaignName,
        })),
      ),
  },
  adGroup: {
    view: metricsTable(amazonAdsAdGroupDailyMetrics, [
      amazonAdsAdGroupDailyMetrics.profileId,
      amazonAdsAdGroupDailyMetrics.adGroupId,
      amazonAdsAdGroupDailyMetrics.date,
    ]),
    entityKey: 'adGroupId',
    amazonIdOf: (row) => required(row.amazonAdGroupId, 'Ad-Group-ID'),
    keyOf: (row) => `${row.date}|${row.amazonAdGroupId}`,
    extraKey: () => ({}),
    ensure: (db, scope, adProduct, rows) =>
      ensureAdGroups(
        db,
        scope,
        rows.map((row) => ({
          amazonAdGroupId: required(row.amazonAdGroupId, 'Ad-Group-ID'),
          amazonCampaignId: row.amazonCampaignId,
          adProduct,
          campaignName: row.campaignName,
          adGroupName: row.adGroupName,
        })),
      ),
  },
  target: {
    view: metricsTable(amazonAdsTargetDailyMetrics, [
      amazonAdsTargetDailyMetrics.profileId,
      amazonAdsTargetDailyMetrics.targetId,
      amazonAdsTargetDailyMetrics.date,
    ]),
    entityKey: 'targetId',
    amazonIdOf: (row) => required(row.amazonTargetId, 'Target-ID'),
    keyOf: (row) => `${row.date}|${row.amazonTargetId}`,
    extraKey: () => ({}),
    ensure: (db, scope, adProduct, rows) => ensureTargets(db, scope, targetRefs(adProduct, rows)),
  },
  productAd: {
    view: metricsTable(amazonAdsProductAdDailyMetrics, [
      amazonAdsProductAdDailyMetrics.profileId,
      amazonAdsProductAdDailyMetrics.productAdId,
      amazonAdsProductAdDailyMetrics.date,
    ]),
    entityKey: 'productAdId',
    amazonIdOf: (row) => required(row.amazonAdId, 'Ad-ID'),
    keyOf: (row) => `${row.date}|${row.amazonAdId}`,
    extraKey: () => ({}),
    ensure: (db, scope, adProduct, rows) =>
      ensureProductAds(
        db,
        scope,
        rows.map((row) => ({
          amazonAdId: required(row.amazonAdId, 'Ad-ID'),
          amazonAdGroupId: required(row.amazonAdGroupId, 'Ad-Group-ID'),
          amazonCampaignId: row.amazonCampaignId,
          adProduct,
          campaignName: row.campaignName,
          adGroupName: row.adGroupName,
          asin: row.asin,
          sku: row.sku,
        })),
      ),
  },
  searchTerm: {
    view: metricsTable(amazonAdsSearchTermDailyMetrics, [
      amazonAdsSearchTermDailyMetrics.profileId,
      amazonAdsSearchTermDailyMetrics.targetId,
      amazonAdsSearchTermDailyMetrics.date,
      amazonAdsSearchTermDailyMetrics.searchTerm,
    ]),
    entityKey: 'targetId',
    amazonIdOf: (row) => required(row.amazonTargetId, 'Target-ID'),
    keyOf: (row) => `${row.date}|${row.amazonTargetId}|${row.searchTerm}`,
    extraKey: (row) => ({ searchTerm: required(row.searchTerm, 'Suchbegriff') }),
    ensure: (db, scope, adProduct, rows) => ensureTargets(db, scope, targetRefs(adProduct, rows)),
  },
};

function assertNoDuplicates(
  level: DailyMetricsLevel,
  rows: readonly MetricRow[],
  keyOf: (row: MetricRow) => string,
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row);
    // Ohne IDs und Suchbegriffe in der Meldung (landet in `failure_reason`).
    if (seen.has(key)) {
      throw new MetricsImportRejectedError(
        `Report enthält doppelte Zeilen (${level}, ${row.date}).`,
      );
    }
    seen.add(key);
  }
}

async function hasRows(db: DbOrTx, view: MetricsTableView, where: SQL | undefined) {
  const found = await db.select({ id: view.id }).from(view.table).where(where).limit(1);
  return found.length > 0;
}

function* chunks<T>(items: readonly T[]): Generator<T[]> {
  for (let i = 0; i < items.length; i += CHUNK_SIZE) yield items.slice(i, i + CHUNK_SIZE);
}
