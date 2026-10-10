import type {
  PlannedCampaign,
  SbCreative,
  SourceNegative,
} from '@profitbash/shared/campaign-setup';
import {
  NEGATIVE_KEYWORD_MAX_LENGTH,
  NEGATIVE_KEYWORD_MAX_WORDS,
  type AdChangeLimitLookup,
} from './ad-changes';
import { Dec } from './decimal';
import { campaignNameIssues, campaignNameMaxLength } from './naming';
import { plannedSpTerms } from './harvest';
import { comparableSearchTerm, createProtectedTermMatcher } from './search-terms';

/**
 * Prüfung eines gespeicherten Plans vor dem Übermitteln (`docs/tasks/phase-4.md` 4.4), ohne I/O. Ein Entwurf kann
 * seit dem Planen geändert worden sein (Gebote, Namen, gestrichene Ziele) und das Profil auch (neue Kampagnen):
 * Deshalb prüft das Übermitteln den gespeicherten Plan erneut, in der Transaktion und mit dem aktuellen Stand.
 *
 * - `error` sperrt das Übermitteln: Name im Profil oder im Plan schon vergeben, Name ungültig, Grenzen von Amazon,
 *   Keyword zu lang, fehlende Anzeige, SKU oder Ziele, fremde Währung, Leitplanken nach F-S7 verletzt.
 * - `warning`: Keyword schon exakt gebucht, Off-Amazon freigeschaltet.
 * - `info`: Off-Amazon nur in den USA einstellbar.
 *
 * Sponsored Brands (4.10): Werbemittel des Entwurfs, bei Sellern die Marke, Kollektion mit 3–10 Produkten, Video mit
 * Video-ID, genau einem Produkt und nur in den USA, in UK und DE (Guide).
 *
 * Gewählte Negatives in der Quelle (4.6, F7): Die Ad Group der Quelle muss als SP-Ad-Group im Profil bestehen,
 * geschützte Begriffe sperren (der Vorschlag nennt sie nie, ein geänderter Entwurf könnte es), Dubletten auch, und
 * der Plan muss den Begriff als Sponsored-Products-Ziel anlegen (sonst verlöre die Quelle den Traffic ohne Ersatz).
 */

export interface PlanReviewInput {
  campaigns: readonly PlannedCampaign[];
  profile: { countryCode: string; currencyCode: string; accountType: string };
  /** Was es im Profil schon gibt, dazu Kampagnen offener Übermittlungen des Setups. */
  existing: {
    campaignNames: readonly string[];
    exactKeywords: readonly { text: string; campaignName: string }[];
  };
  limitFor: AdChangeLimitLookup;
  /** Negatives in der Quelle des Entwurfs (nur gewählte werden geprüft). */
  sourceNegatives?: readonly SourceNegative[];
  /** Geschützte Begriffe des Clients. */
  protectedTerms?: readonly string[];
  /** Bestehende SP-Ad-Groups des Profils als `amazonCampaignId:amazonAdGroupId`. */
  sourceAdGroups?: ReadonlySet<string>;
  /** Das Portfolio des Entwurfs gibt es im Profil nicht mehr (4.7). */
  portfolioMissing?: boolean;
  /**
   * Freischaltungen je Baustein aus den Eingaben des Entwurfs (F-S7): vCPM bzw. Off-Amazon im gespeicherten Plan
   * ohne Freischaltung sperren (der Plan kommt vom Client und könnte sie sonst einfach setzen).
   */
  unlocks?: Readonly<Record<string, { vcpm?: boolean; offAmazon?: boolean }>>;
  /** Werbemittel des Entwurfs für Sponsored Brands (4.10). */
  creative?: SbCreative | null;
}

