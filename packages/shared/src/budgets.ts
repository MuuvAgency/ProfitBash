import { z } from 'zod';

/**
 * Budget-Caps und Pacing (`docs/tasks/phase-5.md` 5.9a, F5): je Profil und Monat in der Währung des Profils, für
 * das ganze Profil oder eine Auswahl (Portfolios, Tags). Ein Cap gilt jeden Monat; `monthAmounts` setzt für
 * einzelne Monate einen abweichenden Betrag. Mehrere Caps je Profil, jeder wird einzeln gerechnet.
 */

export const BUDGET_CAP_SCOPES = ['profile', 'portfolios', 'tags'] as const;
export type BudgetCapScopeType = (typeof BUDGET_CAP_SCOPES)[number];

/** Startwerte der Warnschwellen in Prozent des Caps, gemessen am geschätzten Ist (Dominik, 2026-10-11). */
export const DEFAULT_CAP_WARN_PERCENTS = [80, 100];
export const MAX_BUDGET_CAPS_PER_PROFILE = 20;
const MAX_SCOPE_IDS = 50;
const MAX_MONTH_AMOUNTS = 24;

const amountSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(',', '.'))
  .pipe(
    z
      .string()
      .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Betrag mit höchstens zwei Nachkommastellen.')
      .refine((value) => Number(value) > 0, 'Der Betrag muss größer als 0 sein.'),
  );

const distinct = (values: readonly unknown[]) => new Set(values).size === values.length;

export const budgetCapScopeSchema = z
  .strictObject({
    type: z.enum(BUDGET_CAP_SCOPES),
    /** Interne IDs der Portfolios bzw. Tags; leer beim ganzen Profil. */
    ids: z.array(z.uuid()).max(MAX_SCOPE_IDS).refine(distinct, 'Jede ID nur einmal.'),
  })
  .refine((scope) => (scope.type === 'profile') === (scope.ids.length === 0), {
    path: ['ids'],
    message: 'Ganzes Profil ohne Auswahl, sonst mindestens ein Portfolio bzw. Tag.',
  });
export type BudgetCapScope = z.infer<typeof budgetCapScopeSchema>;

export const budgetCapInputSchema = z
  .strictObject({
    profileId: z.uuid(),
    scope: budgetCapScopeSchema,
    /** Betrag je Monat in der Währung des Profils. */
    amount: amountSchema,
    /** Abweichende Beträge einzelner Monate (`YYYY-MM`). */
    monthAmounts: z
      .record(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Monat als JJJJ-MM.'), amountSchema)
      .refine((value) => Object.keys(value).length <= MAX_MONTH_AMOUNTS, 'Zu viele Monate.')
      .default({}),
    warnPercents: z
      .array(z.int().min(1).max(100))
      .max(3)
      .refine(distinct, 'Jede Schwelle nur einmal.')
      .default(DEFAULT_CAP_WARN_PERCENTS),
  })
  .meta({ id: 'BudgetCapInput' });
export type BudgetCapInput = z.infer<typeof budgetCapInputSchema>;

const estimateSchema = z.object({ value: z.string(), low: z.string(), high: z.string() });

export const pacingSchema = z
  .object({
    daysInMonth: z.number().int(),
    /** Tage des Monats bis zum Datenstand. */
    elapsedDays: z.number().int(),
    /** Letzter Tag des Monats mit Daten. */
    dataThrough: z.string().nullable(),
    /** `false`: Ist anteilig aus einem Zeitraum geschätzt („≈“), der über den Monat hinausragt, oder ohne Daten. */
    exact: z.boolean(),
    actual: estimateSchema,
    /** Soll bis zum Datenstand (linear). */
    planned: z.string(),
    forecast: estimateSchema,
    /** Höchste erreichte Warnschwelle in Prozent. */
    warnLevel: z.number().int().nullable(),
    forecastOver: z.boolean(),
  })
  .meta({ id: 'Pacing' });

export const budgetCapSchema = z
  .object({
    id: z.uuid(),
    profileId: z.uuid(),
    scope: z.object({ type: z.enum(BUDGET_CAP_SCOPES), ids: z.array(z.uuid()) }),
    /** Namen der Portfolios bzw. Tags, die es noch gibt. */
    scopeLabels: z.array(z.string()),
    amount: z.string(),
    monthAmounts: z.record(z.string(), z.string()),
    /** Betrag im laufenden Monat des Profils. */
    effectiveAmount: z.string(),
    warnPercents: z.array(z.number().int()),
    pacing: pacingSchema,
    campaignCount: z.number().int(),
    /** Die Kampagnen im Umfang mit den höchsten Ausgaben im Monat (höchstens 50). */
    campaigns: z.array(
      z.object({
        id: z.uuid(),
        name: z.string().nullable(),
        state: z.string().nullable(),
        dailyBudget: z.string().nullable(),
        /** Geschätzte Ausgaben im Monat. */
        actual: z.string(),
        exact: z.boolean(),
      }),
    ),
    updatedAt: z.string(),
  })
  .meta({ id: 'BudgetCap' });
export type BudgetCap = z.infer<typeof budgetCapSchema>;

export const budgetsOverviewSchema = z
  .object({
    /** Sichtbare Profile nach Name. */
    profiles: z.array(
      z.object({
        id: z.uuid(),
        accountName: z.string(),
        countryCode: z.string(),
        currencyCode: z.string(),
        /** Laufender Monat in der Zeitzone des Profils (`YYYY-MM`). */
        month: z.string(),
        /** Zuletzt hochgeladene Datei mit Kennzahlen. */
        dataState: z
          .object({ periodStart: z.string(), periodEnd: z.string(), importedAt: z.string() })
          .nullable(),
        portfolios: z.array(z.object({ id: z.uuid(), name: z.string() })),
        caps: z.array(budgetCapSchema),
      }),
    ),
    /** Tags der Organisation für den Umfang. */
    tags: z.array(z.object({ id: z.uuid(), name: z.string() })),
  })
  .meta({ id: 'BudgetsOverview' });
export type BudgetsOverview = z.infer<typeof budgetsOverviewSchema>;
