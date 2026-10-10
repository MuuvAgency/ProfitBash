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
        unlocks: { 'SP-KW-EXACT': { vcpm: true, offAmazon: true } },
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
    ]);
  });

  it('sperrt vCPM und Off-Amazon, die der Entwurf nicht für den Baustein freigeschaltet hat (F-S7)', () => {
    const sd = campaign({
      name: 'SD',
      block: 'SD-RT-VIEWS',
      adProduct: 'SD',
      targeting: 'audience',
      biddingStrategy: null,
      placements: null,
      sdOptimization: 'clicks',
      costType: 'vcpm',
      targets: [{ type: 'audience', audience: 'views', lookbackDays: 30, bid: '5.00' }],
    });
    const sp = campaign({ name: 'SP', offAmazon: true });
    expect(reviewCampaignPlan(input({ campaigns: [sd, sp] }))).toEqual([
      { severity: 'error', code: 'vcpmNotUnlocked', campaign: 'SD' },
      { severity: 'error', code: 'offAmazonNotUnlocked', campaign: 'SP' },
      { severity: 'warning', code: 'offAmazonUnlocked', campaign: 'SP' },
      { severity: 'info', code: 'offAmazonOnlyUs', campaign: 'SP' },
    ]);
    expect(
      reviewCampaignPlan(input({ campaigns: [sd], unlocks: { 'SD-RT-VIEWS': { vcpm: true } } })),
    ).toEqual([]);
  });

  it('kennt bei Sponsored Display keine Keywords', () => {
    expect(
      reviewCampaignPlan(
        input({
          campaigns: [
            campaign({
              name: 'SD',
              adProduct: 'SD',
              biddingStrategy: null,
              placements: null,
              sdOptimization: 'clicks',
            }),
          ],
        }),
      ),
    ).toContainEqual({ severity: 'error', code: 'keywordNotSd', campaign: 'SD' });
  });

  describe('Sponsored Brands (4.10)', () => {
    const asins = ['B0FLASCHE1', 'B0FLASCHE2', 'B0FLASCHE3'];
    const sb = (overrides: Partial<PlannedCampaign> = {}) =>
      campaign({
        name: 'SB | HEADER',
        block: 'SB-HEADER-KW',
        adProduct: 'SB',
        biddingStrategy: null,
        placements: null,
        sbAdFormat: 'collection',
        ads: asins.map((asin) => ({ asin, sku: null })),
        ...overrides,
      });
    const creative = {
      brandEntityId: 'ENTITY1',
      brandName: 'Waldkauz',
      logoAssetId: null,
      videoAssetId: null,
      adTitle: null,
    };

    it('nimmt eine Kollektion mit 3 Produkten und Marke an', () => {
      expect(reviewCampaignPlan(input({ campaigns: [sb()], creative }))).toEqual([]);
    });

    it('verlangt Werbemittel, bei Sellern die Marke, 3–10 Produkte und beim Video Video-ID, ein Produkt und den Marktplatz', () => {
      const video = sb({
        name: 'SB | VIDEO',
        block: 'SB-VIDEO-KW',
        sbAdFormat: 'video',
        ads: [{ asin: 'B0FLASCHE1', sku: null }, { asin: 'B0FLASCHE2', sku: null }],
      });
      expect(reviewCampaignPlan(input({ campaigns: [sb()] }))).toEqual([
        { severity: 'error', code: 'sbCreativeMissing', campaign: 'SB | HEADER' },
      ]);
      expect(
        reviewCampaignPlan(
          input({
            profile: { countryCode: 'FR', currencyCode: 'EUR', accountType: 'seller' },
            campaigns: [sb({ ads: [{ asin: 'B0FLASCHE1', sku: null }] }), video],
            creative: { ...creative, brandEntityId: null },
          }),
        ),
      ).toEqual([
        { severity: 'error', code: 'sbBrandEntityMissing' },
        { severity: 'error', code: 'sbCollectionAsins', campaign: 'SB | HEADER', count: 1 },
        { severity: 'error', code: 'sbVideoMissing', campaign: 'SB | VIDEO' },
        { severity: 'error', code: 'sbVideoOneProduct', campaign: 'SB | VIDEO' },
        { severity: 'error', code: 'sbVideoNotAvailable', campaign: 'SB | VIDEO' },
      ]);
    });

    it('braucht bei Vendoren keine Marken-ID und kennt kein Format ohne Baustein', () => {
      expect(
        reviewCampaignPlan(
          input({
            profile: { countryCode: 'DE', currencyCode: 'EUR', accountType: 'vendor' },
            campaigns: [sb({ sbAdFormat: undefined })],
            creative: { ...creative, brandEntityId: null },
          }),
        ),
      ).toEqual([{ severity: 'error', code: 'sbFormatMissing', campaign: 'SB | HEADER' }]);
    });
  });

  it('prüft Sponsored Display wie Sponsored Products (SKU, kein „ähnlich wie“)', () => {
    const sd = {
      adProduct: 'SD' as const,
      targeting: 'product' as const,
      biddingStrategy: null,
      placements: null,
      sdOptimization: 'clicks' as const,
    };
    const issues = reviewCampaignPlan(
      input({
        profile: { countryCode: 'DE', currencyCode: 'EUR', accountType: 'seller' },
        campaigns: [
          campaign({
            name: 'SD',
            ...sd,
            ads: [{ asin: 'B0FLASCHE9', sku: null }],
            targets: [
              { type: 'product', asin: 'B0FREMD001', match: 'exact', bid: '0.50' },
              // „Ähnlich wie“ gibt es nur bei Sponsored Products.
              { type: 'product', asin: 'B0FREMD002', match: 'expanded', bid: '0.50' },
            ],
          }),
        ],
      }),
    );
    expect(issues).toEqual([
      // Auch Display bewirbt bei Sellern über die SKU (Guide „Product ad“).
      { severity: 'error', code: 'missingSku', asin: 'B0FLASCHE9' },
      { severity: 'error', code: 'expandedNotAvailable', campaign: 'SD', target: 'B0FREMD002' },
    ]);
  });

  it('meldet Namen nur aus Ziffern, Auto-Kampagnen mit Zielen, doppelte Ziele und ungültige Ad-Group-Namen', () => {
    const issues = reviewCampaignPlan(
      input({
        campaigns: [
          campaign({ name: '12345' }),
          campaign({
            name: 'Auto',
            targeting: 'auto',
            targets: [{ type: 'keyword', text: 'x', matchType: 'broad', bid: '0.50' }],
          }),
          campaign({
            name: 'Doppelt',
            adGroup: { name: 'Gruppe · 1', defaultBid: '0.85' },
            targets: [
              { type: 'keyword', text: 'Flasche', matchType: 'exact', bid: '0.50' },
              { type: 'keyword', text: 'flasche', matchType: 'exact', bid: '0.60' },
            ],
            negatives: [
              { type: 'product', asin: 'B0FREMD002', matchType: 'negativeExact' },
              { type: 'product', asin: 'B0FREMD002', matchType: 'negativeExact' },
            ],
          }),
        ],
      }),
    );
    expect(issues).toEqual([
      { severity: 'error', code: 'campaignNameInvalid', campaign: '12345', issue: 'onlyDigits' },
      { severity: 'error', code: 'autoWithTargets', campaign: 'Auto' },
      {
        severity: 'error',
        code: 'adGroupNameInvalid',
        campaign: 'Doppelt',
        issue: 'invalidCharacters',
      },
      { severity: 'error', code: 'duplicateTarget', campaign: 'Doppelt', target: 'flasche' },
      { severity: 'error', code: 'duplicateTarget', campaign: 'Doppelt', target: 'B0FREMD002' },
    ]);
  });

  describe('Negatives in der Quelle (4.6)', () => {
    const source = {
      markId: '00000000-0000-4000-8000-000000000001',
      searchTerm: 'trinkflasche 1l',
      amazonCampaignId: '111',
      amazonAdGroupId: '222',
      campaignName: 'SP | AUTO | Flaschen',
      adGroupName: 'Auto',
      negative: { type: 'keyword', text: 'trinkflasche 1l', matchType: 'negativeExact' },
      selected: true,
    } as const;
    const sourceAdGroups = new Set(['111:222']);

    const planned = [
      campaign({
        targets: [{ type: 'keyword', text: 'trinkflasche 1l', matchType: 'exact', bid: '0.90' }],
      }),
    ];

    it('nimmt gültige gewählte Negatives an', () => {
      expect(
        reviewCampaignPlan(
          input({
            campaigns: planned,
            sourceNegatives: [source],
            protectedTerms: [],
            sourceAdGroups,
          }),
        ),
      ).toEqual([]);
    });

    it('sperrt Negatives, deren Begriff der Plan nicht als Sponsored Products anlegt', () => {
      expect(
        reviewCampaignPlan(
          input({
            campaigns: [campaign(), { ...planned[0]!, adProduct: 'SB', name: 'SB' }],
            sourceNegatives: [source],
            protectedTerms: [],
            sourceAdGroups,
          }),
        ),
      ).toContainEqual({
        severity: 'error',
        code: 'sourceNegativeNotPlanned',
        campaign: 'SP | AUTO | Flaschen',
        target: 'trinkflasche 1l',
      });
    });

    it('sperrt geschützte Begriffe, fehlende Quellen und Dubletten, abgewählte zählen nicht', () => {
      const issues = reviewCampaignPlan(
        input({
          campaigns: [
            campaign({
              targets: [
                { type: 'keyword', text: 'trinkflasche 1l', matchType: 'exact', bid: '0.90' },
                { type: 'keyword', text: 'nordwind becher', matchType: 'exact', bid: '0.90' },
              ],
            }),
          ],
          sourceNegatives: [
            source,
            source,
            { ...source, amazonAdGroupId: '999' },
            {
              ...source,
              negative: { type: 'keyword', text: 'nordwind becher', matchType: 'negativeExact' },
            },
            {
              ...source,
              selected: false,
              negative: { type: 'keyword', text: 'nordwind tasse', matchType: 'negativeExact' },
            },
          ],
          protectedTerms: ['Nordwind'],
          sourceAdGroups,
        }),
      );
      expect(issues).toEqual([
        {
          severity: 'error',
          code: 'duplicateTarget',
          campaign: 'SP | AUTO | Flaschen',
          target: 'trinkflasche 1l',
        },
        {
          severity: 'error',
          code: 'sourceNegativeMissing',
          campaign: 'SP | AUTO | Flaschen',
          target: 'trinkflasche 1l',
        },
        { severity: 'error', code: 'sourceNegativeProtected', keyword: 'nordwind becher' },
      ]);
    });
  });

  it('sperrt ein Portfolio, das es im Profil nicht mehr gibt (4.7)', () => {
    expect(reviewCampaignPlan(input({ portfolioMissing: true }))).toEqual([
      { severity: 'error', code: 'portfolioMissing' },
    ]);
  });
});
