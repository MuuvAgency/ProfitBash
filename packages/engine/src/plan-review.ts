import type { PlannedCampaign } from '@profitbash/shared/campaign-setup';
import {
  NEGATIVE_KEYWORD_MAX_LENGTH,
  NEGATIVE_KEYWORD_MAX_WORDS,
  type AdChangeLimitLookup,
} from './ad-changes';
import { Dec } from './decimal';
import { campaignNameIssues, campaignNameMaxLength } from './naming';

/**
 * Prüfung eines gespeicherten Plans vor dem Übermitteln (`docs/tasks/phase-4.md` 4.4), ohne I/O. Ein Entwurf kann
 * seit dem Planen geändert worden sein (Gebote, Namen, gestrichene Ziele) und das Profil auch (neue Kampagnen):
 * Deshalb prüft das Übermitteln den gespeicherten Plan erneut, in der Transaktion und mit dem aktuellen Stand.
 *
 * - `error` sperrt das Übermitteln: Name im Profil oder im Plan schon vergeben, Name ungültig, Grenzen von Amazon,
 *   Keyword zu lang, fehlende Anzeige, SKU oder Ziele, fremde Währung, Leitplanken nach F-S7 verletzt.
 * - `warning`: Keyword schon exakt gebucht, Off-Amazon freigeschaltet.
 * - `info`: Off-Amazon nur in den USA einstellbar; SB und SD legt Phase 4 erst mit 4.9/4.10 an.
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
}

export type PlanReviewIssue =
  | { severity: 'error'; code: 'campaignNameTaken' | 'campaignNameDuplicate'; campaign: string }
  | { severity: 'error'; code: 'campaignNameInvalid'; campaign: string; issue: string }
  | {
      severity: 'error';
      code:
        | 'currencyMismatch'
        | 'vcpmNotAvailable'
        | 'offAmazonNotAvailable'
        | 'noAds'
        | 'noTargets'
        | 'autoWithTargets';
      campaign: string;
    }
  | { severity: 'error'; code: 'adGroupNameInvalid'; campaign: string; issue: string }
  | { severity: 'error'; code: 'duplicateTarget'; campaign: string; target: string }
  | { severity: 'error'; code: 'missingSku'; asin: string }
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
  | { severity: 'info'; code: 'offAmazonOnlyUs' | 'adProductLater'; campaign: string };

const AD_PRODUCT = { SP: 'SPONSORED_PRODUCTS', SB: 'SPONSORED_BRANDS', SD: 'SPONSORED_DISPLAY' };
/** Positive Keywords: höchstens 10 Wörter (Limits-Seite), wie negative exakt. */
const MAX_WORDS = {
  keyword: NEGATIVE_KEYWORD_MAX_WORDS.EXACT,
  negativeExact: NEGATIVE_KEYWORD_MAX_WORDS.EXACT,
  negativePhrase: NEGATIVE_KEYWORD_MAX_WORDS.PHRASE,
};
const tooLong = (text: string, maxWords: number) =>
  text.split(/\s+/u).length > maxWords || [...text].length > NEGATIVE_KEYWORD_MAX_LENGTH;

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
    if (campaign.costType === 'vcpm' && campaign.adProduct === 'SP') {
      add({ severity: 'error', code: 'vcpmNotAvailable', campaign: name });
    }
    if (campaign.offAmazon) {
      if (campaign.adProduct !== 'SP') {
        add({ severity: 'error', code: 'offAmazonNotAvailable', campaign: name });
      } else {
        add({ severity: 'warning', code: 'offAmazonUnlocked', campaign: name });
        if (input.profile.countryCode !== 'US') {
          add({ severity: 'info', code: 'offAmazonOnlyUs', campaign: name });
        }
      }
    }
    if (campaign.adProduct !== 'SP')
      add({ severity: 'info', code: 'adProductLater', campaign: name });

    if (campaign.ads.length === 0) add({ severity: 'error', code: 'noAds', campaign: name });
    if (campaign.adProduct === 'SP' && input.profile.accountType === 'seller') {
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
  return issues;
}
