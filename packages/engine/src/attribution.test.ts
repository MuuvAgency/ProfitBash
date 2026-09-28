import { describe, expect, it } from 'vitest';
import {
  AD_PRODUCTS,
  selectAttribution,
  summarizeAttribution,
  type AdProduct,
  type AttributionSelection,
  type MetricsLevel,
} from './attribution';

const select = (
  adProduct: AdProduct,
  level: MetricsLevel,
  setting: 'console' | 'clicks14d',
  accountType = 'seller',
) => selectAttribution({ adProduct, level, accountType, setting });

/** Die gewählten Spalten ohne Grundlage, für kompakte Erwartungen. */
const columns = ({ basis: _basis, sameSkuBasis: _sameSkuBasis, ...rest }: AttributionSelection) =>
  rest;

describe('selectAttribution – wie Konsole', () => {
  it('SP: 7 Tage nach Klick bei Sellern, inkl. Same-SKU', () => {
    const selection = select('SPONSORED_PRODUCTS', 'campaign', 'console', 'seller');
    expect(selection.basis).toEqual({ windowDays: 7, views: false });
    expect(selection.sameSkuBasis).toEqual({ windowDays: 7, views: false });
    expect(columns(selection)).toEqual({
      sales: 'sales7d',
      purchases: 'purchases7d',
      units: 'units7d',
      salesSameSku: 'salesSameSku7d',
      purchasesSameSku: 'purchasesSameSku7d',
      unitsSameSku: 'unitsSameSku7d',
    });
  });

  it('SP: 7 Tage auch bei Agency-Profilen (Annahme, 1.10 prüft) und unbekannten Kontotypen', () => {
    expect(select('SPONSORED_PRODUCTS', 'target', 'console', 'agency').sales).toBe('sales7d');
    expect(select('SPONSORED_PRODUCTS', 'target', 'console', 'brandRegistry').sales).toBe(
      'sales7d',
    );
  });

  it('SP: 14 Tage nach Klick bei Vendoren', () => {
    const selection = select('SPONSORED_PRODUCTS', 'productAd', 'console', 'vendor');
    expect(selection.basis).toEqual({ windowDays: 14, views: false });
    expect(columns(selection)).toEqual({
      sales: 'sales14d',
      purchases: 'purchases14d',
      units: 'units14d',
      salesSameSku: 'salesSameSku14d',
      purchasesSameSku: 'purchasesSameSku14d',
      unitsSameSku: 'unitsSameSku14d',
    });
  });

  it('SB: 14 Tage inkl. Views, Same-SKU ebenso inkl. Views, ohne Same-SKU-Einheiten', () => {
    const selection = select('SPONSORED_BRANDS', 'campaign', 'console');
    expect(selection.basis).toEqual({ windowDays: 14, views: true });
    expect(selection.sameSkuBasis).toEqual({ windowDays: 14, views: true });
    expect(columns(selection)).toEqual({
      sales: 'sales14d',
      purchases: 'purchases14d',
      units: 'units14d',
      salesSameSku: 'salesSameSku14d',
      purchasesSameSku: 'purchasesSameSku14d',
      unitsSameSku: null,
    });
  });

  it('SB-Suchbegriffe: Same-SKU fehlt', () => {
    const selection = select('SPONSORED_BRANDS', 'searchTerm', 'console');
    expect(selection.sales).toBe('sales14d');
    expect(selection.salesSameSku).toBeNull();
    expect(selection.purchasesSameSku).toBeNull();
  });

  it('SD: 14 Tage inkl. Views, Same-SKU aber nur nach Klick', () => {
    const selection = select('SPONSORED_DISPLAY', 'adGroup', 'console');
    expect(selection.basis).toEqual({ windowDays: 14, views: true });
    expect(selection.sameSkuBasis).toEqual({ windowDays: 14, views: false });
    expect(columns(selection)).toEqual({
      sales: 'sales14d',
      purchases: 'purchases14d',
      units: 'units14d',
      salesSameSku: 'salesSameSku14d',
      purchasesSameSku: 'purchasesSameSku14d',
      unitsSameSku: null,
    });
  });
});

