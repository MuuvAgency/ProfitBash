import { z } from 'zod';

/**
 * Prüfungen „kein Geld verbrennen“ (`docs/tasks/phase-5.md` 5.10): Der Lauf der Automatik sucht je Profil nach
 * Auffälligkeiten und hält sie als Befunde fest. Welche Prüfungen laufen und ihre Schwellen sind Daten der
 * Organisation (eigene Startwerte, Dominik, 2026-10-11). Beträge in EUR wie die Leitplanken.
 */

/**
 * `vcpm`: aktive Kampagne mit Kostenart vCPM. `placement`: Platzierungs-Anpassung ab der Schwelle bei ACoS über
 * dem Ziel. `spendNoOrders`: Target mit Ausgaben ab der Schwelle ohne Bestellung. `noGoal`, `noCap`: aktive
 * Kampagnen ohne Ziel bzw. unter keinem Budget-Cap (je Profil ein Hinweis).
 */
export const CHECK_KINDS = ['vcpm', 'placement', 'spendNoOrders', 'noGoal', 'noCap'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/** Hinweise (`info`) lösen keine Benachrichtigung aus. */
export const CHECK_SEVERITY: Record<CheckKind, 'warning' | 'info'> = {
  vcpm: 'warning',
  placement: 'warning',
  spendNoOrders: 'warning',
  noGoal: 'info',
  noCap: 'info',
};

export const checkSettingsSchema = z
  .strictObject({
    enabled: z.strictObject({
      vcpm: z.boolean(),
      placement: z.boolean(),
      spendNoOrders: z.boolean(),
      noGoal: z.boolean(),
      noCap: z.boolean(),
    }),
    /** Platzierungs-Anpassung in Prozent, ab der geprüft wird (Amazon erlaubt bis 900). */
    placementMinPercent: z.int().min(1).max(900),
    /** Ausgaben eines Targets ohne Bestellung im Zeitraum. */
    spendNoOrdersMinEur: z
      .string()
      .trim()
      .transform((value) => value.replace(',', '.'))
      .pipe(
        z
          .string()
          .regex(/^\d{1,5}(\.\d{1,2})?$/, 'Betrag mit höchstens zwei Nachkommastellen.')
          .refine((value) => Number(value) > 0, 'Größer als 0.'),
      ),
  })
  .meta({ id: 'CheckSettings' });
export type CheckSettings = z.infer<typeof checkSettingsSchema>;

export const DEFAULT_CHECK_SETTINGS: CheckSettings = {
  enabled: { vcpm: true, placement: true, spendNoOrders: true, noGoal: true, noCap: true },
  placementMinPercent: 50,
  spendNoOrdersMinEur: '20.00',
};

export const CHECK_FINDING_FILTERS = ['open', 'acknowledged'] as const;
export type CheckFindingFilter = (typeof CHECK_FINDING_FILTERS)[number];
export const MAX_CHECK_FINDING_IDS = 500;

export const checkFindingSchema = z
  .object({
    id: z.uuid(),
    profileId: z.uuid(),
    accountName: z.string(),
    currencyCode: z.string(),
    kind: z.enum(CHECK_KINDS),
    severity: z.enum(['warning', 'info']),
    entityType: z.enum(['campaign', 'target', 'profile']),
    entityId: z.uuid(),
    campaignName: z.string().nullable(),
    /** Keyword bzw. `null` bei Produkt- und Auto-Targets. */
    keywordText: z.string().nullable(),
    /** Bei `placement` die Platzierung, sonst leer. */
    key: z.string(),
    /** Kennzahlen und Schwellen des Befunds. */
    detail: z.record(z.string(), z.unknown()),
    firstSeenAt: z.string(),
    acknowledgedAt: z.string().nullable(),
  })
  .meta({ id: 'CheckFinding' });
export type CheckFinding = z.infer<typeof checkFindingSchema>;

export const automationChecksSchema = z
  .object({
    settings: checkSettingsSchema,
    /** Die Einstellungen der Prüfungen ändern nur Admins. */
    canEditSettings: z.boolean(),
    findings: z.array(checkFindingSchema),
    /** Treffer insgesamt; die Liste ist auf die neuesten begrenzt. */
    total: z.number().int(),
  })
  .meta({ id: 'AutomationChecks' });
export type AutomationChecks = z.infer<typeof automationChecksSchema>;

export const acknowledgeFindingsRequestSchema = z
  .strictObject({ ids: z.array(z.uuid()).min(1).max(MAX_CHECK_FINDING_IDS) })
  .meta({ id: 'AcknowledgeFindingsRequest' });
