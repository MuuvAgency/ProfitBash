import {
  guardrailOverridesSchema,
  guardrailsSchema,
  type GuardrailOverrides,
  type Guardrails,
} from '@profitbash/shared';

/** Formular der Leitplanken (`phase-5.md` 5.4): Texte der Felder ↔ Werte; geprüft wird mit den Schemas aus shared. */

export type GuardrailKey = keyof Guardrails;
export type GuardrailInputs = Record<GuardrailKey, string>;

/** Reihenfolge im Formular; `integer`: ganze Zahl, sonst Betrag in EUR. */
export const GUARDRAIL_FIELDS: readonly { key: GuardrailKey; integer: boolean }[] = [
  { key: 'maxBidChangePercent', integer: true },
  { key: 'bidFloorCpcPercent', integer: true },
  { key: 'bidFloorEur', integer: false },
  { key: 'maxBidEur', integer: false },
  { key: 'minClicks', integer: true },
  { key: 'minSpendEur', integer: false },
  { key: 'maxBudgetDecreasePercent', integer: true },
];
/** Leer heißt hier „keiner“ statt „fehlt“. */
const OPTIONAL: ReadonlySet<GuardrailKey> = new Set(['bidFloorEur', 'maxBidEur']);

/** Werte als Feldtexte (Komma als Dezimaltrenner); fehlende und `null` leer. */
export function toGuardrailInputs(values: GuardrailOverrides): GuardrailInputs {
  return Object.fromEntries(
    GUARDRAIL_FIELDS.map(({ key }) => [key, String(values[key] ?? '').replace('.', ',')]),
  ) as GuardrailInputs;
}

/**
 * Liest die Feldtexte. `partial` (Client): leere Felder fehlen und erben damit den Wert der Organisation. Sonst sind
 * leere Felder ungültig, außer Boden und Höchstgebot (`null` = keiner). `value` ist `null`, solange etwas ungültig ist.
 */
export function parseGuardrailInputs(
  inputs: GuardrailInputs,
  partial: boolean,
): { value: GuardrailOverrides | null; invalid: ReadonlySet<GuardrailKey> } {
  const raw: Record<string, unknown> = {};
  for (const { key, integer } of GUARDRAIL_FIELDS) {
    const text = inputs[key].trim();
    if (text === '') {
      if (partial) continue;
      raw[key] = OPTIONAL.has(key) ? null : undefined;
    } else {
      raw[key] = integer ? (/^\d+$/.test(text) ? Number(text) : Number.NaN) : text;
    }
  }
  const parsed = (partial ? guardrailOverridesSchema : guardrailsSchema).safeParse(raw);
  return parsed.success
    ? { value: parsed.data, invalid: new Set() }
    : { value: null, invalid: new Set(parsed.error.issues.map((i) => i.path[0] as GuardrailKey)) };
}
