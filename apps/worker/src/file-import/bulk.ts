import {
  campaignOwnership,
  findAdGroupCampaignIds,
  markEntitiesRemoved,
  findProfileCurrency,
  replaceSearchTermPeriodMetrics,
  upsertAdGroups,
  upsertCampaigns,
  upsertNegativeTargets,
  upsertPortfolios,
  upsertProductAds,
  upsertTargets,
  type AdGroupRecord,
  type CampaignRecord,
  type DbOrTx,
  type EntityUpsertCounts,
  type EntityWriteScope,
  type NegativeTargetRecord,
  type PortfolioRecord,
  type ProductAdRecord,
  type RemovableEntity,
  type TargetRecord,
} from '@profitbash/db';
import { parseBulkPeriod, type Logger } from '@profitbash/shared';
import { openXlsx, type RowInfo } from '@profitbash/sheets';
import { FileImportRejectedError, type FileImporter } from '../jobs/file-import';
import {
  AD_PRODUCT_OF_SHEET,
  BIDDING_STRATEGIES,
  BUDGET_POLICIES,
  BUDGET_TYPES,
  classifySheet,
  columnLabel,
  COST_TYPES,
  entityKind,
  mapHeader,
  mapValue,
  MATCH_TYPES,
  parseBulkAmount,
  parseBulkDate,
  parseBulkId,
  parseTargetExpression,
  PLACEMENTS,
  STATES,
  TARGETING_TYPES,
  type BulkColumn,
  type BulkSheetKind,
  type CellResult,
  type EntityKind,
  type ValueMap,
} from './bulk-columns';
import { isSearchTermSheet, SearchTermCollector, searchTermSheetKind } from './bulk-search-terms';

/**
 * Bulk-Datei der Werbekonsole → Entities (`phase-1.md` 1.11d). Liest die Blätter Portfolios, SP, SB und SD
 * und schreibt über dieselben Upserts wie der API-Sync (1.5, normalisierte Datensätze) in **einer**
 * Transaktion in Hierarchie-Reihenfolge: Portfolios → Kampagnen → Ad Groups → Targets, Negatives,
 * Product Ads. Gleiche Amazon-IDs und Schreibweisen wie der Export: Ein späterer API-Sync setzt nahtlos fort.
 *
 * - Kennzahlen der Entity-Blätter (Summen über den gewählten Zeitraum) werden nicht übernommen.
 * - Die Suchbegriff-Blätter (SP, SB) werden als Summen je Download-Zeitraum gespeichert (`phase-2b.md` 2b.1,
 *   `bulk-search-terms.ts`), in derselben Transaktion wie die Entities. Der Zeitraum steht im Dateinamen;
 *   fehlt er dort (Datei umbenannt), gilt der beim Upload von Hand angegebene (2b.2c). Fehlen beide, bleiben
 *   die Suchbegriffe weg (`searchTermsWithoutPeriod`).
 * - `removed_at` nur bei einer laut Upload vollständigen Datei (`markMissingAsRemoved`): Die Konsole
 *   exportiert auch Teilmengen („nur bestimmte Kampagnen“), sonst hieße eine fehlende Entity nichts.
 * - Kampagnen eines anderen Profils derselben Organisation → Ablehnung; passt keine Kampagne zum Profil,
 *   ein Hinweis (`unmatchedCampaigns`).
 * - Ungültige Zeilen werden gezählt (`invalidRows`) und übersprungen; sind alle ungültig, wird die Datei
 *   abgelehnt. Logs und Meldungen nennen nur Blatt, Zeile und Spalte, nie Zellinhalte (Kundendaten).
 */

/** Höchstens so viele ungültige Zeilen einzeln loggen, danach nur die Summe. */
const MAX_INVALID_ROW_LOGS = 20;

const CAMPAIGN_SHEET_COLUMNS: readonly BulkColumn[] = ['entity', 'campaignId', 'state'];
const PORTFOLIO_SHEET_COLUMNS: readonly BulkColumn[] = ['portfolioId', 'portfolioName', 'state'];

