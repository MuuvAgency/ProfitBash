import { z } from 'zod';
import { adProductSchema } from './analytics';

/**
 * Suchbegriff-Analyse aus den Suchbegriff-Blättern der Bulk-Datei (`docs/tasks/phase-2b.md` 2b.2). Gerechnet wird je
 * Profil und **einem** Datei-Zeitraum (nie über mehrere: Zeiträume überlappen sich). Beträge und Zähler sind
 * Decimal-Strings, Beträge in der Währung des Profils.
 */

// ---------------------------------------------------------------------------
// Regeln der Einstufung (je Organisation, im UI änderbar)
// ---------------------------------------------------------------------------

/** Decimal-String ohne Vorzeichen und Exponent. */
const unsignedDecimal = (integerDigits: number, fractionDigits: number) =>
  z.string().regex(new RegExp(`^\\d{1,${integerDigits}}(\\.\\d{1,${fractionDigits}})?$`));

const searchTermRuleFields = {
  /** Harvest ab so vielen Käufen … */
  harvestMinPurchases: z.int().min(1).max(100_000),
  /** … und ACoS höchstens so hoch (Bruch: 0.25 = 25 %). */
  harvestMaxAcos: unsignedDecimal(2, 4).refine((value) => /[1-9]/.test(value), {
    message: 'größer als 0',
  }),
  /** Negieren ab so vielen Klicks ohne Kauf … */
  negateMinClicks: z.int().min(1).max(1_000_000),
  /** … und mindestens so viel Spend (Währung des Profils). */
  negateMinCost: unsignedDecimal(9, 2),
};

export const searchTermRulesSchema = z
  .strictObject(searchTermRuleFields)
  .meta({ id: 'SearchTermRules' });
export type SearchTermRulesInput = z.infer<typeof searchTermRulesSchema>;

/**
 * Startwerte, solange eine Organisation keine eigenen Regeln gespeichert hat (vorläufig, eigene Wahl:
 * „vorsichtig“, Dominik 2026-10-07). Gespeicherte Regeln liegen in `search_term_rules`.
 */
export const DEFAULT_SEARCH_TERM_RULES: SearchTermRulesInput = {
  harvestMinPurchases: 3,
  harvestMaxAcos: '0.25',
  negateMinClicks: 25,
  negateMinCost: '20',
};

/**
 * Abweichende Regeln eines Profils (2b.2g): je Feld ein eigener Wert oder `null` = wie die Organisation. Die
 * Spend-Grenze ist ein Betrag in der Währung des Profils; dieselbe Zahl bedeutet in SEK viel weniger als in EUR.
 * Gespeichert in `search_term_rule_overrides`.
 */
export const searchTermRuleOverridesSchema = z
  .strictObject({
    harvestMinPurchases: searchTermRuleFields.harvestMinPurchases.nullable(),
    harvestMaxAcos: searchTermRuleFields.harvestMaxAcos.nullable(),
    negateMinClicks: searchTermRuleFields.negateMinClicks.nullable(),
    negateMinCost: searchTermRuleFields.negateMinCost.nullable(),
  })
  .meta({ id: 'SearchTermRuleOverrides' });
export type SearchTermRuleOverrides = z.infer<typeof searchTermRuleOverridesSchema>;

export const NO_SEARCH_TERM_RULE_OVERRIDES: SearchTermRuleOverrides = {
  harvestMinPurchases: null,
  harvestMaxAcos: null,
  negateMinClicks: null,
  negateMinCost: null,
};

/** Geltende Regeln eines Profils: je Feld der Wert des Profils, sonst der der Organisation. */
export function resolveSearchTermRules(
  organization: SearchTermRulesInput,
  overrides: SearchTermRuleOverrides | null,
): SearchTermRulesInput {
  return {
    harvestMinPurchases: overrides?.harvestMinPurchases ?? organization.harvestMinPurchases,
    harvestMaxAcos: overrides?.harvestMaxAcos ?? organization.harvestMaxAcos,
    negateMinClicks: overrides?.negateMinClicks ?? organization.negateMinClicks,
    negateMinCost: overrides?.negateMinCost ?? organization.negateMinCost,
  };
}

/** Speichert die abweichenden Regeln eines Profils; alle Felder `null` nimmt die Abweichung zurück. */
export const searchTermProfileRulesRequestSchema = z
  .strictObject({ profileId: z.uuid(), overrides: searchTermRuleOverridesSchema })
  .meta({ id: 'SearchTermProfileRulesRequest' });

export const searchTermProfileRulesResponseSchema = z
  .object({
    profileId: z.uuid(),
    overrides: searchTermRuleOverridesSchema,
    /** `null`, wenn für das Profil nichts (mehr) abweicht. */
    updatedAt: z.string().nullable(),
  })
  .meta({ id: 'SearchTermProfileRulesResponse' });

export const searchTermRulesResponseSchema = z
  .object({
    rules: searchTermRulesSchema,
    /** Noch nichts gespeichert: Es gelten die Startwerte. */
    isDefault: z.boolean(),
    updatedAt: z.string().nullable(),
  })
  .meta({ id: 'SearchTermRulesResponse' });

