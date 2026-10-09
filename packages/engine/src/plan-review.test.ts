import type { PlannedCampaign } from '@profitbash/shared/campaign-setup';
import { describe, expect, it } from 'vitest';
import type { AdChangeLimitLookup } from './ad-changes';
import { reviewCampaignPlan, type PlanReviewInput } from './plan-review';

/**
 * Prüfung eines gespeicherten (und vielleicht von Hand geänderten) Plans vor dem Übermitteln (`phase-4.md` 4.4):
 * Grenzen von Amazon, Dubletten im Profil und im Plan, Pflichtangaben.
 */

const campaign = (overrides: Partial<PlannedCampaign> = {}): PlannedCampaign => ({
  block: 'SP-KW-EXACT',
  adProduct: 'SP',
  targeting: 'keyword',
  name: 'SP | EXACT | Flaschen',
  state: 'ENABLED',
  currencyCode: 'EUR',
  dailyBudget: '25.00',
  biddingStrategy: 'SALES_DOWN_ONLY',
  sdOptimization: null,
  costType: 'cpc',
  offAmazon: false,
  placements: { topOfSearch: 20, productPages: 0, restOfSearch: 0 },
  adGroup: { name: 'SP | EXACT | Flaschen', defaultBid: '0.85' },
  ads: [{ asin: 'B0FLASCHE1', sku: 'FL-750' }],
  targets: [{ type: 'keyword', text: 'trinkflasche', matchType: 'exact', bid: '0.90' }],
  negatives: [],
  ...overrides,
});

const limits: AdChangeLimitLookup = ({ field }) =>
  field === 'budget' ? { min: '1.00', max: '1000000.00' } : { min: '0.02', max: '1000.00' };

const input = (overrides: Partial<PlanReviewInput> = {}): PlanReviewInput => ({
  campaigns: [campaign()],
  profile: { countryCode: 'DE', currencyCode: 'EUR', accountType: 'seller' },
  existing: { campaignNames: [], exactKeywords: [] },
  limitFor: limits,
  ...overrides,
});

