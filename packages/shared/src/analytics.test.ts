import { describe, expect, it } from 'vitest';
import {
  AD_PRODUCTS,
  adProductSchema,
  ATTRIBUTION_SETTINGS,
  attributionSettingSchema,
  DEFAULT_ATTRIBUTION_SETTING,
} from './analytics';

describe('Attribution (F4) und Ad-Typen', () => {
  it('kennt „wie Konsole“ (Standard) und „14 Tage, nur Klicks“', () => {
    expect(ATTRIBUTION_SETTINGS).toEqual(['console', 'clicks14d']);
    expect(DEFAULT_ATTRIBUTION_SETTING).toBe('console');
    expect(attributionSettingSchema.parse('clicks14d')).toBe('clicks14d');
    expect(attributionSettingSchema.safeParse('7d').success).toBe(false);
  });

  it('kennt SP, SB und SD in Amazons Schreibweise', () => {
    expect(AD_PRODUCTS).toEqual(['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS', 'SPONSORED_DISPLAY']);
    expect(adProductSchema.safeParse('SPONSORED_TV').success).toBe(false);
  });
});
