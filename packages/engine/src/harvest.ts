import type { PlannedCampaign, SourceNegative } from '@profitbash/shared/campaign-setup';
import { Dec } from './decimal';
import { comparableSearchTerm, createProtectedTermMatcher } from './search-terms';

/**
 * Harvest von der Merkliste (`docs/tasks/phase-4.md` 4.6, F7, F8), ohne I/O.
 *
 * - **Eingaben:** Gewählte Einträge der Merkliste werden zu Keywords bzw. (ASIN-Suchbegriffe) zu Produkt-Zielen des
 *   Setups; das Preset entscheidet wie bei allen Eingaben, wohin sie kommen. Gebot: Eingabe vor CPC der Merkliste
 *   (Kosten ÷ Klicks zum Zeitpunkt des Vormerkens, half-even auf zwei Stellen, nur in der Währung des Profils), sonst
 *   gilt der Baustein.
 * - **Negativ in der Quelle:** je Begriff negativ exakt in der Ad Group, aus der er kam (Zeile mit dem höchsten Spend),
 *   vorbelegt und abwählbar. Nie für geschützte Begriffe; nicht, wenn die Quelle fehlt, kein Sponsored Products ist,
 *   den Begriff schon negiert oder ihn selbst exakt bucht, und nicht, wenn der Plan den Begriff gar nicht anlegt
 *   (sonst ginge der Traffic verloren).
 */

export interface HarvestMarkSource {
  id: string;
  searchTerm: string;
  /** Ad-Typ der Quelle (`SPONSORED_PRODUCTS` …). */
  adProduct: string;
  amazonCampaignId: string;
  amazonAdGroupId: string;
  /** `null`, wenn Kampagne bzw. Ad Group im Profil fehlen (entfernt). */
  campaignName: string | null;
  adGroupName: string | null;
  /** Keyword-Target der Quelle, sonst `null` (Auto, Produkt-Target). */
  sourceKeyword: { text: string; matchType: string } | null;
  clicks: number;
  cost: string;
  currencyCode: string;
  /** Der Begriff ist in der Ad Group der Quelle schon negativ exakt. */
  alreadyNegative: boolean;
}

export interface HarvestSelection {
  markId: string;
  single?: boolean | undefined;
  bid?: string | undefined;
}

export type HarvestHint =
  | { severity: 'warning'; code: 'harvestMarkMissing'; markId: string }
  | {
      severity: 'info';
      code:
        | 'sourceProtected'
        | 'sourceMissing'
        | 'sourceNotSp'
        | 'sourceAlreadyNegative'
        | 'sourceIsExact'
        | 'sourceNotPlanned';
      keyword: string;
    };

/** Suchbegriffe von Produkt-Targets sind ASINs (in den Berichten klein geschrieben). */
export function isAsinSearchTerm(searchTerm: string): boolean {
  return /^b0[a-z0-9]{8}$/i.test(searchTerm.trim());
}

/** CPC der Merkliste (Kosten ÷ Klicks, half-even auf zwei Stellen); `null` ohne Klicks bzw. Kosten. */
export function harvestCpc(clicks: number, cost: string): string | null {
  const amount = new Dec(cost);
  if (clicks <= 0 || amount.lte(0)) return null;
  return amount.div(clicks).toDecimalPlaces(2, Dec.ROUND_HALF_EVEN).toFixed(2);
}

/** CPC als Gebot (F8), nur in der Währung des Profils. */
function cpc(mark: HarvestMarkSource, currencyCode: string): string | undefined {
  if (mark.currencyCode !== currencyCode) return undefined;
  return harvestCpc(mark.clicks, mark.cost) ?? undefined;
}

