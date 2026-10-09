import {
  adChangeFieldKind,
  isAdChangePlacementField,
  type AdChangeField,
  type AdChangeNegative,
} from '@profitbash/shared/ad-changes';
import { Dec } from './decimal';

// Aus `@profitbash/shared/ad-changes` (eigener Einstiegspunkt wie `/analytics`): Die Wurzel zöge Browser- und
// Node-Typen in dieses Paket.

/**
 * Prüfungen vor dem Übermitteln von Änderungen (`docs/tasks/phase-3.md` 3.4, ohne I/O):
 * - **Grenzen von Amazon** (hart): Mindest- und Höchstwerte je Ad-Typ, Marktplatz und Feld, dazu Länge und Wortzahl
 *   negativer Keywords. Die Werte selbst liegen in `@profitbash/amazon-ads` (`limits.ts`) und kommen über
 *   `limitFor` herein; ohne bekannte Grenze entscheidet Amazon.
 * - **Warnungen nach F6** (Übermitteln erst mit Bestätigung): Gebot oder Budget ändert sich um mehr als 50 %, mehr
 *   als 200 Änderungen auf einmal.
 */

/** Ab dieser Änderung eines Gebots oder Budgets (in Prozent, beide Richtungen) fragt die Oberfläche nach. */
export const AD_CHANGE_WARNING_PERCENT = 50;
/** Mehr Änderungen in einer Übermittlung brauchen eine Bestätigung. */
export const AD_CHANGE_WARNING_COUNT = 200;

/** Höchstzahl der Wörter eines negativen Keywords je Match-Typ und Höchstlänge (Amazon, alle Ad-Typen). */
export const NEGATIVE_KEYWORD_MAX_WORDS = { EXACT: 10, PHRASE: 4 } as const;
export const NEGATIVE_KEYWORD_MAX_LENGTH = 80;

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

export type AdChangeLimitField = 'bid' | 'default_bid' | 'budget' | 'placement';

export type AdChangeLimitLookup = (input: {
  adProduct: string;
  countryCode: string;
  field: AdChangeLimitField;
  /** Kostenart der Kampagne (`cpc` | `vcpm`), soweit bekannt: SB und SD haben je Kostenart eigene Gebotsgrenzen. */
  costType: string | null;
}) => { min: string; max: string } | null;

export interface AdChangeCheckInput {
  id: string;
  /** Leer beim Anlegen eines Negatives. */
  field: AdChangeField | null;
  before: string | null;
  /**
   * Vergleichswert für die ±50-%-Warnung, wenn es keinen Wert vorher gibt: das Standardgebot der Ad Group bei einem
   * Target ohne eigenes Gebot (Dominik, 2026-10-08).
   */
  comparisonBefore?: string | null;
  after: string | null;
  /** Ad-Typ der Kampagne und Land des Profils. */
  adProduct: string;
  countryCode: string;
  /** Kostenart der Kampagne (`extra.costType`), soweit bekannt. */
  costType?: string | null;
  negative: AdChangeNegative | null;
  /** Für „mehr als 200 Änderungen“ je Übermittlung (eine je Profil); ohne Angabe zählen alle zusammen. */
  profileId?: string;
}

export type AdChangeLimitViolation =
  | { changeId: string; code: 'belowMinimum' | 'aboveMaximum'; min: string; max: string }
  | { changeId: string; code: 'tooLong' | 'tooManyWords'; max: number };

export interface AdChangeCheckResult {
  /** Verstöße gegen Grenzen von Amazon: Diese Änderungen lassen sich nicht übermitteln. */
  violations: AdChangeLimitViolation[];
  /** Gebote und Budgets mit mehr als ±50 %; `changePercent` mit Vorzeichen, höchstens zwei Nachkommastellen. */
  largeChanges: { changeId: string; changePercent: string }[];
  tooMany: { count: number; limit: number } | null;
}

export function checkAdChanges(
  changes: readonly AdChangeCheckInput[],
  options: { limitFor: AdChangeLimitLookup },
): AdChangeCheckResult {
  // Eine Übermittlung bündelt die Änderungen eines Profils: gezählt wird je Profil.
  const perProfile = new Map<string | undefined, number>();
  for (const change of changes) {
    perProfile.set(change.profileId, (perProfile.get(change.profileId) ?? 0) + 1);
  }
  const largest = Math.max(0, ...perProfile.values());
  const result: AdChangeCheckResult = {
    violations: [],
    largeChanges: [],
    tooMany:
      largest > AD_CHANGE_WARNING_COUNT ? { count: largest, limit: AD_CHANGE_WARNING_COUNT } : null,
  };
  for (const change of changes) {
    if (change.negative?.type === 'keyword') {
      const { keywordText, matchType } = change.negative;
      const maxWords = NEGATIVE_KEYWORD_MAX_WORDS[matchType];
      if (keywordText.length > NEGATIVE_KEYWORD_MAX_LENGTH) {
        result.violations.push({
          changeId: change.id,
          code: 'tooLong',
          max: NEGATIVE_KEYWORD_MAX_LENGTH,
        });
      } else if (keywordText.split(/\s+/u).filter(Boolean).length > maxWords) {
        result.violations.push({ changeId: change.id, code: 'tooManyWords', max: maxWords });
      }
      continue;
    }
    if (change.field === null || change.after === null) continue;
    const kind = adChangeFieldKind(change.field);
    // Nur einfache Dezimalzahlen (wie `numeric` sie liefert): `Decimal` nähme sonst auch `NaN`, Hex und Exponenten.
    if (kind === 'enum' || !PLAIN_DECIMAL.test(change.after)) continue;

    const limit = options.limitFor({
      adProduct: change.adProduct,
      countryCode: change.countryCode,
      field: isAdChangePlacementField(change.field)
        ? 'placement'
        : (change.field as AdChangeLimitField),
      costType: change.costType ?? null,
    });
    const after = new Dec(change.after);
    if (limit && after.lessThan(limit.min)) {
      result.violations.push({ changeId: change.id, code: 'belowMinimum', ...limit });
    } else if (limit && after.greaterThan(limit.max)) {
      result.violations.push({ changeId: change.id, code: 'aboveMaximum', ...limit });
    }

    const reference = change.before ?? change.comparisonBefore ?? null;
    if (kind !== 'money' || reference === null || !PLAIN_DECIMAL.test(reference)) continue;
    const before = new Dec(reference);
    if (before.lessThanOrEqualTo(0)) continue;
    const percent = after.minus(before).dividedBy(before).times(100);
    if (percent.abs().greaterThan(AD_CHANGE_WARNING_PERCENT)) {
      result.largeChanges.push({
        changeId: change.id,
        changePercent: percent.toDecimalPlaces(2).toFixed(),
      });
    }
  }
  return result;
}
