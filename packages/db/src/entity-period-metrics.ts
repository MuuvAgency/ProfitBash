import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { chunks } from './ad-change-entities';
import { assertProfileInOrganization, type EntityScope } from './amazon-ads-entities';
import type { MetricsDateRange } from './amazon-ads-metrics';
import type { DbOrTx } from './audit';
import { amazonAdsEntityPeriodMetrics } from './schema';

/**
 * Summen je Entity über den Zeitraum einer Bulk-Datei (`phase-5.md` 5.1, F1). Systemzugriff des Datei-Imports
 * und der Automatik, an Organisation und Profil gebunden; Zugriffe aus der API laufen über den Access-Layer.
 */

export type EntityPeriodLevel = 'campaign' | 'adGroup' | 'target' | 'productAd' | 'placement';

export interface EntityPeriodMetric {
  level: EntityPeriodLevel;
  amazonCampaignId: string;
  /** Amazon-ID der Entity; bei `placement` die Platzierung in API-Schreibweise. */
  amazonEntityId: string;
  impressions: number;
  clicks: number;
  cost: string;
  sales: string;
  purchases: number;
  units: number;
  /** Nur SD. */
  viewableImpressions?: number | null;
  salesViewsClicks?: string | null;
  purchasesViewsClicks?: number | null;
  unitsViewsClicks?: number | null;
}

export interface ReplaceEntityPeriodMetricsInput extends EntityScope {
  adProduct: string;
  /** Download-Zeitraum der Datei, beide Tage eingeschlossen. */
  period: MetricsDateRange;
  currencyCode: string;
  /** Höchstens eine Zeile je Ebene, Kampagne und Entity. */
  rows: readonly EntityPeriodMetric[];
  /** `'period'`: alles im Zeitraum (vollständige Datei), sonst nur die Zeilen dieser Kampagnen. */
  replace: 'period' | { amazonCampaignIds: readonly string[] };
  fileImportId?: string | null;
  now: Date;
}

/**
 * Ersetzt die Summen eines Profils für Ad-Typ und Zeitraum (wie `replaceSearchTermPeriodMetrics`); andere
 * Zeiträume bleiben stehen. Ohne Zeilen geschieht nichts: Eine Datei ohne Leistungsdaten löscht keine Summen.
 */
export async function replaceEntityPeriodMetrics(
  db: DbOrTx,
  input: ReplaceEntityPeriodMetricsInput,
): Promise<{ rows: number; deleted: number }> {
  if (input.rows.length === 0) return { rows: 0, deleted: 0 };
  return db.transaction(async (tx) => {
    await assertProfileInOrganization(tx, input);
    const table = amazonAdsEntityPeriodMetrics;
    const deleted = await tx
      .delete(table)
      .where(
        and(
          eq(table.profileId, input.profileId),
          eq(table.organizationId, input.organizationId),
          eq(table.adProduct, input.adProduct),
          eq(table.periodStart, input.period.startDate),
          eq(table.periodEnd, input.period.endDate),
          input.replace === 'period'
            ? undefined
            : inArray(table.amazonCampaignId, [
                ...new Set([
                  ...input.replace.amazonCampaignIds,
                  ...input.rows.map((row) => row.amazonCampaignId),
                ]),
              ]),
        ),
      )
      .returning({ id: table.id });
    for (const chunk of chunks(input.rows)) {
      await tx.insert(table).values(
        chunk.map((row) => ({
          ...row,
          organizationId: input.organizationId,
          profileId: input.profileId,
          adProduct: input.adProduct,
          periodStart: input.period.startDate,
          periodEnd: input.period.endDate,
          currencyCode: input.currencyCode,
          fileImportId: input.fileImportId ?? null,
          importedAt: input.now,
        })),
      );
    }
    return { rows: input.rows.length, deleted: deleted.length };
  });
}

export interface ProfileMetricsState {
  /** Zeitraum, auf dem die Automatik rechnet. */
  period: MetricsDateRange;
  importedAt: Date;
  /** `file`: Zeitraumsummen einer Bulk-Datei; später `daily` (Tageswerte über die API). */
  source: 'file';
}

