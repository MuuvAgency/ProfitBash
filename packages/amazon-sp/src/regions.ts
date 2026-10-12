import type { AmazonAdsRegion } from '@profitbash/amazon-ads';

/**
 * Endpunkte der SP-API je Region. Geprüft am 2026-10-12 gegen die Doku („SP-API Endpoints“, „Connect to
 * the SP-API“): ein API-Host je Region; das LwA-Token kommt für alle Regionen von `api.amazon.com`
 * (anders als bei der Ads-API). Die Regionen heißen wie bei Ads (`eu`, `na`, `fe`).
 */
export interface AmazonSpRegionEndpoints {
  apiHost: string;
  tokenUrl: string;
}

const TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

export const AMAZON_SP_REGIONS: Readonly<Record<AmazonAdsRegion, AmazonSpRegionEndpoints>> = {
  eu: { apiHost: 'https://sellingpartnerapi-eu.amazon.com', tokenUrl: TOKEN_URL },
  na: { apiHost: 'https://sellingpartnerapi-na.amazon.com', tokenUrl: TOKEN_URL },
  fe: { apiHost: 'https://sellingpartnerapi-fe.amazon.com', tokenUrl: TOKEN_URL },
};
