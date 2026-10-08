import {
  isReportType,
  REPORT_DEFINITIONS,
  type AmazonAdsAdGroup,
  type AmazonAdsCampaign,
  type AmazonAdsExportedTarget,
  type AmazonAdsProductAd,
} from '@profitbash/amazon-ads';
import {
  confirmBulkFileAdChanges,
  findAdGroupCampaignIds,
  markEntitiesRemoved,
  markMetricsImportedThrough,
  replaceDailyMetrics,
  upsertAdGroups,
  upsertCampaigns,
  upsertNegativeTargets,
  upsertProductAds,
  upsertTargets,
  type DailyMetricsRows,
  type DbOrTx,
  type EntityUpsertCounts,
  type EntityWriteScope,
  type NegativeTargetRecord,
  type ProductAdRecord,
  type RemovableEntity,
  type TargetRecord,
} from '@profitbash/db';
import type { Logger } from '@profitbash/shared';
import type { AmazonImportInput, AmazonRequestFile, AmazonRequestPort } from './state-machine';

/**
 * Schreiben der geladenen Dateien (Phase 1, 1.7), das `import` des Ports aus 1.6. Die Zeilen kommen im
 * Modell aus `@profitbash/amazon-ads` (vom Zeilen-Schema des Ports validiert) und passen ohne Umbau auf
 * die normalisierten Datensätze aus 1.5. Läuft in der Transaktion der Zustandsmaschine.
 */

export type ImportCounterName =
  | 'created'
  | 'updated'
  | 'removed'
  | 'placeholdersFilled'
  | 'placeholdersCreated'
  | 'changesConfirmed';
export type ImportCounters = Partial<Record<ImportCounterName, number>>;

export interface AmazonImport {
  import: AmazonRequestPort['import'];
  /**
   * Zähler der Importe seit dem letzten Aufruf (und zurücksetzen). Der Aufrufer übernimmt sie nur, wenn
   * der Auftrag danach `imported` ist (sonst rollte die Transaktion zurück).
   */
  takeCounters(): ImportCounters;
}