describe('selectAttribution – 14 Tage, nur Klicks', () => {
  it('SP: die 14-Tage-Spalten (dort ohnehin nur Klicks)', () => {
    const selection = select('SPONSORED_PRODUCTS', 'searchTerm', 'clicks14d', 'seller');
    expect(selection.basis).toEqual({ windowDays: 14, views: false });
    expect(selection.sales).toBe('sales14d');
    expect(selection.unitsSameSku).toBe('unitsSameSku14d');
  });

  it('SB: Klick-Anteil, Same-SKU fehlt (Amazon liefert es nur inkl. Views)', () => {
    const selection = select('SPONSORED_BRANDS', 'productAd', 'clicks14d');
    expect(selection.basis).toEqual({ windowDays: 14, views: false });
    expect(selection.sameSkuBasis).toBeNull();
    expect(columns(selection)).toEqual({
      sales: 'salesClicks14d',
      purchases: 'purchasesClicks14d',
      units: 'unitsClicks14d',
      salesSameSku: null,
      purchasesSameSku: null,
      unitsSameSku: null,
    });
  });

  it('SB-Targets und -Suchbegriffe: Einheiten nach Klick fehlen', () => {
    expect(select('SPONSORED_BRANDS', 'target', 'clicks14d').units).toBeNull();
    expect(select('SPONSORED_BRANDS', 'searchTerm', 'clicks14d').units).toBeNull();
    expect(select('SPONSORED_BRANDS', 'target', 'clicks14d').sales).toBe('salesClicks14d');
  });

  it('SD: Klick-Anteil, Same-SKU (nur Klick) bleibt', () => {
    const selection = select('SPONSORED_DISPLAY', 'target', 'clicks14d');
    expect(selection.basis).toEqual({ windowDays: 14, views: false });
    expect(selection.sameSkuBasis).toEqual({ windowDays: 14, views: false });
    expect(columns(selection)).toEqual({
      sales: 'salesClicks14d',
      purchases: 'purchasesClicks14d',
      units: 'unitsClicks14d',
      salesSameSku: 'salesSameSku14d',
      purchasesSameSku: 'purchasesSameSku14d',
      unitsSameSku: null,
    });
  });

  it('SD-Suchbegriffe: kein Report, alle Werte fehlen', () => {
    expect(columns(select('SPONSORED_DISPLAY', 'searchTerm', 'clicks14d'))).toEqual({
      sales: null,
      purchases: null,
      units: null,
      salesSameSku: null,
      purchasesSameSku: null,
      unitsSameSku: null,
    });
  });
});

describe('summarizeAttribution', () => {
  it('meldet keine gemischte Attribution bei gleicher Grundlage', () => {
    const summary = summarizeAttribution([
      select('SPONSORED_PRODUCTS', 'campaign', 'console', 'seller'),
      select('SPONSORED_PRODUCTS', 'campaign', 'console', 'agency'),
    ]);
    expect(summary.mixed).toBe(false);
    expect(summary.sameSkuMixed).toBe(false);
    expect(summary.coverage.sales).toBe('full');
  });

  it('meldet gemischte Attribution für SP (7 Tage Klick) mit SB (14 Tage inkl. Views)', () => {
    const summary = summarizeAttribution([
      select('SPONSORED_PRODUCTS', 'campaign', 'console'),
      select('SPONSORED_BRANDS', 'campaign', 'console'),
    ]);
    expect(summary.mixed).toBe(true);
    expect(summary.sameSkuMixed).toBe(true);
  });

  it('meldet gemischte Fenster bei Seller und Vendor', () => {
    expect(
      summarizeAttribution([
        select('SPONSORED_PRODUCTS', 'campaign', 'console', 'seller'),
        select('SPONSORED_PRODUCTS', 'campaign', 'console', 'vendor'),
      ]).mixed,
    ).toBe(true);
  });

  it('ist bei „14 Tage, nur Klicks“ über alle Ad-Typen einheitlich', () => {
    const summary = summarizeAttribution(
      AD_PRODUCTS.map((adProduct) => select(adProduct, 'campaign', 'clicks14d', 'seller')),
    );
    expect(summary.mixed).toBe(false);
    expect(summary.sameSkuMixed).toBe(false);
  });

  it('meldet SD-Same-SKU (nur Klick) neben SB-Same-SKU (inkl. Views) als gemischt', () => {
    const summary = summarizeAttribution([
      select('SPONSORED_BRANDS', 'campaign', 'console'),
      select('SPONSORED_DISPLAY', 'campaign', 'console'),
    ]);
    expect(summary.mixed).toBe(false);
    expect(summary.sameSkuMixed).toBe(true);
  });

  it('meldet teilweise und ganz fehlende Werte je Feld', () => {
    const summary = summarizeAttribution([
      select('SPONSORED_PRODUCTS', 'target', 'clicks14d'),
      select('SPONSORED_BRANDS', 'target', 'clicks14d'),
    ]);
    expect(summary.coverage).toEqual({
      sales: 'full',
      purchases: 'full',
      units: 'partial',
      salesSameSku: 'partial',
      purchasesSameSku: 'partial',
      unitsSameSku: 'partial',
    });
    expect(
      summarizeAttribution([select('SPONSORED_BRANDS', 'productAd', 'clicks14d')]).coverage
        .salesSameSku,
    ).toBe('none');
  });

  it('ist ohne Auswahl vollständig und nicht gemischt', () => {
    const summary = summarizeAttribution([]);
    expect(summary.mixed).toBe(false);
    expect(summary.coverage.units).toBe('full');
  });
});
