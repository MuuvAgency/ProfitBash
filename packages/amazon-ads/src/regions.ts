/**
 * Endpunkte je Amazon-Ads-Region. Geprüft am 2026-09-26 gegen die Amazon-Ads-Doku:
 * - Authorize: https://advertising.amazon.com/API/docs/en-us/guides/get-started/create-authorization-grant
 *   (Präfix bestimmt, bei welcher regionalen Amazon-Seite sich der Nutzer anmeldet)
 * - Token: https://advertising.amazon.com/API/docs/en-us/guides/get-started/retrieve-access-token
 * - API-Hosts: https://advertising.amazon.com/API/docs/en-us/reference/api-overview
 * - LWA-Profil (`user_id`, `email`, `name`; Scope `profile`): Login-with-Amazon-Doku „Obtain Customer
 *   Profile Information“. Die Ads-Doku empfiehlt den Aufruf nach dem Code-Tausch, um das verbundene
 *   Konto zu erkennen. Tokens gelten regionsübergreifend; wir nutzen den Host der Region.
 */

export const AMAZON_ADS_REGION_KEYS = ['eu', 'na', 'fe'] as const;
export type AmazonAdsRegion = (typeof AMAZON_ADS_REGION_KEYS)[number];

export interface AmazonAdsRegionEndpoints {
  /** LWA-Einwilligungsseite */
  authorizeUrl: string;
  /** LWA-Token-Endpunkt (Code-Tausch und Refresh) */
  tokenUrl: string;
  /** LWA-Nutzerprofil (Identität des verbundenen Amazon-Kontos) */
  userProfileUrl: string;
  /** Host der Amazon Ads API */
  apiHost: string;
}

export const AMAZON_ADS_REGIONS: Readonly<Record<AmazonAdsRegion, AmazonAdsRegionEndpoints>> = {
  eu: {
    authorizeUrl: 'https://eu.account.amazon.com/ap/oa',
    tokenUrl: 'https://api.amazon.co.uk/auth/o2/token',
    userProfileUrl: 'https://api.amazon.co.uk/user/profile',
    apiHost: 'https://advertising-api-eu.amazon.com',
  },
  na: {
    authorizeUrl: 'https://www.amazon.com/ap/oa',
    tokenUrl: 'https://api.amazon.com/auth/o2/token',
    userProfileUrl: 'https://api.amazon.com/user/profile',
    apiHost: 'https://advertising-api.amazon.com',
  },
  fe: {
    authorizeUrl: 'https://apac.account.amazon.com/ap/oa',
    tokenUrl: 'https://api.amazon.co.jp/auth/o2/token',
    userProfileUrl: 'https://api.amazon.co.jp/user/profile',
    apiHost: 'https://advertising-api-fe.amazon.com',
  },
};
