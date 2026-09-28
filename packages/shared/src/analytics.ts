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
