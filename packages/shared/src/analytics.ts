import { z } from 'zod';

/**
 * Begriffe der Auswertungen (Phase 2), die Web, API und Rechenkern teilen. Hier statt in `@profitbash/engine`,
 * weil das Web die Engine wegen `decimal.js` nicht importieren darf (ADR 003).
 */

/** Ad-Typen in Amazons Schreibweise (`ad_product` in den Tabellen). */
export const AD_PRODUCTS = ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS', 'SPONSORED_DISPLAY'] as const;
export type AdProduct = (typeof AD_PRODUCTS)[number];
export const adProductSchema = z.enum(AD_PRODUCTS);

/**
 * Attributionsfenster (`phase-2.md` F4): `console` = wie die Konsole (SP 7 Tage, bei Vendoren 14; SB/SD 14 Tage
 * inkl. Views), `clicks14d` = einheitlich 14 Tage, nur Klicks.
 */
export const ATTRIBUTION_SETTINGS = ['console', 'clicks14d'] as const;
export type AttributionSetting = (typeof ATTRIBUTION_SETTINGS)[number];
export const attributionSettingSchema = z.enum(ATTRIBUTION_SETTINGS);
export const DEFAULT_ATTRIBUTION_SETTING: AttributionSetting = 'console';

/** „Kurse bis“ gilt als veraltet, wenn der letzte EZB-Kurs mehr als so viele Kalendertage zurückliegt. */
export const FX_RATES_STALE_AFTER_DAYS = 5;
/** Der tägliche Kursabruf läuft um 06:00 Europe/Berlin (`fx-rates-sync`); erst danach zählt ein neuer Tag. */
const FX_RATES_FETCH_HOUR = 6;

const berlinDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Warnung „Kurse veraltet“ (`phase-2.md` 2.2, entschieden: mehr als 5 Kalendertage). Der Tag beginnt mit dem
 * Abruf um 06:00 Berlin, sonst gäbe es in der Nacht nach langen Feiertagen (Ostern: Gründonnerstag bis
 * Mittwoch 06:00) einen Fehlalarm. Ohne Kurs (`null`) immer veraltet.
 */
export function isFxRateStale(latestRateDate: string | null, now: Date): boolean {
  if (latestRateDate === null) return true;
  const today = berlinDate.format(new Date(now.getTime() - FX_RATES_FETCH_HOUR * 3_600_000));
  const days =
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${latestRateDate}T00:00:00Z`)) / 86_400_000;
  return days > FX_RATES_STALE_AFTER_DAYS;
}
