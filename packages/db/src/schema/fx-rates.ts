import { sql } from 'drizzle-orm';
import { check, date, numeric, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './columns';

/**
 * Euro-Referenzkurse der EZB (Phase 2, 2.2): 1 `base` = `rate` × `quote` am Tag `date`. Öffentliche
 * Referenzdaten für alle Organisationen, deshalb **ohne** `organization_id` (ADR 002, Geltungsbereich).
 * Nur Veröffentlichungstage; für Wochenenden und Feiertage gilt der letzte Kurs davor
 * (`fx-rates.ts`). Der Primärschlüssel beginnt mit `quote`, damit „letzter Kurs an oder vor Tag d“
 * je Währung ein Index-Zugriff ist.
 */
export const fxRates = pgTable(
  'fx_rates',
  {
    date: date('date', { mode: 'string' }).notNull(),
    base: text('base').notNull().default('EUR'),
    quote: text('quote').notNull(),
    rate: numeric('rate', { mode: 'string' }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'fx_rates_pk', columns: [t.quote, t.date] }),
    check('fx_rates_base_eur', sql`${t.base} = 'EUR'`),
    check('fx_rates_quote_iso', sql`${t.quote} ~ '^[A-Z]{3}$' and ${t.quote} <> 'EUR'`),
    check('fx_rates_rate_positive', sql`${t.rate} > 0`),
  ],
);
