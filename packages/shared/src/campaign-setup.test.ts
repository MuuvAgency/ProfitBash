import { describe, expect, it } from 'vitest';
import {
  MAX_SETUP_CAMPAIGNS,
  MAX_SETUP_TARGETS_PER_CAMPAIGN,
  plannedCampaignSchema,
  saveCampaignSetupDraftSchema,
  setupInputsSchema,
  sourceNegativeSchema,
  type PlannedCampaign,
} from './campaign-setup';

const campaign: PlannedCampaign = {
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
  targets: [
    { type: 'keyword', text: 'trinkflasche', matchType: 'exact', bid: '0.90' },
    { type: 'product', asin: 'B0FREMD001', match: 'expanded', bid: '0.50' },
    { type: 'category', categoryId: '12345', name: 'Trinkflaschen', bid: '0.40' },
    { type: 'audience', audience: 'views', lookbackDays: 30, bid: '0.60' },
  ],
  negatives: [
    { type: 'keyword', text: 'glas', matchType: 'negativePhrase' },
    { type: 'product', asin: 'B0FREMD002', matchType: 'negativeExact' },
  ],
};

describe('plannedCampaignSchema', () => {
  it('nimmt eine Kampagne des Plans an', () => {
    expect(plannedCampaignSchema.parse(campaign)).toEqual(campaign);
  });

  it('lehnt Beträge ohne Decimal-Form, unbekannte Felder und kaputte ASINs ab', () => {
    for (const broken of [
      { ...campaign, dailyBudget: '25,00' },
      { ...campaign, dailyBudget: 25 },
      { ...campaign, adGroup: { ...campaign.adGroup, defaultBid: '0.855' } },
      { ...campaign, extra: true },
      { ...campaign, ads: [{ asin: 'kurz', sku: null }] },
      { ...campaign, state: 'ARCHIVED' },
      { ...campaign, targets: Array(MAX_SETUP_TARGETS_PER_CAMPAIGN + 1).fill(campaign.targets[0]) },
    ]) {
      expect(plannedCampaignSchema.safeParse(broken).success).toBe(false);
    }
  });
});

describe('plannedTargetSchema (Sponsored Display, 4.9)', () => {
  it('nimmt Zielgruppen nur mit Rückblicken an, die Amazon kennt', () => {
    const audience = (lookbackDays: number) => ({
      ...campaign,
      targets: [{ type: 'audience', audience: 'views', lookbackDays, bid: '0.50' }],
    });
    expect(plannedCampaignSchema.safeParse(audience(30)).success).toBe(true);
    expect(plannedCampaignSchema.safeParse(audience(45)).success).toBe(false);
  });
});

describe('saveCampaignSetupDraftSchema', () => {
  const inputs = setupInputsSchema.parse({});

  it('nimmt einen Entwurf mit Vorgaben an', () => {
    const parsed = saveCampaignSetupDraftSchema.parse({
      profileId: '00000000-0000-4000-8000-000000000001',
      productGroupId: null,
      presetKey: 'muuv-standard',
      name: '  Flaschen   Start ',
      campaignState: 'PAUSED',
      inputs,
      campaigns: [campaign],
    });
    expect(parsed.name).toBe('Flaschen Start');
    expect(inputs).toEqual({
      keywords: [],
      brandTerms: [],
      productTargets: [],
      categories: [],
      harvest: [],
      unlocks: {},
      creative: null,
    });
    expect(parsed.sourceNegatives).toEqual([]);
  });

  it('begrenzt die Zahl der Kampagnen', () => {
    const result = saveCampaignSetupDraftSchema.safeParse({
      profileId: '00000000-0000-4000-8000-000000000001',
      productGroupId: null,
      presetKey: 'muuv-standard',
      name: 'x',
      campaignState: 'ENABLED',
      inputs,
      campaigns: Array(MAX_SETUP_CAMPAIGNS + 1).fill(campaign),
    });
    expect(result.success).toBe(false);
  });
});

describe('sourceNegativeSchema', () => {
  it('nimmt Amazon-IDs als Strings jeder Länge bis 64 Zeichen (Demo-IDs haben 22 Ziffern)', () => {
    const parsed = sourceNegativeSchema.safeParse({
      markId: '00000000-0000-4000-8000-000000000001',
      searchTerm: 'heringe alu',
      amazonCampaignId: '7100000000000001000006',
      amazonAdGroupId: '7100000000000001000007',
      campaignName: 'SP Waldkauz Zeltheringe Auto 1',
      adGroupName: 'Zeltheringe 1',
      negative: { type: 'keyword', text: 'heringe alu', matchType: 'negativeExact' },
      selected: true,
    });
    expect(parsed.success).toBe(true);
  });
});
