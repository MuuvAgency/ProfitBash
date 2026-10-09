import { MAX_NEGATIVE_KEYWORD_LENGTH, normalizeNegativeKeywordText } from '@profitbash/shared';
import type { AdChangeInputData, SearchTermRowData } from '../api/client';

/**
 * Aktionen auf Suchbegriffe (`phase-3.md` 3.8, F9), ohne I/O: aus markierten Zeilen der Analyse werden Negatives für
 * den Warenkorb bzw. die Begriffe für die Harvest-Merkliste. Geprüft (schon vorhanden, geschützt, Grenzen von
 * Amazon) wird im Server; hier fällt nur weg, was sich gar nicht senden lässt.
 */

export type NegativeLevel = 'adGroup' | 'campaign';
export type NegativeMatchType = 'EXACT' | 'PHRASE';

export interface NegativeOptions {
  /** Ad Group der Zeile (Standard) oder ihre Kampagne. */
  level: NegativeLevel;
  matchType: NegativeMatchType;
  /** Geschützte Begriffe des Clients trotzdem negieren; ohne Bestätigung bleiben sie weg. */
  confirmProtected: boolean;
}

export type NegativeSourceRow = Pick<
  SearchTermRowData,
  'searchTerm' | 'campaignId' | 'adGroupId' | 'protected'
>;

/** Suchbegriffe von Produkt-Targets sind ASINs (in den Blättern klein geschrieben). */
export function isAsinSearchTerm(searchTerm: string): boolean {
  return /^b0[a-z0-9]{8}$/i.test(searchTerm.trim());
}

/** Vergleichsform wie im Server (`comparableSearchTerm`): klein, NFC, Leerraum zusammengefasst. */
const comparable = (searchTerm: string) =>
  normalizeNegativeKeywordText(searchTerm).toLocaleLowerCase();

export interface NegativeInputs {
  inputs: AdChangeInputData[];
  /** Zeilen, die nicht mitgehen: Entity im Profil unbekannt, geschützt ohne Bestätigung, Begriff zu lang. */
  skipped: { noEntity: number; protected: number; tooLong: number };
}

/** Negatives für den Warenkorb; dieselbe Stelle (Kampagne bzw. Ad Group und Begriff) nur einmal. */
export function negativeInputs(
  rows: readonly NegativeSourceRow[],
  options: NegativeOptions,
): NegativeInputs {
  const inputs: AdChangeInputData[] = [];
  const skipped = { noEntity: 0, protected: 0, tooLong: 0 };
  const seen = new Set<string>();
  for (const row of rows) {
    const adGroupId = options.level === 'campaign' ? null : row.adGroupId;
    if (row.campaignId === null || (options.level === 'adGroup' && adGroupId === null)) {
      skipped.noEntity += 1;
      continue;
    }
    if (row.protected && !options.confirmProtected) {
      skipped.protected += 1;
      continue;
    }
    const keywordText = normalizeNegativeKeywordText(row.searchTerm);
    const asin = isAsinSearchTerm(row.searchTerm);
    if (!asin && (keywordText === '' || keywordText.length > MAX_NEGATIVE_KEYWORD_LENGTH)) {
      skipped.tooLong += 1;
      continue;
    }
    const place = `${row.campaignId}:${adGroupId ?? ''}:${comparable(row.searchTerm)}`;
    if (seen.has(place)) continue;
    seen.add(place);
    inputs.push({
      operation: 'create_negative',
      campaignId: row.campaignId,
      adGroupId,
      negative: asin
        ? { type: 'product', asin: keywordText.toUpperCase() }
        : { type: 'keyword', keywordText, matchType: options.matchType },
      ...(row.protected && { confirmProtected: true }),
    });
  }
  return { inputs, skipped };
}

/** Verschiedene Suchbegriffe der Zeilen für die Merkliste, in der Schreibweise der ersten Zeile. */
export function harvestTerms(rows: readonly Pick<SearchTermRowData, 'searchTerm'>[]): string[] {
  const terms = new Map<string, string>();
  for (const row of rows) {
    const key = comparable(row.searchTerm);
    if (!terms.has(key)) terms.set(key, row.searchTerm);
  }
  return [...terms.values()];
}
