import { z } from 'zod';
import { analyticsQuerySchema, metricChangeSchema } from './analytics-api';

/**
 * zod-Schemas der Profit-Endpunkte (`/api/profit/*`, `docs/tasks/phase-7.md`). Beträge als Decimal-Strings in der
 * Anzeigewährung, fehlende Werte `null` (Anzeige „–“).
 */

const orNull = <T extends z.ZodType>(schema: T) => z.union([schema, z.null()]);
const amount = z.string();

/** Auswahl wie im Dashboard ohne Ad-Typen und Tags (gelten nur für Werbung). */
export const salesQuerySchema = analyticsQuerySchema
  .omit({ adProducts: true, tagIds: true })
  .meta({ id: 'SalesQuery' });
export type SalesQueryBody = z.infer<typeof salesQuerySchema>;

const salesBaseSchema = z.object({
  revenueNet: amount,
  revenueGross: amount,
  units: z.number().int(),
  orders: z.number().int(),
});

export const salesPeriodSchema = salesBaseSchema
  .extend({
    /** Stück ohne Preis (selbst versandt, „Pending“): Ihr Umsatz fehlt noch. */
    unpricedUnits: z.number().int(),
    /** Werbung der Ads-Profile desselben Clients und Marktplatzes; `null` ohne solche Profile. */
    adCost: amount.nullable(),
    adSales: amount.nullable(),
    /** Werbekosten ÷ Netto-Umsatz (Bruch, 0.1 = 10 %). */
    tacos: amount.nullable(),
    organicNet: amount.nullable(),
    organicGross: amount.nullable(),
  })
  .meta({ id: 'SalesPeriod' });

export const SALES_CHANGE_KEYS = ['revenueNet', 'revenueGross', 'units', 'orders', 'tacos'] as const;

const salesDaySchema = z.object({
  date: z.iso.date(),
  revenueNet: amount,
  revenueGross: amount,
  units: z.number().int(),
});

export const salesProductSchema = z
  .object({
    sellerAccountId: z.uuid(),
    countryCode: z.string(),
    /** Originalwährung des Kontos. */
    currencyCode: z.string(),
    sku: z.string(),
    asin: z.string().nullable(),
    current: salesBaseSchema,
    comparison: orNull(salesBaseSchema),
  })
  .meta({ id: 'SalesProduct' });

export const salesResponseSchema = z
  .object({
    meta: z.object({
      currency: z.string(),
      converted: z.boolean(),
      missingFxCurrencies: z.array(z.string()),
      /** Sichtbare Seller-Konten der Auswahl. */
      accounts: z.number().int(),
      /** Ads-Profile, deren Werbung zu diesen Konten gehört (0: kein TACoS). */
      adProfiles: z.number().int(),
    }),
    current: salesPeriodSchema,
    comparison: orNull(salesPeriodSchema),
    change: orNull(
      z.object(
        Object.fromEntries(SALES_CHANGE_KEYS.map((key) => [key, metricChangeSchema])) as Record<
          (typeof SALES_CHANGE_KEYS)[number],
          typeof metricChangeSchema
        >,
      ),
    ),
    days: z.array(salesDaySchema),
    comparisonDays: z.array(salesDaySchema),
    products: z.array(salesProductSchema),
    truncated: z.boolean(),
  })
  .meta({ id: 'SalesResponse' });
export type SalesResponse = z.infer<typeof salesResponseSchema>;