export type PlanReviewIssue =
  | { severity: 'error'; code: 'campaignNameTaken' | 'campaignNameDuplicate'; campaign: string }
  | { severity: 'error'; code: 'campaignNameInvalid'; campaign: string; issue: string }
  | {
      severity: 'error';
      code:
        | 'currencyMismatch'
        | 'vcpmNotAvailable'
        | 'vcpmNotUnlocked'
        | 'offAmazonNotAvailable'
        | 'offAmazonNotUnlocked'
        | 'keywordNotSd'
        | 'noAds'
        | 'noTargets'
        | 'autoWithTargets';
      campaign: string;
    }
  | { severity: 'error'; code: 'adGroupNameInvalid'; campaign: string; issue: string }
  | {
      severity: 'error';
      code: 'duplicateTarget' | 'expandedNotAvailable';
      campaign: string;
      target: string;
    }
  | { severity: 'error'; code: 'missingSku'; asin: string }
  | { severity: 'error'; code: 'portfolioMissing' | 'sbBrandEntityMissing' }
  | {
      severity: 'error';
      code:
        | 'sbCreativeMissing'
        | 'sbFormatMissing'
        | 'sbVideoMissing'
        | 'sbVideoOneProduct'
        | 'sbVideoNotAvailable';
      campaign: string;
    }
  | { severity: 'error'; code: 'sbCollectionAsins'; campaign: string; count: number }
  | {
      severity: 'error';
      code: 'sourceNegativeMissing' | 'sourceNegativeNotPlanned';
      campaign: string;
      target: string;
    }
  | { severity: 'error'; code: 'sourceNegativeProtected'; keyword: string }
  | {
      severity: 'error';
      code: 'bidOutOfRange' | 'budgetOutOfRange';
      campaign: string;
      value: string;
      min: string;
      max: string;
    }
  | { severity: 'error'; code: 'keywordTooLong'; keyword: string }
  | { severity: 'warning'; code: 'keywordAlreadyExact'; keyword: string; existing: string }
  | { severity: 'warning'; code: 'offAmazonUnlocked'; campaign: string }
  | { severity: 'info'; code: 'offAmazonOnlyUs'; campaign: string };

const AD_PRODUCT = { SP: 'SPONSORED_PRODUCTS', SB: 'SPONSORED_BRANDS', SD: 'SPONSORED_DISPLAY' };
/** Positive Keywords: höchstens 10 Wörter (Limits-Seite), wie negative exakt. */
const MAX_WORDS = {
  keyword: NEGATIVE_KEYWORD_MAX_WORDS.EXACT,
  negativeExact: NEGATIVE_KEYWORD_MAX_WORDS.EXACT,
  negativePhrase: NEGATIVE_KEYWORD_MAX_WORDS.PHRASE,
};
const tooLong = (text: string, maxWords: number) =>
  text.split(/\s+/u).length > maxWords || [...text].length > NEGATIVE_KEYWORD_MAX_LENGTH;

/** Sponsored Brands (Guide): Kollektion mit 3–10 Produkten, Video nur in den USA, in UK und DE. */
const SB_COLLECTION_ASINS = { min: 3, max: 10 };
const SB_VIDEO_COUNTRIES: ReadonlySet<string> = new Set(['US', 'UK', 'GB', 'DE']);

/** Ad-Group-Namen: höchstens 255 Zeichen (Limits-Seite), dieselben Zeichen wie Kampagnennamen. */
const MAX_AD_GROUP_NAME_LENGTH = 255;

function targetKey(target: PlannedCampaign['targets'][number]): { key: string; label: string } {
  switch (target.type) {
    case 'keyword':
      return { key: `kw:${target.matchType}:${target.text.toLowerCase()}`, label: target.text };
    case 'product':
      return { key: `asin:${target.match}:${target.asin}`, label: target.asin };
    case 'category':
      return { key: `cat:${target.categoryId}`, label: target.name || target.categoryId };
    case 'audience':
      return {
        key: `aud:${target.audience}:${target.lookbackDays}`,
        label: `${target.audience} ${target.lookbackDays}`,
      };
  }
}

