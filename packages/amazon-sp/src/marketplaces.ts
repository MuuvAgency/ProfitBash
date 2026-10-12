import type { AmazonAdsRegion } from '@profitbash/amazon-ads';
import { AMAZON_MARKETPLACES, type AmazonMarketplace } from '@profitbash/shared';

/** Marktplatz aus `@profitbash/shared`, ergänzt um das, was nur die SP-API braucht. */
export interface AmazonSpMarketplace extends AmazonMarketplace {
  region: AmazonAdsRegion;
  /** Seller Central des Marktplatzes (Einwilligung der Public App, 7.2b). */
  sellerCentralUrl: string;
}

const EUROPE = 'https://sellercentral-europe.amazon.com';

/** Geprüft am 2026-10-12 gegen „Seller Central URLs“ der SP-API-Doku. */
const SELLER_CENTRAL: Readonly<Record<string, [AmazonAdsRegion, string]>> = {
  DE: ['eu', EUROPE],
  FR: ['eu', EUROPE],
  IT: ['eu', EUROPE],
  ES: ['eu', EUROPE],
  UK: ['eu', EUROPE],
  NL: ['eu', 'https://sellercentral.amazon.nl'],
  BE: ['eu', 'https://sellercentral.amazon.com.be'],
  IE: ['eu', 'https://sellercentral.amazon.ie'],
  SE: ['eu', 'https://sellercentral.amazon.se'],
  PL: ['eu', 'https://sellercentral.amazon.pl'],
  TR: ['eu', 'https://sellercentral.amazon.com.tr'],
  US: ['na', 'https://sellercentral.amazon.com'],
  CA: ['na', 'https://sellercentral.amazon.ca'],
};

/** `undefined` für Marktplätze, die ProfitBash (noch) nicht kennt, z. B. Japan. */
export function spMarketplaceFor(marketplaceId: string): AmazonSpMarketplace | undefined {
  const marketplace = AMAZON_MARKETPLACES.find((m) => m.marketplaceId === marketplaceId);
  const entry = marketplace && SELLER_CENTRAL[marketplace.countryCode];
  if (!marketplace || !entry) return undefined;
  return { ...marketplace, region: entry[0], sellerCentralUrl: entry[1] };
}
