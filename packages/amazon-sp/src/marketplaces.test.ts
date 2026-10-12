import { AMAZON_MARKETPLACES } from '@profitbash/shared';
import { describe, expect, it } from 'vitest';
import { spMarketplaceFor } from './marketplaces';
import { AMAZON_SP_REGIONS } from './regions';

describe('spMarketplaceFor', () => {
  it('ergänzt die bekannten Marktplätze um Region und Seller-Central-Adresse', () => {
    expect(spMarketplaceFor('A1PA6795UKMFR9')).toEqual({
      countryCode: 'DE',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      marketplaceId: 'A1PA6795UKMFR9',
      region: 'eu',
      sellerCentralUrl: 'https://sellercentral-europe.amazon.com',
    });
    expect(spMarketplaceFor('A1805IZSGTT6HS')?.sellerCentralUrl).toBe(
      'https://sellercentral.amazon.nl',
    );
    expect(spMarketplaceFor('ATVPDKIKX0DER')).toMatchObject({
      region: 'na',
      sellerCentralUrl: 'https://sellercentral.amazon.com',
    });
  });

  it('kennt jeden Marktplatz aus @profitbash/shared und keinen unbekannten', () => {
    for (const marketplace of AMAZON_MARKETPLACES) {
      const sp = spMarketplaceFor(marketplace.marketplaceId);
      expect(sp, marketplace.countryCode).toBeDefined();
      expect(AMAZON_SP_REGIONS[sp!.region].apiHost).toMatch(/^https:\/\/sellingpartnerapi-/);
    }
    expect(spMarketplaceFor('A0UNBEKANNT')).toBeUndefined();
  });
});