export const importBulkFile: FileImporter = async (input) => {
  const scope: EntityWriteScope = {
    organizationId: input.organizationId,
    profileId: input.profileId,
    now: input.now,
  };
  const currencyCode = await findProfileCurrency(input.db, scope);
  if (currencyCode === null) throw new Error('Profil nicht gefunden.');

  const workbook = openXlsx(input.content);
  const sheets = workbook.sheets.flatMap((sheet) => {
    const kind = sheet.state === 'visible' ? classifySheet(sheet.name) : null;
    return kind ? [{ name: sheet.name, kind }] : [];
  });
  if (!sheets.some((sheet) => sheet.kind !== 'portfolios')) {
    throw new FileImportRejectedError(
      'Das ist keine Bulk-Datei der Werbekonsole: Kein Blatt mit Sponsored-Products-, Sponsored-Brands- ' +
        'oder Sponsored-Display-Kampagnen gefunden.',
    );
  }

  const collector = new BulkCollector(input.logger, currencyCode);
  for (const sheet of sheets) {
    readSheet(sheet.name, sheet.kind, (row) => collector.add(row), workbook.forEachRow);
  }

  const searchTerms = new SearchTermCollector(input.logger);
  for (const sheet of workbook.sheets) {
    if (sheet.state !== 'visible' || !isSearchTermSheet(sheet.name)) continue;
    const kind = searchTermSheetKind(sheet.name);
    if (kind) searchTerms.readSheet(sheet.name, kind, workbook.forEachRow);
    else {
      input.logger({
        level: 'warn',
        msg: 'bulk_import.search_term_sheet_skipped',
        sheet: sheet.name,
        reason: 'unknown_ad_product',
      });
    }
  }
  // Der Dateiname der Werbekonsole gewinnt; der von Hand angegebene Zeitraum ist nur der Ausweg (2b.2c).
  const period = parseBulkPeriod(input.fileName) ?? input.period ?? null;

  return input.db.transaction(async (tx) => {
    const records = await collector.finish(async (adGroupIds) =>
      findAdGroupCampaignIds(tx, scope, adGroupIds),
    );

    // Bulk-Datei eines anderen Kontos? (Dominik, 2026-10-07: eindeutig → ablehnen, sonst Hinweis.)
    // Auch Kampagnen, die nur über Ad Groups, Targets, Anzeigen oder Suchbegriffe in der Datei stehen.
    const fileCampaignIds = [
      ...new Set([
        ...[
          ...records.campaigns,
          ...records.adGroups,
          ...records.targets,
          ...records.negatives,
          ...records.productAds,
        ].map((r) => r.amazonCampaignId),
        ...searchTerms.amazonCampaignIds,
      ]),
    ];
    const ownership = await campaignOwnership(tx, { ...scope, amazonCampaignIds: fileCampaignIds });
    if (ownership.otherProfiles.length > 0) {
      // Ausgeblendete Profile sehen nur Org-Admins (ADR 002): nicht beim Namen nennen.
      const visible = ownership.otherProfiles.filter((p) => !p.isHidden);
      const which =
        visible.length > 0
          ? `einem anderen Profil (${visible.map((p) => `„${p.accountName}“`).join(', ')})`
          : 'einem anderen Profil der Organisation';
      throw new FileImportRejectedError(
        `Die Kampagnen dieser Datei gehören schon zu ${which}. ` +
          'Bitte die Datei beim passenden Profil hochladen.',
      );
    }
    const unmatched =
      ownership.existing > 0 && ownership.matched === 0 && fileCampaignIds.length > 0;
    if (unmatched) {
      input.logger({
        level: 'warn',
        msg: 'bulk_import.no_matching_campaigns',
        existing: ownership.existing,
        inFile: fileCampaignIds.length,
      });
    }

    const searchTermSheets = searchTerms.finish();
    let searchTermRows = 0;
    if (unmatched) {
      // Fremd wirkende Datei: wie beim Entfernen nichts ersetzen (die Summen des Profils blieben sonst falsch).
      if (searchTerms.rowCount > 0) {
        input.logger({
          level: 'warn',
          msg: 'bulk_import.search_terms_skipped_unmatched',
          rows: searchTerms.rowCount,
        });
      }
    } else if (period) {
      for (const sheet of searchTermSheets) {
        const written = await replaceSearchTermPeriodMetrics(tx, {
          ...scope,
          adProduct: AD_PRODUCT_OF_SHEET[sheet.kind],
          period,
          currencyCode,
          rows: sheet.rows,
          replace: input.complete ? 'period' : { amazonCampaignIds: fileCampaignIds },
          fileImportId: input.fileImportId,
        });
        searchTermRows += written.rows;
      }
    } else if (searchTerms.rowCount > 0) {
      // Ohne Zeitraum wären die Summen nicht einzuordnen (Datei umbenannt, beim Upload keiner angegeben).
      input.logger({
        level: 'warn',
        msg: 'bulk_import.search_terms_without_period',
        rows: searchTerms.rowCount,
      });
    }

    const counts: EntityUpsertCounts[] = [
      await upsertPortfolios(tx, scope, records.portfolios),
      await upsertCampaigns(tx, scope, records.campaigns),
      await upsertAdGroups(tx, scope, records.adGroups),
      await upsertTargets(tx, scope, records.targets),
      await upsertNegativeTargets(tx, scope, records.negatives),
      await upsertProductAds(tx, scope, records.productAds),
    ];
    return {
      portfolios: uniqueCount(records.portfolios, (r) => r.amazonPortfolioId),
      campaigns: uniqueCount(records.campaigns, (r) => r.amazonCampaignId),
      adGroups: uniqueCount(records.adGroups, (r) => r.amazonAdGroupId),
      targets: uniqueCount(records.targets, (r) => r.amazonTargetId),
      negatives: uniqueCount(records.negatives, (r) => r.amazonTargetId),
      productAds: uniqueCount(records.productAds, (r) => r.amazonAdId),
      created: sum(counts, 'created'),
      updated: sum(counts, 'updated'),
      placeholdersFilled: sum(counts, 'placeholdersFilled'),
      placeholdersCreated: sum(counts, 'placeholdersCreated'),
      invalidRows: collector.invalidRows,
      removed: await markMissingAsRemoved(tx, { ...input, unmatched }, scope, records, collector),
      ...(unmatched && { unmatchedCampaigns: fileCampaignIds.length }),
      // Nur genannt, wenn die Datei Suchbegriffe enthält (Downloads ohne Leistungsdaten haben keine).
      ...(searchTermRows > 0 && { searchTerms: searchTermRows }),
      ...(!unmatched &&
        !period &&
        searchTerms.rowCount > 0 && { searchTermsWithoutPeriod: searchTerms.rowCount }),
      ...(searchTerms.invalidRows > 0 && { invalidSearchTermRows: searchTerms.invalidRows }),
    };
  });
};

