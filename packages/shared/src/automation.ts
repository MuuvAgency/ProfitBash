import { z } from 'zod';

/**
 * Leitplanken und Modus der Automatik (`docs/tasks/phase-5.md` 5.4, F3, F-S6): Startwerte je Organisation, je Client
 * überschreibbar. Absolute Beträge in EUR; der Lauf rechnet sie in die Währung des Profils um.
 */

/** `off`: kein Lauf. `shadow`: Vorschläge nur im Protokoll. `cart`: Vorschläge im Warenkorb des zuständigen Nutzers. */
export const AUTOMATION_MODES = ['off', 'shadow', 'cart'] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];
/** Modus ohne eigene Einstellung (neue Clients, Profile ohne Client). */
export const DEFAULT_AUTOMATION_MODE: AutomationMode = 'shadow';

const percent = z.int().min(1).max(100);
const eur = z
  .string()
  .trim()
  .transform((value) => value.replace(',', '.'))
  .pipe(z.string().regex(/^\d{1,5}(\.\d{1,2})?$/, 'Betrag mit höchstens zwei Nachkommastellen.'));

export const guardrailsSchema = z
  .strictObject({
    /** Höchste Gebotsänderung je 7 Tage, beide Richtungen. */
    maxBidChangePercent: percent,
    /** Gebotsboden als Anteil des realisierten CPC; 0 = kein Boden aus dem CPC. */
    bidFloorCpcPercent: z.int().min(0).max(100),
    /** Absoluter Gebotsboden; `null` = nur Amazons Mindestgebot. */
    bidFloorEur: eur.nullable(),
    /** Höchstes Gebot; `null` = nur Amazons Höchstgebot. */
    maxBidEur: eur.refine((value) => Number(value) > 0, 'Größer als 0.').nullable(),
    /** Mindestdaten für einen Vorschlag: so viele Klicks oder so viele Ausgaben im Zeitraum. */
    minClicks: z.int().min(0).max(100_000),
    minSpendEur: eur,
    /** Höchste Budgetsenkung je Lauf. */
    maxBudgetDecreasePercent: percent,
  })
  .meta({ id: 'Guardrails' });
export type Guardrails = z.infer<typeof guardrailsSchema>;

/** Eigene Startwerte (Dominik, 2026-10-10, „Mittel“). */
export const DEFAULT_GUARDRAILS: Guardrails = {
  maxBidChangePercent: 25,
  bidFloorCpcPercent: 50,
  bidFloorEur: null,
  maxBidEur: '3.00',
  minClicks: 15,
  minSpendEur: '10.00',
  maxBudgetDecreasePercent: 20,
};

/** Überschriebene Werte eines Clients: fehlt ein Schlüssel, gilt der Wert der Organisation. */
export const guardrailOverridesSchema = guardrailsSchema.partial().meta({ id: 'GuardrailOverrides' });
export type GuardrailOverrides = z.infer<typeof guardrailOverridesSchema>;

export const setClientAutomationRequestSchema = z
  .strictObject({
    mode: z.enum(AUTOMATION_MODES),
    /** Bekommt im Modus `cart` die Vorschläge in den Warenkorb; `null` im Modus `cart` = wer speichert. */
    responsibleUserId: z.uuid().nullable(),
    overrides: guardrailOverridesSchema,
  })
  .meta({ id: 'SetClientAutomationRequest' });
export type SetClientAutomationRequest = z.infer<typeof setClientAutomationRequestSchema>;

export const automationSettingsSchema = z
  .object({
    defaults: guardrailsSchema,
    /** Die Startwerte der Organisation ändern nur Admins. */
    canEditDefaults: z.boolean(),
    /** Clients mit mindestens einem sichtbaren Profil, nach Name. */
    clients: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        mode: z.enum(AUTOMATION_MODES),
        responsibleUserId: z.uuid().nullable(),
        overrides: guardrailOverridesSchema,
      }),
    ),
    /** Mitglieder mit Schreibrecht (Auswahl „zuständig“). */
    members: z.array(z.object({ userId: z.uuid(), name: z.string() })),
  })
  .meta({ id: 'AutomationSettings' });
export type AutomationSettings = z.infer<typeof automationSettingsSchema>;