// ---------------------------------------------------------------------------
// Geschützte Begriffe (je Client)
// ---------------------------------------------------------------------------

export const MAX_PROTECTED_TERMS = 200;
export const MAX_PROTECTED_TERM_LENGTH = 80;

/** Marke und Hero-Begriffe eines Clients; Suchbegriffe, die einen davon enthalten, werden nie zum Negieren vorgeschlagen. */
export const protectedTermsSchema = z
  .array(z.string().trim().min(1).max(MAX_PROTECTED_TERM_LENGTH))
  .max(MAX_PROTECTED_TERMS);

/** Klein geschrieben, Leerraum zusammengefasst, ohne Doppelte und Leere, sortiert (so wird gespeichert). */
export function normalizeProtectedTerms(terms: readonly string[]): string[] {
  const normalized = terms
    .map((term) => term.normalize('NFC').toLowerCase().split(/\s+/u).filter(Boolean).join(' '))
    .filter((term) => term !== '');
  return [...new Set(normalized)].sort();
}

// ---------------------------------------------------------------------------
// Anfragen und Antworten (`/api/ads/search-terms/*`)
// ---------------------------------------------------------------------------

/** Höchstzahl Zeilen bzw. N-Gramme je Antwort (jeweils die mit dem höchsten Spend); Summen gelten für alle. */
export const MAX_SEARCH_TERM_ROWS = 10_000;
export const MAX_SEARCH_TERM_NGRAMS = 5_000;

export const searchTermPeriodsRequestSchema = z.object({}).meta({ id: 'SearchTermPeriodsRequest' });

export const searchTermPeriodSchema = z
  .object({
    profileId: z.uuid(),
    accountName: z.string(),
    countryCode: z.string(),
    currencyCode: z.string(),
    clientId: z.uuid().nullable(),
    /** Erster und letzter Tag des Download-Zeitraums der Datei. */
    periodStart: z.iso.date(),
    periodEnd: z.iso.date(),
    adProducts: z.array(adProductSchema),
    /** Zeilen (Suchbegriff je Target). */
    rows: z.number().int(),
    /** Letzter Import in diesen Zeitraum. */
    importedAt: z.string(),
  })
  .meta({ id: 'SearchTermPeriod' });
export type SearchTermPeriod = z.infer<typeof searchTermPeriodSchema>;

export const searchTermPeriodsResponseSchema = z
  .object({ periods: z.array(searchTermPeriodSchema) })
  .meta({ id: 'SearchTermPeriodsResponse' });

export const searchTermAnalysisRequestSchema = z
  .object({
    profileId: z.uuid(),
    periodStart: z.iso.date(),
    periodEnd: z.iso.date(),
    adProducts: z.array(adProductSchema).min(1).max(3).optional(),
  })
  .refine((body) => body.periodStart <= body.periodEnd, {
    message: '`periodStart` liegt nach `periodEnd`',
  })
  .meta({ id: 'SearchTermAnalysisRequest' });

/** Löscht die Suchbegriffe genau eines Datei-Zeitraums eines Profils (2b.2d), über alle Ad-Typen. */
export const searchTermPeriodDeleteRequestSchema = z
  .object({
    profileId: z.uuid(),
    periodStart: z.iso.date(),
    periodEnd: z.iso.date(),
  })
  .refine((body) => body.periodStart <= body.periodEnd, {
    message: '`periodStart` liegt nach `periodEnd`',
  })
  .meta({ id: 'SearchTermPeriodDeleteRequest' });

export const searchTermPeriodDeleteResponseSchema = z
  .object({
    /** Gelöschte Zeilen (Suchbegriff je Target). */
    deletedRows: z.number().int(),
  })
  .meta({ id: 'SearchTermPeriodDeleteResponse' });

export const SEARCH_TERM_CLASSIFICATIONS = ['harvest', 'negate', 'watch'] as const;
export const SEARCH_TERM_WATCH_REASON_KEYS = [
  'protected',
  'alreadyTargeted',
  'acosAboveTarget',
  'noSales',
  'tooFewData',
] as const;

const searchTermSums = {
  impressions: z.string(),
  clicks: z.string(),
  cost: z.string(),
  sales: z.string(),
  purchases: z.string(),
  units: z.string(),
};

/** Anteile als Bruch (0.25 = 25 %), `null` bei Division durch 0. */
const searchTermDerived = {
  ctr: z.string().nullable(),
  cpc: z.string().nullable(),
  cvr: z.string().nullable(),
  acos: z.string().nullable(),
  roas: z.string().nullable(),
};

