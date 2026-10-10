import type {
  CampaignSetupItemEntity,
  CampaignSetupItemPayload,
  CampaignSetupPlacement,
  CampaignSetupState,
  PlannedCampaign,
  SourceNegative,
} from '@profitbash/shared/campaign-setup';

/**
 * Anlagen einer Übermittlung aus dem Plan eines Entwurfs (`docs/tasks/phase-4.md` 4.4), ohne I/O: je Kampagne die
 * Kampagne, ihre Gebotsanpassungen (nur Platzierungen über 0 %), die Ad Group, Anzeigen, Targets und Negatives, Eltern
 * vor Kindern. Kampagne und Ad Group tragen ihren Namen als vorläufige Text-ID (Bulk-Datei); über den Namen ordnet der
 * nächste Bulk-Import die echten IDs zu.
 *
 * Phase 4 legt zuerst nur Sponsored Products an (F1): SB- und SD-Kampagnen erscheinen als Kampagne mit
 * `supported: false` (die Übermittlung meldet sie als nicht angelegt) und ohne Kinder.
 *
 * Gewählte Negatives in der Quelle eines Harvest-Begriffs (4.6, F7) stehen am Ende: Sie gehören zu bestehenden
 * Kampagnen und nennen deren echte IDs; `campaignRef` und `adGroupRef` sind dort nur die Namen zur Anzeige.
 */

export interface SetupItemSpec {
  entityType: CampaignSetupItemEntity;
  campaignRef: string;
  adGroupRef: string | null;
  supported: boolean;
  payload: CampaignSetupItemPayload;
}

const PLACEMENTS: readonly [
  keyof NonNullable<PlannedCampaign['placements']>,
  CampaignSetupPlacement,
][] = [
  ['topOfSearch', 'PLACEMENT_TOP'],
  ['productPages', 'PLACEMENT_PRODUCT_PAGE'],
  ['restOfSearch', 'PLACEMENT_REST_OF_SEARCH'],
];

export function planSetupItems(
  campaigns: readonly PlannedCampaign[],
  options: {
    campaignState: CampaignSetupState;
    sourceNegatives?: readonly SourceNegative[];
    /** Bestehendes Portfolio des Entwurfs für alle neuen Kampagnen (4.7, F9). */
    amazonPortfolioId?: string | null;
  },
): SetupItemSpec[] {
  const items: SetupItemSpec[] = [];
  for (const campaign of campaigns) {
    const supported = campaign.adProduct === 'SP';
    const campaignRef = campaign.name;
    items.push({
      entityType: 'campaign',
      campaignRef,
      adGroupRef: null,
      supported,
      payload: {
        entity: 'campaign',
        adProduct: campaign.adProduct,
        name: campaign.name,
        targetingType: campaign.targeting === 'auto' ? 'auto' : 'manual',
        state: options.campaignState,
        dailyBudget: campaign.dailyBudget,
        currencyCode: campaign.currencyCode,
        biddingStrategy: campaign.biddingStrategy,
        offAmazon: campaign.offAmazon,
        amazonPortfolioId: options.amazonPortfolioId ?? null,
      },
    });
    if (!supported) continue;

    const onCampaign = (payload: CampaignSetupItemPayload) =>
      items.push({ entityType: payload.entity, campaignRef, adGroupRef: null, supported, payload });
    for (const [key, placement] of PLACEMENTS) {
      const percentage = campaign.placements?.[key] ?? 0;
      if (percentage > 0) onCampaign({ entity: 'placement', placement, percentage });
    }

    const adGroupRef = campaign.adGroup.name;
    const child = (payload: CampaignSetupItemPayload) =>
      items.push({ entityType: payload.entity, campaignRef, adGroupRef, supported, payload });
    child({
      entity: 'ad_group',
      name: campaign.adGroup.name,
      defaultBid: campaign.adGroup.defaultBid,
    });
    for (const ad of campaign.ads) child({ entity: 'product_ad', asin: ad.asin, sku: ad.sku });
    for (const target of campaign.targets) {
      switch (target.type) {
        case 'keyword':
          child({
            entity: 'keyword',
            text: target.text,
            matchType: target.matchType,
            bid: target.bid,
          });
          break;
        case 'product':
          child({
            entity: 'product_target',
            expression: {
              type: target.match === 'expanded' ? 'asinExpanded' : 'asin',
              value: target.asin,
            },
            bid: target.bid,
          });
          break;
        case 'category':
          child({
            entity: 'product_target',
            expression: { type: 'category', value: target.categoryId },
            bid: target.bid,
          });
          break;
        case 'audience':
          // Zielgruppen gibt es nur bei Sponsored Display (4.9).
          break;
      }
    }
    for (const negative of campaign.negatives) {
      child(
        negative.type === 'keyword'
          ? { entity: 'negative_keyword', text: negative.text, matchType: negative.matchType }
          : { entity: 'negative_product_target', asin: negative.asin },
      );
    }
  }
  for (const source of options.sourceNegatives ?? []) {
    if (!source.selected) continue;
    items.push({
      entityType: 'source_negative',
      campaignRef: source.campaignName,
      adGroupRef: source.adGroupName,
      supported: true,
      payload: {
        entity: 'source_negative',
        amazonCampaignId: source.amazonCampaignId,
        amazonAdGroupId: source.amazonAdGroupId,
        negative: source.negative,
        harvestMarkId: source.markId,
      },
    });
  }
  return items;
}
