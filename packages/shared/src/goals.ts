import { z } from 'zod';

/**
 * Ziele (`docs/tasks/phase-5.md` 5.3, F4, vorgezogen aus Phase 6): Ziel-ACoS bzw. -ROAS je Client, Profil oder
 * Produktgruppe. ACoS in Prozent (`25` = 25 %), ROAS als Faktor; gespeichert wird nur der gesetzte Wert, der andere
 * folgt daraus (ROAS = 100 / ACoS). TACoS und Wachstum brauchen Umsatzdaten (Phase 7).
 */

export const GOAL_METRICS = ['acos', 'roas'] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];

/** Vorrang beim wirksamen Ziel: Produktgruppe vor Profil vor Client. */
export const GOAL_SCOPES = ['client', 'profile', 'productGroup'] as const;
export type GoalScope = (typeof GOAL_SCOPES)[number];

/** Grenzen eines Ziels: ACoS über 0 bis 100 %, ROAS 1 bis 100 (dasselbe Band umgerechnet). */
export const GOAL_LIMITS: Record<GoalMetric, { min: number; minExclusive: boolean; max: number }> =
  {
    acos: { min: 0, minExclusive: true, max: 100 },
    roas: { min: 1, minExclusive: false, max: 100 },
  };

const DECIMAL_2 = /^\d{1,3}(\.\d{1,2})?$/;

/** Prüft einen Zielwert; liefert den Fehlertext-Schlüssel oder `null`. */
export function goalValueIssue(metric: GoalMetric, value: string): 'format' | 'range' | null {
  if (!DECIMAL_2.test(value)) return 'format';
  const number = Number(value);
  const limits = GOAL_LIMITS[metric];
  const tooLow = limits.minExclusive ? number <= limits.min : number < limits.min;
  return tooLow || number > limits.max ? 'range' : null;
}

const decimalInput = z
  .string()
  .trim()
  .transform((value) => value.replace(',', '.'));

export const goalScopeRefSchema = z.strictObject({ type: z.enum(GOAL_SCOPES), id: z.uuid() });
export type GoalScopeRef = z.infer<typeof goalScopeRefSchema>;

export const setGoalRequestSchema = z
  .strictObject({
    scope: goalScopeRefSchema,
    metric: z.enum(GOAL_METRICS),
    value: decimalInput,
  })
  .superRefine((input, ctx) => {
    const issue = goalValueIssue(input.metric, input.value);
    if (issue === 'format') {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Zahl mit höchstens zwei Nachkommastellen.',
      });
    } else if (issue === 'range') {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: input.metric === 'acos' ? 'ACoS über 0 bis 100 %.' : 'ROAS von 1 bis 100.',
      });
    }
  })
  .meta({ id: 'SetGoalRequest' });
export type SetGoalRequest = z.infer<typeof setGoalRequestSchema>;

export const goalSchema = z
  .object({
    id: z.uuid(),
    metric: z.enum(GOAL_METRICS),
    /** Gesetzter Wert, exakt. */
    value: z.string(),
    /** ACoS in Prozent und ROAS, eins davon umgerechnet (zwei Stellen). */
    acos: z.string(),
    roas: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Goal' });
export type Goal = z.infer<typeof goalSchema>;

// Nicht `.nullable()`: das machte die OpenAPI-Komponente `Goal` selbst nullable.
const nullableGoalSchema = z.union([goalSchema, z.null()]);

const productGroupGoalsSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  goal: nullableGoalSchema,
});

const profileGoalsSchema = z.object({
  id: z.uuid(),
  accountName: z.string(),
  countryCode: z.string(),
  goal: nullableGoalSchema,
  productGroups: z.array(productGroupGoalsSchema),
});

export const goalsOverviewSchema = z
  .object({
    /** Clients mit mindestens einem sichtbaren Profil, nach Name. */
    clients: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        goal: nullableGoalSchema,
        profiles: z.array(profileGoalsSchema),
      }),
    ),
    /** Sichtbare Profile ohne Client: Ziele nur je Profil oder Produktgruppe. */
    unassignedProfiles: z.array(profileGoalsSchema),
  })
  .meta({ id: 'GoalsOverview' });
export type GoalsOverview = z.infer<typeof goalsOverviewSchema>;

const amountSchema = decimalInput.pipe(
  z.string().regex(/^\d{1,7}(\.\d{1,4})?$/, 'Betrag mit höchstens vier Nachkommastellen.'),
);

export const targetAcosRequestSchema = z
  .strictObject({
    price: amountSchema.refine((value) => Number(value) > 0, 'Der Preis muss größer als 0 sein.'),
    unitCost: amountSchema,
    fees: amountSchema,
    margin: decimalInput.pipe(
      z
        .string()
        .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Prozent mit höchstens zwei Nachkommastellen.')
        .refine((value) => Number(value) <= 100, 'Höchstens 100 %.'),
    ),
  })
  .meta({ id: 'TargetAcosRequest' });
export type TargetAcosRequest = z.infer<typeof targetAcosRequestSchema>;

export const targetAcosResponseSchema = z
  .object({
    breakEvenAcos: z.string(),
    /** `null`, wenn nach Kosten und Marge nichts für Werbung bleibt. */
    targetAcos: z.string().nullable(),
    targetRoas: z.string().nullable(),
  })
  .meta({ id: 'TargetAcosResponse' });
export type TargetAcosResponse = z.infer<typeof targetAcosResponseSchema>;