export const searchTermRowSchema = z
  .object({
    id: z.uuid(),
    adProduct: adProductSchema,
    searchTerm: z.string(),
    amazonCampaignId: z.string(),
    amazonAdGroupId: z.string(),
    amazonTargetId: z.string(),
    /** Interne IDs und Namen, soweit die Entity im Profil bekannt ist (die Datei kann eine Teilmenge sein). */
    campaignId: z.uuid().nullable(),
    campaignName: z.string().nullable(),
    adGroupId: z.uuid().nullable(),
    adGroupName: z.string().nullable(),
    targetId: z.uuid().nullable(),
    keywordText: z.string().nullable(),
    matchType: z.string().nullable(),
    expression: z.unknown().nullable(),
    ...searchTermSums,
    ...searchTermDerived,
    classification: z.enum(SEARCH_TERM_CLASSIFICATIONS),
    /** Nur bei `watch`: warum der Begriff nur beobachtet wird. */
    reason: z.enum(SEARCH_TERM_WATCH_REASON_KEYS).nullable(),
    /** Enthält einen geschützten Begriff des Clients. */
    protected: z.boolean(),
    /** Im Profil gibt es schon ein aktives exaktes Keyword bzw. Produkt-Target dafür. */
    alreadyTargeted: z.boolean(),
    /**
     * Einstufung des Suchbegriffs über **alle** seine Zeilen (Targets) im Profil und Datei-Zeitraum: Zeilen desselben
     * Begriffs (klein, Leerraum zusammengefasst) summiert, dieselben Regeln. `classification` bleibt die der Zeile.
     */
    termClassification: z.enum(SEARCH_TERM_CLASSIFICATIONS),
    termReason: z.enum(SEARCH_TERM_WATCH_REASON_KEYS).nullable(),
    /**
     * Anzahl der **Zeilen** des Begriffs, die in diese Einstufung eingehen. Das ist nicht die Zahl verschiedener
     * Targets: Zwei Schreibweisen eines Begriffs oder eine SP- und eine SB-Zeile zählen je für sich.
     */
    termTargets: z.number().int(),
    /** Harvest bzw. Negieren, das keine Zeile des Begriffs allein erreicht (erst die Summe über die Targets). */
    termOnlyAcrossTargets: z.boolean(),
  })
  .meta({ id: 'SearchTermRow' });
export type SearchTermRow = z.infer<typeof searchTermRowSchema>;

export const searchTermNgramSchema = z
  .object({
    size: z.number().int().min(1).max(3),
    gram: z.string(),
    /** Anzahl verschiedener Suchbegriffe mit diesem Baustein. */
    searchTerms: z.number().int(),
    ...searchTermSums,
    ...searchTermDerived,
  })
  .meta({ id: 'SearchTermNgram' });
export type SearchTermNgram = z.infer<typeof searchTermNgramSchema>;

export const searchTermAnalysisResponseSchema = z
  .object({
    meta: z.object({
      profileId: z.uuid(),
      accountName: z.string(),
      countryCode: z.string(),
      /** Währung aller Beträge (Währung des Profils). */
      currency: z.string(),
      clientId: z.uuid().nullable(),
      periodStart: z.iso.date(),
      periodEnd: z.iso.date(),
      importedAt: z.string().nullable(),
      /** Geltende Regeln des Profils: Regeln der Organisation, je Feld vom Profil überschrieben (`ruleOverrides`). */
      rules: searchTermRulesSchema,
      /** Die Organisation hat noch nichts gespeichert (Startwerte); sagt nichts über `ruleOverrides`. */
      rulesAreDefault: z.boolean(),
      /** Regeln der Organisation, ohne die Abweichungen des Profils. */
      organizationRules: searchTermRulesSchema,
      /** Abweichende Werte dieses Profils; `null` je Feld = wie die Organisation. */
      ruleOverrides: searchTermRuleOverridesSchema,
      protectedTerms: z.array(z.string()),
      /** Alle Zeilen des Zeitraums; `rows` und `ngrams` können gekürzt sein. */
      totalRows: z.number().int(),
      truncated: z.boolean(),
      maxRows: z.number().int(),
      totalNgrams: z.number().int(),
      ngramsTruncated: z.boolean(),
      maxNgrams: z.number().int(),
    }),
    /** Summe über alle Zeilen des Zeitraums (auch bei gekürzten Zeilen). */
    total: z.object({ ...searchTermSums, ...searchTermDerived }),
    /** Zeilen je Einstufung über alle Zeilen des Zeitraums. */
    counts: z.object({
      harvest: z.number().int(),
      negate: z.number().int(),
      watch: z.number().int(),
    }),
    /** Verschiedene Suchbegriffe je Einstufung über alle Targets (alle Zeilen des Zeitraums). */
    termCounts: z.object({
      harvest: z.number().int(),
      negate: z.number().int(),
      watch: z.number().int(),
    }),
    /** Davon Suchbegriffe, die erst über alle Targets zusammen Harvest bzw. Negieren erreichen. */
    termCountsOnlyAcrossTargets: z.object({
      harvest: z.number().int(),
      negate: z.number().int(),
    }),
    rows: z.array(searchTermRowSchema),
    ngrams: z.array(searchTermNgramSchema),
  })
  .meta({ id: 'SearchTermAnalysisResponse' });
export type SearchTermAnalysisResponse = z.infer<typeof searchTermAnalysisResponseSchema>;
