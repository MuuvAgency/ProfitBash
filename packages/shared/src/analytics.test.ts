import { describe, expect, it } from 'vitest';
import {
  AD_PRODUCTS,
  adProductSchema,
  ATTRIBUTION_SETTINGS,
  attributionSettingSchema,
  DEFAULT_ATTRIBUTION_SETTING,
  isFxRateStale,
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

describe('isFxRateStale („Kurse bis“ älter als 5 Kalendertage)', () => {
  const berlin = (local: string) => new Date(`${local}+02:00`);
  const winter = (local: string) => new Date(`${local}+01:00`);

  it('warnt erst, wenn der letzte Kurs mehr als 5 Tage vor dem Tag liegt', () => {
    expect(isFxRateStale('2026-09-21', berlin('2026-09-26T12:00:00'))).toBe(false);
    expect(isFxRateStale('2026-09-21', berlin('2026-09-27T12:00:00'))).toBe(true);
    expect(isFxRateStale(null, berlin('2026-09-27T12:00:00'))).toBe(true);
  });

  it('gibt an Ostern keinen Fehlalarm, auch nicht vor dem Abruf um 06:00', () => {
    // Ostern 2027: Gründonnerstag 25.03. letzter Kurs, Karfreitag und Ostermontag ohne Kurs; der Kurs vom
    // Dienstag (30.03.) kommt am Mittwoch um 06:00.
    expect(isFxRateStale('2027-03-25', berlin('2027-03-30T23:00:00'))).toBe(false);
    expect(isFxRateStale('2027-03-25', berlin('2027-03-31T05:30:00'))).toBe(false);
    expect(isFxRateStale('2027-03-25', berlin('2027-03-31T07:00:00'))).toBe(true);
  });

  it('gibt an Weihnachten keinen Fehlalarm', () => {
    // 2025: 24.12. (Mi) letzter Kurs, 25./26.12. und Wochenende ohne Kurs, Montag 29.12. kommt am 30.12. um 06:00.
    expect(isFxRateStale('2025-12-24', winter('2025-12-30T05:30:00'))).toBe(false);
    // 2026: 24.12. (Do), 25.12. (Fr) ohne Kurs, Montag 28.12. kommt am 29.12. um 06:00.
    expect(isFxRateStale('2026-12-24', winter('2026-12-29T05:30:00'))).toBe(false);
  });
});
