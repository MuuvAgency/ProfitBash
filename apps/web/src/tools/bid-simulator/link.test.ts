import { describe, expect, it } from 'vitest';
import { simulatorLink, simulatorStateFromQuery } from './link';

/** Aufruf des Gebots-Stack-Simulators aus dem Explorer (`phase-4.md` 4.8, F12). */

describe('simulatorLink', () => {
  it('übernimmt Strategie, Platzierungen, Amazon Business und Währung einer Kampagne', () => {
    expect(
      simulatorLink({
        name: 'SP | EXACT | Flaschen',
        attributes: {
          biddingStrategy: 'SALES_UP_AND_DOWN',
          budgetCurrencyCode: 'EUR',
          placementBidAdjustments: [
            { placement: 'PLACEMENT_TOP', percentage: 50 },
            { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: '10' },
            { placement: 'SITE_AMAZON_BUSINESS', percentage: 100 },
          ],
        },
      }),
    ).toEqual({
      path: '/ads/tools/bid-simulator',
      query: {
        name: 'SP | EXACT | Flaschen',
        strategy: 'SALES_UP_AND_DOWN',
        currency: 'EUR',
        top: '50',
        pp: '10',
        ros: '0',
        ab: '100',
      },
    });
  });
});

describe('simulatorStateFromQuery', () => {
  it('liest gültige Werte und fällt sonst auf Vorgaben zurück', () => {
    expect(
      simulatorStateFromQuery({ strategy: 'NONE', top: '25', pp: 'x', ab: '950', currency: 'eur' }),
    ).toEqual({
      name: null,
      bid: '1.00',
      strategy: 'NONE',
      currency: null,
      top: 25,
      productPages: 0,
      restOfSearch: 0,
      amazonBusiness: null,
    });
    expect(simulatorStateFromQuery({})).toMatchObject({ strategy: 'SALES_DOWN_ONLY' });
  });
});