/**
 * Nur bei einer laut Upload vollständigen Datei (Dominik, 2026-10-07): Entities, die vor dem Upload schon
 * existierten und in der Datei fehlen, gelten als entfernt (`markEntitiesRemoved` wie beim API-Export).
 * Bewusst vorsichtig, weil eine falsch gesetzte Markierung erst die nächste Datei zurücknimmt:
 * - nichts bei ungültigen Zeilen (eine ungültige Zeile ist eine Entity, die es gibt) und nichts bei einer
 *   fremd wirkenden Datei (keine Kampagne passt zum Profil);
 * - je Ad-Typ und Ebene nur, wenn die Datei mindestens eine Zeile dieser Art enthält (ein leeres oder fehlendes
 *   Blatt sagt nichts, ob die Konsole abgewählte Ad-Typen leer mitschreibt, ist offen), und nicht für Ad-Typen mit
 *   nicht abgebildeten Zeilen (`partiallyRead`);
 * - Eltern, auf die Zeilen der Datei verweisen (Ad Group eines Targets, Portfolio einer Kampagne), gelten als
 *   gesehen.
 */
async function markMissingAsRemoved(
  tx: DbOrTx,
  input: { complete: boolean; uploadedAt: Date; logger: Logger; unmatched: boolean },
  scope: EntityWriteScope,
  records: BulkRecords,
  collector: BulkCollector,
): Promise<number> {
  if (!input.complete) return 0;
  const skip = (reason: string, extra: Record<string, unknown> = {}) =>
    input.logger({ level: 'warn', msg: 'bulk_import.removal_skipped', reason, ...extra });
  if (collector.invalidRows > 0) {
    skip('invalid_rows', { invalidRows: collector.invalidRows });
    return 0;
  }
  if (input.unmatched) {
    skip('unmatched');
    return 0;
  }
  const mark = async (
    entity: RemovableEntity,
    adProduct: string | null,
    own: readonly string[],
    referenced: ReadonlyArray<string | null> = [],
  ) => {
    // Keine Zeile dieser Art in der Datei: keine Aussage über sie.
    if (own.length === 0) return 0;
    const seenAmazonIds = [
      ...new Set([...own, ...referenced.filter((id): id is string => id !== null)]),
    ];
    return markEntitiesRemoved(tx, {
      ...scope,
      entity,
      adProduct,
      existedBefore: input.uploadedAt,
      seenAmazonIds,
    });
  };
  let removed = await mark(
    'portfolio',
    null,
    records.portfolios.map((r) => r.amazonPortfolioId),
    records.campaigns.map((r) => r.amazonPortfolioId),
  );
  const adProducts = new Set(records.campaigns.map((r) => r.adProduct));
  for (const adProduct of adProducts) {
    if (collector.partiallyRead.has(adProduct)) {
      input.logger({
        level: 'info',
        msg: 'bulk_import.removal_skipped',
        reason: 'partially_read',
        adProduct,
      });
      continue;
    }
    const of = <T extends { adProduct: string }, V>(rows: T[], value: (row: T) => V) =>
      rows.filter((row) => row.adProduct === adProduct).map(value);
    const children = [
      ...of(records.targets, (r) => r),
      ...of(records.negatives, (r) => r),
      ...of(records.productAds, (r) => r),
    ];
    removed += await mark(
      'campaign',
      adProduct,
      of(records.campaigns, (r) => r.amazonCampaignId),
      [
        ...of(records.adGroups, (r) => r.amazonCampaignId),
        ...children.map((r) => r.amazonCampaignId),
      ],
    );
    removed += await mark(
      'adGroup',
      adProduct,
      of(records.adGroups, (r) => r.amazonAdGroupId),
      children.map((r) => r.amazonAdGroupId),
    );
    removed += await mark(
      'target',
      adProduct,
      of(records.targets, (r) => r.amazonTargetId),
    );
    removed += await mark(
      'negativeTarget',
      adProduct,
      of(records.negatives, (r) => r.amazonTargetId),
    );
    removed += await mark(
      'productAd',
      adProduct,
      of(records.productAds, (r) => r.amazonAdId),
    );
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Blätter lesen
// ---------------------------------------------------------------------------

interface RowPosition {
  sheet: string;
  row: number;
}

interface SheetRow extends RowPosition {
  kind: BulkSheetKind;
  cells: string[];
  info: RowInfo;
  columns: ReadonlyMap<BulkColumn, number>;
}

/** Kopfzeile ist die erste nicht leere Zeile; leere Zeilen danach werden übergangen. */
function readSheet(
  sheet: string,
  kind: BulkSheetKind,
  onRow: (row: SheetRow) => void,
  forEachRow: (
    sheet: string,
    callback: (cells: string[], row: number, info: RowInfo) => void,
  ) => void,
): void {
  let columns: Map<BulkColumn, number> | null = null;
  forEachRow(sheet, (cells, row, info) => {
    if (cells.every((cell) => cell.trim() === '')) return;
    if (columns === null) {
      columns = mapHeader(cells);
      const required = kind === 'portfolios' ? PORTFOLIO_SHEET_COLUMNS : CAMPAIGN_SHEET_COLUMNS;
      const missing = required.find((column) => !columns!.has(column));
      if (missing) {
        throw new FileImportRejectedError(
          `Blatt „${sheet}“: Spalte „${columnLabel(missing)}“ fehlt.`,
        );
      }
      return;
    }
    onRow({ sheet, row, kind, cells, info, columns });
  });
}

/** Ungültige Zelle: Die Zeile wird übersprungen und gezählt. */
class InvalidCell extends Error {
  constructor(
    readonly column: BulkColumn,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'InvalidCell';
  }
}

/** Zugriff auf die Zellen einer Zeile über die logischen Spalten. */
class Cells {
  constructor(
    private readonly row: SheetRow,
    private readonly onUnknown: (field: BulkColumn, value: string) => void,
  ) {}

  has(column: BulkColumn): boolean {
    return this.row.columns.has(column);
  }

  text(column: BulkColumn): string {
    const index = this.row.columns.get(column);
    return index === undefined ? '' : (this.row.cells[index] ?? '').trim();
  }

  optionalText(column: BulkColumn): string | null {
    const value = this.text(column);
    return value === '' ? null : value;
  }

  requiredText(column: BulkColumn): string {
    const value = this.text(column);
    if (value === '') throw new InvalidCell(column, 'fehlt');
    return value;
  }

  id(column: BulkColumn): string | null {
    const index = this.row.columns.get(column);
    const numeric = index !== undefined && this.row.info.numericColumns.has(index);
    return this.checked(column, parseBulkId(this.text(column), numeric), 'keine gültige ID');
  }

  requiredId(column: BulkColumn): string {
    const value = this.id(column);
    if (value === null) throw new InvalidCell(column, 'fehlt');
    return value;
  }

  amount(column: BulkColumn): string | null {
    return this.checked(column, parseBulkAmount(this.text(column)), 'kein lesbarer Betrag');
  }

  date(column: BulkColumn): string | null {
    return this.checked(column, parseBulkDate(this.text(column)), 'kein Tag im Format JJJJMMTT');
  }

  /** Enum-Wert in API-Schreibweise; unbekannte unverändert (und einmal geloggt). */
  value(column: BulkColumn, map: ValueMap): string | null {
    const raw = this.text(column);
    if (raw === '') return null;
    const mapped = mapValue(map, raw);
    if (!mapped.known) this.onUnknown(column, mapped.value);
    return mapped.value;
  }

  requiredValue(column: BulkColumn, map: ValueMap): string {
    const value = this.value(column, map);
    if (value === null) throw new InvalidCell(column, 'fehlt');
    return value;
  }

  private checked<T>(column: BulkColumn, result: CellResult<T>, reason: string): T | null {
    if (result === 'invalid') throw new InvalidCell(column, reason);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Zeilen → Datensätze
// ---------------------------------------------------------------------------

/** Kampagne noch offen (SB/SD-Zeilen ohne Kampagnen-ID: über die Ad Group, wie beim API-Sync). */
type Unresolved<T extends { amazonCampaignId: string }> = Omit<T, 'amazonCampaignId'> & {
  amazonCampaignId: string | null;
};

interface Pending<T extends { amazonCampaignId: string }> {
  record: Unresolved<T>;
  position: RowPosition;
}

interface PlacementAdjustment {
  placement: string;
  percentage: string;
  position: RowPosition;
}

export interface BulkRecords {
  portfolios: PortfolioRecord[];
  campaigns: CampaignRecord[];
  adGroups: AdGroupRecord[];
  targets: TargetRecord[];
  negatives: NegativeTargetRecord[];
  productAds: ProductAdRecord[];
}

const BASE = { amazonUpdatedAt: null, extra: {} } as const;

class BulkCollector {
  invalidRows = 0;
  /**
   * Ad-Typen mit Zeilen, die der Import nicht abbildet (unbekannte oder nicht unterstützte Entities, z. B.
   * SB-Anzeigen): Für sie gilt auch eine vollständige Datei nicht als vollständig gelesen (kein `removed_at`).
   */
  readonly partiallyRead = new Set<string>();
  private loggedInvalid = 0;
  private readonly seen = new Set<string>();

  private readonly portfolios: PortfolioRecord[] = [];
  private readonly campaigns: CampaignRecord[] = [];
  private readonly adGroups: AdGroupRecord[] = [];
  private readonly targets: Array<Pending<TargetRecord>> = [];
  private readonly negatives: Array<Pending<NegativeTargetRecord>> = [];
  private readonly productAds: Array<Pending<ProductAdRecord>> = [];
  private readonly adjustments = new Map<string, Map<string, PlacementAdjustment>>();

  constructor(
    private readonly logger: Logger,
    private readonly currencyCode: string,
  ) {}

  add(row: SheetRow): void {
    const position = { sheet: row.sheet, row: row.row };
    const cells = new Cells(row, (field, value) => this.unknownValue(position, field, value));
    try {
      if (row.kind === 'portfolios') {
        this.addPortfolio(cells);
        return;
      }
      const adProduct = AD_PRODUCT_OF_SHEET[row.kind];
      const kind = entityKind(cells.requiredText('entity'));
      if (kind === null) {
        this.partiallyRead.add(adProduct);
        this.once(`entity\u0000${row.sheet}\u0000${cells.text('entity').toLowerCase()}`, () =>
          this.logger({ level: 'warn', msg: 'bulk_import.unknown_entity', ...position }),
        );
        return;
      }
      this.addEntity(kind, row.kind, adProduct, cells, position);
    } catch (error) {
      if (!(error instanceof InvalidCell)) throw error;
      this.invalid(position, error.column, error.reason);
    }
  }

  private addEntity(
    kind: EntityKind,
    sheetKind: Exclude<BulkSheetKind, 'portfolios'>,
    adProduct: string,
    cells: Cells,
    position: RowPosition,
  ): void {
    switch (kind) {
      case 'campaign':
        return this.addCampaign(sheetKind, adProduct, cells);
      case 'adGroup': {
        const defaultBid = cells.amount('adGroupDefaultBid');
        this.adGroups.push({
          ...BASE,
          amazonAdGroupId: cells.requiredId('adGroupId'),
          amazonCampaignId: cells.requiredId('campaignId'),
          adProduct,
          name: cells.requiredText('adGroupName'),
          state: cells.requiredValue('state', STATES),
          defaultBid,
          defaultBidCurrencyCode: defaultBid === null ? null : this.currencyCode,
        });
        return;
      }
      case 'productAd':
        this.productAds.push({
          position,
          record: {
            ...BASE,
            amazonAdId: cells.requiredId('adId'),
            amazonAdGroupId: cells.requiredId('adGroupId'),
            amazonCampaignId: cells.id('campaignId'),
            adProduct,
            asin: cells.optionalText('asin'),
            sku: cells.optionalText('sku'),
            state: cells.requiredValue('state', STATES),
          },
        });
        return;
      case 'keyword':
      case 'negativeKeyword':
      case 'campaignNegativeKeyword': {
        const keywordText = cells.requiredText('keywordText');
        const matchType = cells.requiredValue('matchType', MATCH_TYPES);
        return this.addTarget(kind, adProduct, cells, position, {
          amazonTargetId: cells.requiredId('keywordId'),
          targetType: 'keyword',
          keywordText,
          matchType,
          expression: { matchType, keyword: keywordText },
        });
      }
      case 'productTargeting':
      case 'negativeProductTargeting':
      case 'campaignNegativeProductTargeting':
      case 'audienceTargeting':
      case 'contextualTargeting': {
        const idColumn: BulkColumn =
          cells.text('productTargetingId') !== '' || !cells.has('targetingId')
            ? 'productTargetingId'
            : 'targetingId';
        const amazonTargetId = cells.requiredId(idColumn);
        const expressionColumn: BulkColumn =
          cells.text('productTargetingExpression') !== '' || !cells.has('targetingExpression')
            ? 'productTargetingExpression'
            : 'targetingExpression';
        const resolved =
          cells.optionalText('resolvedProductTargetingExpression') ??
          cells.text('resolvedTargetingExpression');
        const parsed = parseTargetExpression(cells.requiredText(expressionColumn), resolved);
        if (!parsed.known) {
          this.unknownValue(position, expressionColumn, cells.text(expressionColumn));
        }
        return this.addTarget(kind, adProduct, cells, position, {
          amazonTargetId,
          targetType: parsed.targetType,
          keywordText: null,
          matchType: parsed.matchType,
          expression: parsed.expression,
        });
      }
      case 'biddingAdjustment': {
        const campaignId = cells.requiredId('campaignId');
        const placement = cells.requiredValue('placement', PLACEMENTS);
        const percentage = cells.amount('percentage');
        // Leerer Prozentsatz: keine Anpassung für diese Platzierung (nicht ungültig).
        if (percentage === null) return;
        const forCampaign = this.adjustments.get(campaignId) ?? new Map();
        forCampaign.set(placement, { placement, percentage, position });
        this.adjustments.set(campaignId, forCampaign);
        return;
      }
      case 'portfolio':
      case 'unsupported':
        this.partiallyRead.add(adProduct);
        this.once(`skipped\u0000${position.sheet}\u0000${kind}`, () =>
          this.logger({
            level: 'info',
            msg: 'bulk_import.entity_skipped',
            ...position,
            entity: kind,
          }),
        );
        return;
    }
  }

  private addCampaign(
    sheetKind: Exclude<BulkSheetKind, 'portfolios'>,
    adProduct: string,
    cells: Cells,
  ): void {
    const budgetAmount = cells.amount('dailyBudget') ?? cells.amount('budget');
    const budgetType =
      cells.value('budgetType', BUDGET_TYPES) ??
      (sheetKind === 'sp' && budgetAmount !== null ? 'DAILY' : null);
    const targetingType =
      sheetKind === 'sp'
        ? cells.value('targetingType', TARGETING_TYPES)
        : sheetKind === 'sd'
          ? (cells.optionalText('tactic')?.toUpperCase() ?? null)
          : null;
    const costType = sheetKind === 'sp' ? null : cells.value('costType', COST_TYPES);
    this.campaigns.push({
      ...BASE,
      amazonCampaignId: cells.requiredId('campaignId'),
      amazonPortfolioId: cells.id('portfolioId'),
      adProduct,
      name: cells.requiredText('campaignName'),
      state: cells.requiredValue('state', STATES),
      targetingType,
      budgetAmount,
      budgetCurrencyCode: budgetAmount === null ? null : this.currencyCode,
      budgetType,
      biddingStrategy: cells.value('biddingStrategy', BIDDING_STRATEGIES),
      startDate: cells.date('startDate'),
      endDate: cells.date('endDate'),
      extra: costType === null ? {} : { costType },
    });
  }

  private addTarget(
    kind: EntityKind,
    adProduct: string,
    cells: Cells,
    position: RowPosition,
    target: Pick<
      TargetRecord,
      'amazonTargetId' | 'targetType' | 'keywordText' | 'matchType' | 'expression'
    >,
  ): void {
    const campaignLevel =
      kind === 'campaignNegativeKeyword' || kind === 'campaignNegativeProductTargeting';
    const amazonAdGroupId = campaignLevel ? null : cells.id('adGroupId');
    // Targets ohne Ad Group gibt es nur im älteren SB-Blatt (Kampagnen ohne Ad Groups). In SP und SD hieße
    // eine fehlende Ad Group sonst still „gilt für die Kampagne“.
    if (amazonAdGroupId === null && !campaignLevel && adProduct !== AD_PRODUCT_OF_SHEET.sb) {
      throw new InvalidCell('adGroupId', 'fehlt');
    }
    const amazonCampaignId = cells.id('campaignId');
    // Ohne Kampagne und Ad Group gehört die Zeile nirgends hin.
    if (amazonCampaignId === null && amazonAdGroupId === null) {
      throw new InvalidCell('campaignId', 'fehlt');
    }
    const state = cells.requiredValue('state', STATES);
    const negative =
      kind === 'negativeKeyword' ||
      kind === 'campaignNegativeKeyword' ||
      kind === 'negativeProductTargeting' ||
      kind === 'campaignNegativeProductTargeting';
    if (negative) {
      this.negatives.push({
        position,
        record: {
          ...BASE,
          ...target,
          level: amazonAdGroupId === null ? 'campaign' : 'ad_group',
          amazonCampaignId,
          amazonAdGroupId,
          adProduct,
          state,
        },
      });
      return;
    }
    const bid = cells.amount('bid');
    this.targets.push({
      position,
      record: {
        ...BASE,
        ...target,
        amazonCampaignId,
        amazonAdGroupId,
        adProduct,
        state,
        bid,
        bidCurrencyCode: bid === null ? null : this.currencyCode,
      },
    });
  }

  private addPortfolio(cells: Cells): void {
    const code = cells.text('budgetCurrencyCode').toUpperCase();
    if (code !== '' && code !== this.currencyCode) {
      const shown = /^[A-Z]{3}$/.test(code) ? ` (${code})` : '';
      throw new FileImportRejectedError(
        `Die Währung der Portfolios${shown} passt nicht zum Profil (${this.currencyCode}); ` +
          'die Datei gehört vermutlich zu einem anderen Profil.',
      );
    }
    const budgetAmount = cells.amount('budgetAmount');
    this.portfolios.push({
      ...BASE,
      amazonPortfolioId: cells.requiredId('portfolioId'),
      name: cells.requiredText('portfolioName'),
      state: cells.requiredValue('state', STATES),
      budgetAmount,
      budgetCurrencyCode: code !== '' ? code : budgetAmount === null ? null : this.currencyCode,
      budgetPolicy: cells.value('budgetPolicy', BUDGET_POLICIES),
      budgetStartDate: cells.date('budgetStartDate'),
      budgetEndDate: cells.date('budgetEndDate'),
      inBudget: null,
    });
  }

  /**
   * Schließt das Lesen ab: Gebotsanpassungen an die Kampagnen, fehlende Kampagnen über die Ad Groups der
   * Datei, sonst über vorhandene (`findCampaigns`). Lehnt Dateien ohne gültige Entity ab.
   */
  async finish(
    findCampaigns: (amazonAdGroupIds: string[]) => Promise<Map<string, string>>,
  ): Promise<BulkRecords> {
    const campaignIds = new Set(this.campaigns.map((c) => c.amazonCampaignId));
    for (const [campaignId, adjustments] of this.adjustments) {
      if (campaignIds.has(campaignId)) continue;
      for (const adjustment of adjustments.values()) {
        this.invalid(adjustment.position, 'campaignId', 'Kampagne fehlt in der Datei');
      }
    }
    const campaigns = this.campaigns.map((campaign): CampaignRecord => {
      const adjustments = this.adjustments.get(campaign.amazonCampaignId);
      if (!adjustments) return campaign;
      const placementBidAdjustments = [...adjustments.values()]
        .sort((a, b) => a.placement.localeCompare(b.placement))
        .map(({ placement, percentage }) => ({ placement, percentage }));
      return { ...campaign, extra: { ...campaign.extra, placementBidAdjustments } };
    });

    const campaignOfAdGroup = new Map(
      this.adGroups.map((g) => [g.amazonAdGroupId, g.amazonCampaignId]),
    );
    const pending = [...this.targets, ...this.negatives, ...this.productAds];
    const missing = pending.flatMap(({ record }) =>
      record.amazonCampaignId === null &&
      record.amazonAdGroupId !== null &&
      !campaignOfAdGroup.has(record.amazonAdGroupId)
        ? [record.amazonAdGroupId]
        : [],
    );
    if (missing.length > 0) {
      for (const [adGroupId, campaignId] of await findCampaigns(missing)) {
        campaignOfAdGroup.set(adGroupId, campaignId);
      }
    }
    const resolve = <T extends { amazonCampaignId: string; amazonAdGroupId: string | null }>(
      items: Array<Pending<T>>,
    ): T[] =>
      items.flatMap(({ record, position }) => {
        const amazonCampaignId =
          record.amazonCampaignId ??
          (record.amazonAdGroupId === null
            ? undefined
            : campaignOfAdGroup.get(record.amazonAdGroupId));
        if (amazonCampaignId === undefined) {
          this.invalid(position, 'campaignId', 'Kampagne nicht auflösbar');
          return [];
        }
        return [{ ...record, amazonCampaignId } as T];
      });

    const records: BulkRecords = {
      portfolios: this.portfolios,
      campaigns,
      adGroups: this.adGroups,
      targets: resolve(this.targets),
      negatives: resolve(this.negatives),
      productAds: resolve(this.productAds),
    };

    if (this.invalidRows > 0) {
      this.logger({ level: 'warn', msg: 'bulk_import.invalid_rows', count: this.invalidRows });
    }
    const total = Object.values(records).reduce((count, list) => count + list.length, 0);
    if (total === 0) {
      throw new FileImportRejectedError(
        this.invalidRows > 0
          ? `Keine Zeile der Bulk-Datei ist gültig (${this.invalidRows} ungültig, Details im Log).`
          : 'Die Bulk-Datei enthält keine Portfolios, Kampagnen, Ad Groups, Targets oder Anzeigen.',
      );
    }
    return records;
  }

  private invalid(position: RowPosition, column: BulkColumn, reason: string): void {
    this.invalidRows += 1;
    if (this.loggedInvalid >= MAX_INVALID_ROW_LOGS) return;
    this.loggedInvalid += 1;
    this.logger({
      level: 'warn',
      msg: 'bulk_import.invalid_row',
      ...position,
      column: columnLabel(column),
      reason,
    });
  }

  /** Unbekannter Wert: je Spalte und Wert einmal, ohne den Wert selbst (Zellinhalt). */
  private unknownValue(position: RowPosition, field: BulkColumn, value: string): void {
    this.once(`value\u0000${field}\u0000${value.toLowerCase()}`, () =>
      this.logger({ level: 'warn', msg: 'bulk_import.unknown_value', ...position, field }),
    );
  }

  private once(key: string, log: () => void): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    log();
  }
}

const uniqueCount = <T>(records: readonly T[], idOf: (record: T) => string) =>
  new Set(records.map(idOf)).size;

const sum = (counts: EntityUpsertCounts[], key: keyof EntityUpsertCounts) =>
  counts.reduce((total, count) => total + count[key], 0);