export function reviewCampaignPlan(input: PlanReviewInput): PlanReviewIssue[] {
  const issues: PlanReviewIssue[] = [];
  const seen = new Set<string>();
  const add = (issue: PlanReviewIssue) => {
    const key = JSON.stringify(issue);
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };
  if (input.portfolioMissing) add({ severity: 'error', code: 'portfolioMissing' });
  // Sponsored Brands (4.10): Marke der Seller einmal je Entwurf.
  const creative = input.creative ?? null;
  if (
    creative !== null &&
    creative.brandEntityId === null &&
    input.profile.accountType === 'seller' &&
    input.campaigns.some((campaign) => campaign.adProduct === 'SB')
  ) {
    add({ severity: 'error', code: 'sbBrandEntityMissing' });
  }
  const maxNameLength = campaignNameMaxLength(input.profile.accountType);
  const taken = new Set(input.existing.campaignNames.map((name) => name.toLowerCase()));
  const planned = new Set<string>();
  const exactInProfile = new Map(
    input.existing.exactKeywords.map((keyword) => [
      keyword.text.toLowerCase(),
      keyword.campaignName,
    ]),
  );

  for (const campaign of input.campaigns) {
    const name = campaign.name;
    const lower = name.toLowerCase();
    if (planned.has(lower))
      add({ severity: 'error', code: 'campaignNameDuplicate', campaign: name });
    else if (taken.has(lower))
      add({ severity: 'error', code: 'campaignNameTaken', campaign: name });
    planned.add(lower);
    for (const issue of campaignNameIssues(name, maxNameLength)) {
      add({ severity: 'error', code: 'campaignNameInvalid', campaign: name, issue });
    }
    if (campaign.currencyCode !== input.profile.currencyCode) {
      add({ severity: 'error', code: 'currencyMismatch', campaign: name });
    }

    // Leitplanken (F-S7): vCPM nur SB/SD, Off-Amazon nur SP.
    const unlock = input.unlocks?.[campaign.block] ?? {};
    if (campaign.costType === 'vcpm' && campaign.adProduct === 'SP') {
      add({ severity: 'error', code: 'vcpmNotAvailable', campaign: name });
    } else if (campaign.costType === 'vcpm' && !unlock.vcpm) {
      add({ severity: 'error', code: 'vcpmNotUnlocked', campaign: name });
    }
    if (campaign.offAmazon) {
      if (campaign.adProduct !== 'SP') {
        add({ severity: 'error', code: 'offAmazonNotAvailable', campaign: name });
      } else {
        if (!unlock.offAmazon)
          add({ severity: 'error', code: 'offAmazonNotUnlocked', campaign: name });
        add({ severity: 'warning', code: 'offAmazonUnlocked', campaign: name });
        if (input.profile.countryCode !== 'US') {
          add({ severity: 'info', code: 'offAmazonOnlyUs', campaign: name });
        }
      }
    }
    if (campaign.adProduct === 'SB') {
      if (creative === null) add({ severity: 'error', code: 'sbCreativeMissing', campaign: name });
      if (campaign.sbAdFormat === undefined) {
        add({ severity: 'error', code: 'sbFormatMissing', campaign: name });
      } else if (campaign.sbAdFormat === 'collection') {
        const count = campaign.ads.length;
        if (count < SB_COLLECTION_ASINS.min || count > SB_COLLECTION_ASINS.max) {
          add({ severity: 'error', code: 'sbCollectionAsins', campaign: name, count });
        }
      } else {
        if (creative !== null && creative.videoAssetId === null) {
          add({ severity: 'error', code: 'sbVideoMissing', campaign: name });
        }
        if (campaign.ads.length !== 1)
          add({ severity: 'error', code: 'sbVideoOneProduct', campaign: name });
        if (!SB_VIDEO_COUNTRIES.has(input.profile.countryCode)) {
          add({ severity: 'error', code: 'sbVideoNotAvailable', campaign: name });
        }
      }
    }
    // Sponsored Display kennt keine Keywords (Guide, Spec).
    if (
      campaign.adProduct === 'SD' &&
      (campaign.targeting === 'keyword' || campaign.targets.some((t) => t.type === 'keyword'))
    ) {
      add({ severity: 'error', code: 'keywordNotSd', campaign: name });
    }

    if (campaign.ads.length === 0) add({ severity: 'error', code: 'noAds', campaign: name });
    // SP und SD bewerben bei Sellern über die SKU (SB über die ASIN).
    if (campaign.adProduct !== 'SB' && input.profile.accountType === 'seller') {
      for (const ad of campaign.ads) {
        if (ad.sku === null) add({ severity: 'error', code: 'missingSku', asin: ad.asin });
      }
    }
    if (campaign.targeting !== 'auto' && campaign.targets.length === 0) {
      add({ severity: 'error', code: 'noTargets', campaign: name });
    }
    // Auto-Kampagnen zielen selbst; Keywords und Produkt-Targets darunter lehnt Amazon ab.
    if (campaign.targeting === 'auto' && campaign.targets.length > 0) {
      add({ severity: 'error', code: 'autoWithTargets', campaign: name });
    }
    for (const issue of campaignNameIssues(campaign.adGroup.name, MAX_AD_GROUP_NAME_LENGTH)) {
      add({ severity: 'error', code: 'adGroupNameInvalid', campaign: name, issue });
    }

    const check = (field: 'bid' | 'default_bid' | 'budget', value: string) => {
      const limit = input.limitFor({
        adProduct: AD_PRODUCT[campaign.adProduct],
        countryCode: input.profile.countryCode,
        field,
        costType: campaign.costType,
      });
      if (!limit) return;
      const amount = new Dec(value);
      if (amount.lt(limit.min) || amount.gt(limit.max)) {
        add({
          severity: 'error',
          code: field === 'budget' ? 'budgetOutOfRange' : 'bidOutOfRange',
          campaign: name,
          value,
          min: limit.min,
          max: limit.max,
        });
      }
    };
    check('budget', campaign.dailyBudget);
    check('default_bid', campaign.adGroup.defaultBid);
    for (const target of campaign.targets) check('bid', target.bid);

    for (const target of campaign.targets) {
      // `asin-expanded` gibt es nur bei Sponsored Products (Bulk-Guides, SD-Spec ohne „expanded“).
      if (target.type === 'product' && target.match === 'expanded' && campaign.adProduct !== 'SP') {
        add({
          severity: 'error',
          code: 'expandedNotAvailable',
          campaign: name,
          target: target.asin,
        });
      }
      if (target.type !== 'keyword') continue;
      if (tooLong(target.text, MAX_WORDS.keyword)) {
        add({ severity: 'error', code: 'keywordTooLong', keyword: target.text });
      }
      const existing = exactInProfile.get(target.text.toLowerCase());
      if (target.matchType === 'exact' && existing !== undefined) {
        add({ severity: 'warning', code: 'keywordAlreadyExact', keyword: target.text, existing });
      }
    }
    for (const negative of campaign.negatives) {
      if (negative.type === 'keyword' && tooLong(negative.text, MAX_WORDS[negative.matchType])) {
        add({ severity: 'error', code: 'keywordTooLong', keyword: negative.text });
      }
    }
    // Dasselbe Ziel bzw. Negative zweimal in einer Ad Group (ohne Groß/Klein): Amazon nimmt es nur einmal an.
    const keys = new Set<string>();
    const entries = [
      ...campaign.targets.map(targetKey),
      ...campaign.negatives.map((negative) =>
        negative.type === 'keyword'
          ? {
              key: `-kw:${negative.matchType}:${negative.text.toLowerCase()}`,
              label: negative.text,
            }
          : { key: `-asin:${negative.asin}`, label: negative.asin },
      ),
    ];
    for (const { key, label } of entries) {
      if (keys.has(key)) {
        add({ severity: 'error', code: 'duplicateTarget', campaign: name, target: label });
      }
      keys.add(key);
    }
  }

  const isProtected = createProtectedTermMatcher(input.protectedTerms ?? []);
  const plannedTerms = plannedSpTerms(input.campaigns);
  const sourceKeys = new Set<string>();
  for (const source of input.sourceNegatives ?? []) {
    if (!source.selected) continue;
    const negative = source.negative;
    const label = negative.type === 'keyword' ? negative.text : negative.asin;
    const key = `${source.amazonAdGroupId}:${negative.type}:${negative.matchType}:${label.toLowerCase()}`;
    const campaign = source.campaignName;
    if (sourceKeys.has(key)) {
      add({ severity: 'error', code: 'duplicateTarget', campaign, target: label });
      continue;
    }
    sourceKeys.add(key);
    if (!input.sourceAdGroups?.has(`${source.amazonCampaignId}:${source.amazonAdGroupId}`)) {
      add({ severity: 'error', code: 'sourceNegativeMissing', campaign, target: label });
    }
    const isPlanned =
      negative.type === 'keyword'
        ? plannedTerms.keywords.has(comparableSearchTerm(negative.text))
        : plannedTerms.asins.has(negative.asin.toUpperCase());
    if (!isPlanned) {
      add({ severity: 'error', code: 'sourceNegativeNotPlanned', campaign, target: label });
    }
    if (isProtected(label))
      add({ severity: 'error', code: 'sourceNegativeProtected', keyword: label });
    if (negative.type === 'keyword' && tooLong(negative.text, MAX_WORDS[negative.matchType])) {
      add({ severity: 'error', code: 'keywordTooLong', keyword: negative.text });
    }
  }
  return issues;
}