export function harvestInputs(input: {
  marks: readonly HarvestMarkSource[];
  selections: readonly HarvestSelection[];
  /** Währung des Profils. */
  currencyCode: string;
}): {
  keywords: { text: string; single?: boolean; bid?: string }[];
  productTargets: { asin: string; single?: boolean; bid?: string }[];
  hints: HarvestHint[];
} {
  const byId = new Map(input.marks.map((mark) => [mark.id, mark]));
  const keywords: { text: string; single?: boolean; bid?: string }[] = [];
  const productTargets: { asin: string; single?: boolean; bid?: string }[] = [];
  const hints: HarvestHint[] = [];
  for (const selection of input.selections) {
    const mark = byId.get(selection.markId);
    if (!mark) {
      hints.push({ severity: 'warning', code: 'harvestMarkMissing', markId: selection.markId });
      continue;
    }
    const bid = selection.bid ?? cpc(mark, input.currencyCode);
    const extra = {
      ...(bid !== undefined && { bid }),
      ...(selection.single && { single: true }),
    };
    if (isAsinSearchTerm(mark.searchTerm)) {
      productTargets.push({ asin: mark.searchTerm.trim().toUpperCase(), ...extra });
    } else {
      keywords.push({ text: comparableSearchTerm(mark.searchTerm), ...extra });
    }
  }
  return { keywords, productTargets, hints };
}

export function planSourceNegatives(input: {
  marks: readonly HarvestMarkSource[];
  /** Der Plan des Setups (nur Begriffe, die er anlegt, werden in der Quelle negiert). */
  campaigns: readonly PlannedCampaign[];
  /** Geschützte Begriffe des Clients. */
  protectedTerms: readonly string[];
  /** Vom Nutzer abgewählte Vorschläge (IDs der Merkliste), bleiben beim neuen Planen abgewählt. */
  deselected?: readonly string[];
}): { sourceNegatives: SourceNegative[]; hints: HarvestHint[] } {
  const isProtected = createProtectedTermMatcher(input.protectedTerms);
  const deselected = new Set(input.deselected ?? []);
  const plannedKeywords = new Set<string>();
  const plannedAsins = new Set<string>();
  for (const campaign of input.campaigns) {
    for (const target of campaign.targets) {
      if (target.type === 'keyword') plannedKeywords.add(comparableSearchTerm(target.text));
      if (target.type === 'product') plannedAsins.add(target.asin.toUpperCase());
    }
  }

  const sourceNegatives: SourceNegative[] = [];
  const hints: HarvestHint[] = [];
  const skip = (code: Extract<HarvestHint, { severity: 'info' }>['code'], keyword: string) =>
    hints.push({ severity: 'info', code, keyword });
  for (const mark of input.marks) {
    const term = comparableSearchTerm(mark.searchTerm);
    const asin = isAsinSearchTerm(mark.searchTerm) ? mark.searchTerm.trim().toUpperCase() : null;
    if (isProtected(mark.searchTerm)) skip('sourceProtected', mark.searchTerm);
    else if (mark.campaignName === null || mark.adGroupName === null)
      skip('sourceMissing', mark.searchTerm);
    else if (mark.adProduct !== 'SPONSORED_PRODUCTS') skip('sourceNotSp', mark.searchTerm);
    else if (mark.alreadyNegative) skip('sourceAlreadyNegative', mark.searchTerm);
    else if (
      mark.sourceKeyword !== null &&
      mark.sourceKeyword.matchType.toUpperCase() === 'EXACT' &&
      comparableSearchTerm(mark.sourceKeyword.text) === term
    )
      skip('sourceIsExact', mark.searchTerm);
    else if (asin !== null ? !plannedAsins.has(asin) : !plannedKeywords.has(term))
      skip('sourceNotPlanned', mark.searchTerm);
    else {
      sourceNegatives.push({
        markId: mark.id,
        searchTerm: mark.searchTerm,
        amazonCampaignId: mark.amazonCampaignId,
        amazonAdGroupId: mark.amazonAdGroupId,
        campaignName: mark.campaignName,
        adGroupName: mark.adGroupName,
        negative:
          asin !== null
            ? { type: 'product', asin, matchType: 'negativeExact' }
            : { type: 'keyword', text: term, matchType: 'negativeExact' },
        selected: !deselected.has(mark.id),
      });
    }
  }
  return { sourceNegatives, hints };
}
