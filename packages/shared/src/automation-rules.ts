import { z } from 'zod';

/**
 * Regeln der Automatik (`docs/tasks/phase-5.md` 5.6a): eine geordnete Liste je Organisation. Je Target bzw. Kampagne
 * gewinnt die **erste passende** Regel (alle Bedingungen erfüllt, eingeschaltet, gilt für den Client); passt keine,
 * rechnet der Optimizer. Beträge in EUR (wie die Leitplanken), Kennzahlen aus dem Zeitraum der Bulk-Datei.
 */

export const MAX_AUTOMATION_RULES = 50;
export const MAX_RULE_CONDITIONS = 5;
export const MAX_RULE_NAME_LENGTH = 80;

/** `target`: Gebote. `campaign`: Tagesbudgets. */
export const RULE_LEVELS = ['target', 'campaign'] as const;
export type RuleLevel = (typeof RULE_LEVELS)[number];

/** Summen des Zeitraums; `acos` in Prozent und `cpc` daraus gerechnet. */
export const RULE_METRICS = [
  'impressions',
  'clicks',
  'spend',
  'sales',
  'orders',
  'acos',
  'cpc',
] as const;
export type RuleMetric = (typeof RULE_METRICS)[number];

export const RULE_COMPARATORS = ['gt', 'gte', 'lt', 'lte'] as const;
export type RuleComparator = (typeof RULE_COMPARATORS)[number];

const unsigned = z.string().regex(/^\d{1,7}(\.\d{1,2})?$/);
const signed = z.string().regex(/^-?\d{1,7}(\.\d{1,2})?$/);
const nonZero = (value: string) => Number(value) !== 0;

export const ruleConditionSchema = z
  .strictObject({
    metric: z.enum(RULE_METRICS),
    comparator: z.enum(RULE_COMPARATORS),
    value: unsigned,
    /** Nur `acos`: `value` ist Prozent des wirksamen Ziel-ACoS (150 = das Anderthalbfache). */
    relativeToGoal: z.boolean().optional(),
  })
  .refine((c) => !c.relativeToGoal || c.metric === 'acos', {
    path: ['relativeToGoal'],
    message: 'Relativ zum Ziel gibt es nur für den ACoS.',
  });
export type RuleCondition = z.infer<typeof ruleConditionSchema>;

const field = z.enum(['bid', 'budget']);
export const ruleActionSchema = z.discriminatedUnion('type', [
  /** Um Prozent ändern (−100 bis +500). */
  z.strictObject({
    type: z.literal('changePercent'),
    field,
    value: signed.refine((v) => nonZero(v) && Number(v) >= -100 && Number(v) <= 500),
  }),
  /** Um einen Betrag in EUR ändern. */
  z.strictObject({ type: z.literal('changeAbsolute'), field, value: signed.refine(nonZero) }),
  /** Auf einen Betrag in EUR setzen. */
  z.strictObject({ type: z.literal('set'), field, value: unsigned.refine(nonZero) }),
  z.strictObject({ type: z.literal('pause') }),
]);
export type RuleAction = z.infer<typeof ruleActionSchema>;

const LEVEL_FIELD = { target: 'bid', campaign: 'budget' } as const;

export const automationRuleSchema = z
  .strictObject({
    id: z.uuid(),
    name: z.string().trim().min(1).max(MAX_RULE_NAME_LENGTH),
    level: z.enum(RULE_LEVELS),
    /** Alle müssen zutreffen. */
    conditions: z.array(ruleConditionSchema).min(1).max(MAX_RULE_CONDITIONS),
    action: ruleActionSchema,
    /** Gilt nur für diesen Client; `null` = für alle (auch Profile ohne Client). */
    clientId: z.uuid().nullable(),
    enabled: z.boolean(),
  })
  .refine((rule) => rule.action.type === 'pause' || rule.action.field === LEVEL_FIELD[rule.level], {
    path: ['action', 'field'],
    message: 'Targets ändern das Gebot, Kampagnen das Budget.',
  })
  .meta({ id: 'AutomationRule' });
export type AutomationRule = z.infer<typeof automationRuleSchema>;

export const automationRulesSchema = z
  .array(automationRuleSchema)
  .max(MAX_AUTOMATION_RULES)
  .refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, {
    message: 'Jede Regel braucht eine eigene ID.',
  });

/** Eigene Startregeln, solange eine Organisation keine gespeichert hat. */
export const DEFAULT_AUTOMATION_RULES: AutomationRule[] = [
  {
    id: '5b6f0a51-0000-4000-8000-000000000001',
    name: 'Viele Klicks ohne Bestellung',
    level: 'target',
    conditions: [
      { metric: 'clicks', comparator: 'gte', value: '30' },
      { metric: 'orders', comparator: 'lte', value: '0' },
    ],
    action: { type: 'changePercent', field: 'bid', value: '-20' },
    clientId: null,
    enabled: true,
  },
  {
    id: '5b6f0a51-0000-4000-8000-000000000002',
    name: 'ACoS weit über dem Ziel',
    level: 'target',
    conditions: [
      { metric: 'clicks', comparator: 'gte', value: '20' },
      { metric: 'acos', comparator: 'gte', value: '150', relativeToGoal: true },
    ],
    action: { type: 'changePercent', field: 'bid', value: '-15' },
    clientId: null,
    enabled: true,
  },
  {
    id: '5b6f0a51-0000-4000-8000-000000000003',
    name: 'Kampagne weit über dem Ziel',
    level: 'campaign',
    conditions: [
      { metric: 'spend', comparator: 'gte', value: '50' },
      { metric: 'acos', comparator: 'gte', value: '200', relativeToGoal: true },
    ],
    action: { type: 'changePercent', field: 'budget', value: '-10' },
    clientId: null,
    enabled: false,
  },
];

export const automationRulesResponseSchema = z
  .object({
    rules: automationRulesSchema,
    /** Zählt jedes Speichern; 0 = noch nichts gespeichert (Startregeln). */
    version: z.int(),
    updatedAt: z.string().nullable(),
  })
  .meta({ id: 'AutomationRulesResponse' });
export type AutomationRulesResponse = z.infer<typeof automationRulesResponseSchema>;

export const saveAutomationRulesRequestSchema = z
  .strictObject({ rules: automationRulesSchema, version: z.int().min(0) })
  .meta({ id: 'SaveAutomationRulesRequest' });