describe('reviewCampaignPlan', () => {
  it('meldet nichts bei einem gültigen Plan', () => {
    expect(reviewCampaignPlan(input())).toEqual([]);
  });

  it('erkennt Kampagnennamen, die es im Profil oder im Plan schon gibt (ohne Groß/Klein)', () => {
    const issues = reviewCampaignPlan(
      input({
        campaigns: [
          campaign(),
          campaign({ name: 'sp | exact | flaschen' }),
          campaign({ name: 'Neu' }),
        ],
        existing: { campaignNames: ['Neu'], exactKeywords: [] },
      }),
    );
    expect(issues).toEqual([
      { severity: 'error', code: 'campaignNameDuplicate', campaign: 'sp | exact | flaschen' },
      { severity: 'error', code: 'campaignNameTaken', campaign: 'Neu' },
    ]);
  });

  it('prüft Namen gegen Länge und Zeichen des Kontos', () => {
    const issues = reviewCampaignPlan(
      input({
        campaigns: [campaign({ name: 'x'.repeat(120), ads: [{ asin: 'B0FLASCHE1', sku: null }] })],
        profile: { countryCode: 'DE', currencyCode: 'EUR', accountType: 'vendor' },
      }),
    );
    expect(issues).toEqual([
      {
        severity: 'error',
        code: 'campaignNameInvalid',
        campaign: 'x'.repeat(120),
        issue: 'tooLong',
      },
    ]);
    expect(reviewCampaignPlan(input({ campaigns: [campaign({ name: 'SP · AUTO' })] }))).toEqual([
      {
        severity: 'error',
        code: 'campaignNameInvalid',
        campaign: 'SP · AUTO',
        issue: 'invalidCharacters',
      },
    ]);
  });

  it('prüft Budget, Standardgebot und Gebote gegen die Grenzen von Amazon', () => {
    const issues = reviewCampaignPlan(
      input({
        campaigns: [
          campaign({
            dailyBudget: '0.50',
            adGroup: { name: 'x', defaultBid: '0.01' },
            targets: [
              { type: 'keyword', text: 'trinkflasche', matchType: 'exact', bid: '1500.00' },
            ],
          }),
        ],
      }),
    );
    expect(issues.map((issue) => [issue.code, 'value' in issue && issue.value])).toEqual([
      ['budgetOutOfRange', '0.50'],
      ['bidOutOfRange', '0.01'],
      ['bidOutOfRange', '1500.00'],
    ]);
  });

  it('prüft Keywords und Negatives gegen Wortzahl und Länge', () => {
    const long = Array(11).fill('wort').join(' ');
    const issues = reviewCampaignPlan(
      input({
        campaigns: [
          campaign({
            targets: [{ type: 'keyword', text: long, matchType: 'broad', bid: '0.50' }],
            negatives: [
              { type: 'keyword', text: 'eins zwei drei vier fünf', matchType: 'negativePhrase' },
              { type: 'keyword', text: 'eins zwei drei vier fünf', matchType: 'negativeExact' },
            ],
          }),
        ],
      }),
    );
    expect(issues).toEqual([
      { severity: 'error', code: 'keywordTooLong', keyword: long },
      { severity: 'error', code: 'keywordTooLong', keyword: 'eins zwei drei vier fünf' },
    ]);
  });

  it('verlangt Anzeigen, bei Sellern mit SKU, und Ziele außer bei Auto-Kampagnen', () => {
    const issues = reviewCampaignPlan(
      input({
        campaigns: [
          campaign({ name: 'A', ads: [], targets: [] }),
          campaign({ name: 'B', ads: [{ asin: 'B0FLASCHE2', sku: null }] }),
          campaign({ name: 'C', targeting: 'auto', targets: [] }),
        ],
      }),
    );
    expect(issues).toEqual([
      { severity: 'error', code: 'noAds', campaign: 'A' },
      { severity: 'error', code: 'noTargets', campaign: 'A' },
      { severity: 'error', code: 'missingSku', asin: 'B0FLASCHE2' },
    ]);
  });

  it('verlangt die Währung des Profils', () => {
    expect(reviewCampaignPlan(input({ campaigns: [campaign({ currencyCode: 'GBP' })] }))).toEqual([
      { severity: 'error', code: 'currencyMismatch', campaign: 'SP | EXACT | Flaschen' },
    ]);
  });

  it('warnt vor Keywords, die im Profil schon exakt gebucht sind', () => {
    const issues = reviewCampaignPlan(
      input({
        existing: {
          campaignNames: [],
          exactKeywords: [{ text: 'Trinkflasche', campaignName: 'Alt' }],
        },
      }),
    );
    expect(issues).toEqual([
      {
        severity: 'warning',
        code: 'keywordAlreadyExact',
        keyword: 'trinkflasche',
        existing: 'Alt',
      },
    ]);
  });

  it('hält die Leitplanken für vCPM und Off-Amazon ein (F-S7)', () => {
    const issues = reviewCampaignPlan(
      input({
        campaigns: [
          campaign({ name: 'A', costType: 'vcpm' }),
          campaign({ name: 'B', offAmazon: true }),
          campaign({
            name: 'C',
            adProduct: 'SD',
            targeting: 'audience',
            biddingStrategy: null,
            placements: null,
            sdOptimization: 'clicks',
            offAmazon: true,
            targets: [{ type: 'audience', audience: 'views', lookbackDays: 30, bid: '0.50' }],
          }),
        ],
      }),
    );
    expect(issues).toEqual([
      { severity: 'error', code: 'vcpmNotAvailable', campaign: 'A' },
      { severity: 'warning', code: 'offAmazonUnlocked', campaign: 'B' },
      // Off-Amazon lässt sich nur in den USA einstellen (Bulk-Guide); sonst gilt Amazons Standard.
      { severity: 'info', code: 'offAmazonOnlyUs', campaign: 'B' },
      { severity: 'error', code: 'offAmazonNotAvailable', campaign: 'C' },
      { severity: 'info', code: 'adProductLater', campaign: 'C' },
    ]);
  });
});