/**
 * Datenstand eines Profils: der Zeitraum der zuletzt importierten Datei mit Kennzahlen (der Upload zählt,
 * nicht das jüngste Zeitraumende), sonst `null`.
 */
export async function findProfileMetricsState(
  db: DbOrTx,
  scope: EntityScope,
): Promise<ProfileMetricsState | null> {
  const table = amazonAdsEntityPeriodMetrics;
  const [row] = await db
    .select({
      startDate: table.periodStart,
      endDate: table.periodEnd,
      importedAt: table.importedAt,
    })
    .from(table)
    .where(
      and(eq(table.profileId, scope.profileId), eq(table.organizationId, scope.organizationId)),
    )
    .orderBy(desc(table.importedAt), desc(table.periodEnd))
    .limit(1);
  if (!row) return null;
  return {
    period: { startDate: row.startDate, endDate: row.endDate },
    importedAt: row.importedAt,
    source: 'file',
  };
}

/** Summen einer Ebene in einem Zeitraum, alle Ad-Typen, sortiert nach Kampagne und Entity. */
export async function listEntityPeriodMetrics(
  db: DbOrTx,
  input: EntityScope & { period: MetricsDateRange; level: EntityPeriodLevel },
) {
  const table = amazonAdsEntityPeriodMetrics;
  return db
    .select({
      adProduct: table.adProduct,
      amazonCampaignId: table.amazonCampaignId,
      amazonEntityId: table.amazonEntityId,
      currencyCode: table.currencyCode,
      impressions: table.impressions,
      clicks: table.clicks,
      cost: table.cost,
      sales: table.sales,
      purchases: table.purchases,
      units: table.units,
      viewableImpressions: table.viewableImpressions,
      salesViewsClicks: table.salesViewsClicks,
      purchasesViewsClicks: table.purchasesViewsClicks,
      unitsViewsClicks: table.unitsViewsClicks,
    })
    .from(table)
    .where(
      and(
        eq(table.profileId, input.profileId),
        eq(table.organizationId, input.organizationId),
        eq(table.periodStart, input.period.startDate),
        eq(table.periodEnd, input.period.endDate),
        eq(table.level, input.level),
      ),
    )
    .orderBy(asc(table.amazonCampaignId), asc(table.amazonEntityId), asc(table.adProduct));
}

/**
 * Datenstand je Entity: je Ad-Typ, Kampagne und Entity die Summen der zuletzt hochgeladenen Datei, die sie enthält.
 * Ein Teil-Export („nur bestimmte Kampagnen“) lässt so den Stand der übrigen Kampagnen stehen.
 */
export async function listLatestEntityPeriodMetrics(
  db: DbOrTx,
  input: EntityScope & { level: EntityPeriodLevel },
) {
  const table = amazonAdsEntityPeriodMetrics;
  return db
    .selectDistinctOn([table.amazonCampaignId, table.amazonEntityId, table.adProduct], {
      adProduct: table.adProduct,
      amazonCampaignId: table.amazonCampaignId,
      amazonEntityId: table.amazonEntityId,
      periodStart: table.periodStart,
      periodEnd: table.periodEnd,
      importedAt: table.importedAt,
      currencyCode: table.currencyCode,
      impressions: table.impressions,
      clicks: table.clicks,
      cost: table.cost,
      sales: table.sales,
      purchases: table.purchases,
      units: table.units,
      viewableImpressions: table.viewableImpressions,
      salesViewsClicks: table.salesViewsClicks,
      purchasesViewsClicks: table.purchasesViewsClicks,
      unitsViewsClicks: table.unitsViewsClicks,
    })
    .from(table)
    .where(
      and(
        eq(table.profileId, input.profileId),
        eq(table.organizationId, input.organizationId),
        eq(table.level, input.level),
      ),
    )
    .orderBy(
      asc(table.amazonCampaignId),
      asc(table.amazonEntityId),
      asc(table.adProduct),
      desc(table.importedAt),
      desc(table.periodEnd),
    );
}