export function createAmazonImport(options: { now: () => Date; logger: Logger }): AmazonImport {
  let counters: ImportCounters = {};
  const add = (source: ImportCounters) => {
    for (const [key, value] of Object.entries(source) as Array<[ImportCounterName, number]>) {
      counters[key] = (counters[key] ?? 0) + value;
    }
  };

  return {
    async import(tx, input) {
      add(
        input.kind === 'report'
          ? await importReport(tx, input, options.now())
          : await importEntityBatch(tx, input, options),
      );
    },
    takeCounters() {
      const taken = counters;
      counters = {};
      return taken;
    },
  };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

async function importReport(
  tx: DbOrTx,
  input: Extract<AmazonImportInput, { kind: 'report' }>,
  now: Date,
): Promise<ImportCounters> {
  const { request } = input;
  if (!isReportType(request.reportType)) {
    throw new Error(`Report-Typ ${request.reportType} ist nicht im Katalog.`);
  }
  const { level } = REPORT_DEFINITIONS[request.reportType];
  const result = await replaceDailyMetrics(tx, {
    organizationId: request.organizationId,
    profileId: request.profileId,
    adProduct: request.adProduct,
    ranges: input.ranges,
    invalidRowCount: input.invalidRowCount,
    now,
    // Das Zeilen-Schema des Report-Typs (Port, 1.6) liefert genau die Zeilen dieser Ebene.
    ...({ level, rows: input.rows } as DailyMetricsRows),
  });
  // „Daten bis“ (1.8) je Ad-Typ aus dem Kampagnen-Report: Das Ende des Auftrags, nicht das der
  // `ranges`. Tage außerhalb der `ranges` deckt ein neuerer, schon importierter Report ab.
  if (level === 'campaign' && request.endDate) {
    await markMetricsImportedThrough(tx, {
      organizationId: request.organizationId,
      profileId: request.profileId,
      adProduct: request.adProduct,
      date: request.endDate,
    });
  }
  return { placeholdersCreated: result.placeholdersCreated };
}

// ---------------------------------------------------------------------------
// Entity-Batch
// ---------------------------------------------------------------------------

/**
 * Importiert die vier Exports eines Batches (ein Profil, ein Ad-Typ) in Hierarchie-Reihenfolge:
 * Kampagnen → Ad Groups → Targets, Negatives, Product Ads. Fehlt Targets oder Ads die Kampagne (SB/SD,
 * Ads im gemeinsamen Modell), kommt sie von der Ad Group desselben Batches; ohne sie ist die Zeile nicht
 * auflösbar und zählt wie eine ungültige. Nur ein Batch ohne ungültige Zeilen setzt `removed_at`: Eine
 * ungültige Zeile ist eine Entity, die fehlt, obwohl es sie gibt.
 */
async function importEntityBatch(
  tx: DbOrTx,
  input: Extract<AmazonImportInput, { kind: 'export' }>,
  options: { now: () => Date; logger: Logger },
): Promise<ImportCounters> {
  const byType = new Map(input.files.map((file) => [file.request.reportType, file]));
  const file = (type: string) => {
    const found = byType.get(type);
    if (!found) throw new Error(`Export ${type} fehlt im Batch.`);
    return found;
  };
  const campaignsFile = file('campaigns');
  const adGroupsFile = file('adGroups');
  const targetsFile = file('targets');
  const adsFile = file('ads');
  const { organizationId, profileId, adProduct } = campaignsFile.request;
  if (
    input.files.some((f) => f.request.profileId !== profileId || f.request.adProduct !== adProduct)
  ) {
    throw new Error('Die Exports des Batches gehören zu verschiedenen Profilen oder Ad-Typen.');
  }
  const scope: EntityWriteScope = { organizationId, profileId, now: options.now() };

  const campaigns = campaignsFile.rows as AmazonAdsCampaign[];
  const adGroups = adGroupsFile.rows as AmazonAdsAdGroup[];
  const exportedTargets = targetsFile.rows as AmazonAdsExportedTarget[];
  const ads = adsFile.rows as AmazonAdsProductAd[];

  // Kampagne über die Ad Groups des Batches, sonst über vorhandene (die Exports eines Batches können
  // zeitversetzt laufen, siehe Export-Plätze in `amazon-context.ts`).
  const campaignOfAdGroup = new Map(adGroups.map((g) => [g.amazonAdGroupId, g.amazonCampaignId]));
  const missingAdGroups = [...exportedTargets.map((row) => row.target), ...ads].flatMap((row) =>
    row.amazonCampaignId === null &&
    row.amazonAdGroupId !== null &&
    !campaignOfAdGroup.has(row.amazonAdGroupId)
      ? [row.amazonAdGroupId]
      : [],
  );
  if (missingAdGroups.length > 0) {
    for (const [adGroupId, campaignId] of await findAdGroupCampaignIds(
      tx,
      scope,
      missingAdGroups,
    )) {
      campaignOfAdGroup.set(adGroupId, campaignId);
    }
  }
  let unresolved = 0;
  function withCampaign<
    T extends { amazonCampaignId: string | null; amazonAdGroupId: string | null },
  >(row: T): (Omit<T, 'amazonCampaignId'> & { amazonCampaignId: string }) | null {
    const amazonCampaignId =
      row.amazonCampaignId ??
      (row.amazonAdGroupId === null ? undefined : campaignOfAdGroup.get(row.amazonAdGroupId));
    if (amazonCampaignId === undefined) {
      unresolved += 1;
      return null;
    }
    return { ...row, amazonCampaignId };
  }

  const targets: TargetRecord[] = [];
  const negatives: NegativeTargetRecord[] = [];
  for (const row of exportedTargets) {
    if (row.kind === 'target') {
      const resolved = withCampaign(row.target);
      if (resolved) targets.push(resolved);
    } else {
      const resolved = withCampaign(row.target);
      if (resolved) negatives.push(resolved);
    }
  }
  const productAds = ads.flatMap((row): ProductAdRecord[] => {
    const resolved = withCampaign(row);
    return resolved === null ? [] : [resolved];
  });
  if (unresolved > 0) {
    options.logger({
      level: 'warn',
      msg: 'entities_import.unresolved_campaign',
      batchId: input.batchId,
      rows: unresolved,
    });
  }

  const counts: EntityUpsertCounts[] = [
    await upsertCampaigns(tx, scope, campaigns),
    await upsertAdGroups(tx, scope, adGroups),
    await upsertTargets(tx, scope, targets),
    await upsertNegativeTargets(tx, scope, negatives),
    await upsertProductAds(tx, scope, productAds),
  ];

  let removed = 0;
  const invalid = input.files.reduce((sum, f) => sum + f.invalidRowCount, 0) + unresolved;
  if (invalid === 0) {
    const removals: Array<[RemovableEntity, AmazonRequestFile, string[]]> = [
      ['campaign', campaignsFile, campaigns.map((r) => r.amazonCampaignId)],
      ['adGroup', adGroupsFile, adGroups.map((r) => r.amazonAdGroupId)],
      ['target', targetsFile, targets.map((r) => r.amazonTargetId)],
      ['negativeTarget', targetsFile, negatives.map((r) => r.amazonTargetId)],
      ['productAd', adsFile, productAds.map((r) => r.amazonAdId)],
    ];
    for (const [entity, source, seenAmazonIds] of removals) {
      removed += await markEntitiesRemoved(tx, {
        ...scope,
        entity,
        adProduct,
        // Stand des Exports: Was danach entstand (Platzhalter aus Reports), kann darin nicht fehlen.
        existedBefore: source.request.requestedAt ?? source.request.createdAt,
        seenAmazonIds,
      });
    }
  }

  // Übermittlungen per Bulk-Datei für ein Profil mit Connection (3.3): Der Export zeigt, ob die Datei in der
  // Werbekonsole hochgeladen wurde.
  const { confirmed } = await confirmBulkFileAdChanges(tx, {
    organizationId,
    profileId,
    now: scope.now,
  });

  return {
    ...(confirmed > 0 && { changesConfirmed: confirmed }),
    created: sum(counts, 'created'),
    updated: sum(counts, 'updated'),
    removed,
    placeholdersFilled: sum(counts, 'placeholdersFilled'),
    placeholdersCreated: sum(counts, 'placeholdersCreated'),
  };
}

const sum = (counts: EntityUpsertCounts[], key: keyof EntityUpsertCounts) =>
  counts.reduce((total, count) => total + count[key], 0);
