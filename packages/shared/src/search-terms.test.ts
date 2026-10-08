import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEARCH_TERM_RULES,
  MAX_PROTECTED_TERMS,
  NO_SEARCH_TERM_RULE_OVERRIDES,
  normalizeProtectedTerms,
  protectedTermsSchema,
  resolveSearchTermRules,
  searchTermAnalysisRequestSchema,
  searchTermRuleOverridesSchema,
  searchTermRulesSchema,
} from './search-terms';

describe('searchTermRulesSchema', () => {
  it('nimmt die Startwerte an (vorsichtig, Dominik 2026-10-07)', () => {
    expect(searchTermRulesSchema.parse(DEFAULT_SEARCH_TERM_RULES)).toEqual({
      harvestMinPurchases: 3,
      harvestMaxAcos: '0.25',
      negateMinClicks: 25,
      negateMinCost: '20',
    });
  });

  it.each([
    ['harvestMinPurchases', 0],
    ['harvestMinPurchases', 1.5],
    ['negateMinClicks', 0],
    ['harvestMaxAcos', '0'],
    ['harvestMaxAcos', '0.000'],
    ['harvestMaxAcos', '-0.2'],
    ['harvestMaxAcos', '25%'],
    ['harvestMaxAcos', 0.25],
    ['negateMinCost', '-1'],
    ['negateMinCost', '1e3'],
    ['negateMinCost', '20,5'],
  ])('lehnt %s = %j ab', (key, value) => {
    expect(
      searchTermRulesSchema.safeParse({ ...DEFAULT_SEARCH_TERM_RULES, [key]: value }).success,
    ).toBe(false);
  });

  it('erlaubt 0 als Spend-Grenze und lehnt unbekannte Felder ab', () => {
    expect(
      searchTermRulesSchema.safeParse({ ...DEFAULT_SEARCH_TERM_RULES, negateMinCost: '0' }).success,
    ).toBe(true);
    expect(
      searchTermRulesSchema.safeParse({ ...DEFAULT_SEARCH_TERM_RULES, extra: 1 }).success,
    ).toBe(false);
  });
});

describe('geschützte Begriffe', () => {
  it('normalisiert: klein, Leerraum zusammengefasst, ohne Doppelte und Leere, sortiert', () => {
    expect(normalizeProtectedTerms(['  Nordwind  Lampe ', 'nordwind lampe', 'Hero', ' '])).toEqual([
      'hero',
      'nordwind lampe',
    ]);
  });

  it('begrenzt Anzahl und Länge', () => {
    expect(protectedTermsSchema.safeParse(['a'.repeat(81)]).success).toBe(false);
    expect(
      protectedTermsSchema.safeParse(
        Array.from({ length: MAX_PROTECTED_TERMS + 1 }, (_, i) => `t${i}`),
      ).success,
    ).toBe(false);
    expect(protectedTermsSchema.safeParse(['Nordwind']).success).toBe(true);
  });
});

describe('searchTermAnalysisRequestSchema', () => {
  const base = {
    profileId: '0b0e7c1e-5a55-4c0b-9a39-7f1d0a6d0c11',
    periodStart: '2026-08-01',
    periodEnd: '2026-09-29',
  };

  it('verlangt Profil und einen Zeitraum mit Beginn vor oder am Ende', () => {
    expect(searchTermAnalysisRequestSchema.safeParse(base).success).toBe(true);
    expect(
      searchTermAnalysisRequestSchema.safeParse({ ...base, periodStart: '2026-09-30' }).success,
    ).toBe(false);
    expect(
      searchTermAnalysisRequestSchema.safeParse({ ...base, profileId: undefined }).success,
    ).toBe(false);
  });
});

describe('Abweichende Regeln je Profil (2b.2g)', () => {
  const org = {
    harvestMinPurchases: 3,
    harvestMaxAcos: '0.25',
    negateMinClicks: 25,
    negateMinCost: '20',
  };

  it('nimmt je Feld den Wert des Profils, sonst den der Organisation', () => {
    expect(
      resolveSearchTermRules(org, {
        harvestMinPurchases: null,
        harvestMaxAcos: '0.4',
        negateMinClicks: null,
        negateMinCost: '200',
      }),
    ).toEqual({ ...org, harvestMaxAcos: '0.4', negateMinCost: '200' });
  });

  it('ohne Abweichung gelten die Regeln der Organisation', () => {
    expect(resolveSearchTermRules(org, null)).toEqual(org);
    expect(resolveSearchTermRules(org, NO_SEARCH_TERM_RULE_OVERRIDES)).toEqual(org);
  });

  it('eine Abweichung von 0 Spend zählt als Wert, nicht als leer', () => {
    expect(
      resolveSearchTermRules(org, { ...NO_SEARCH_TERM_RULE_OVERRIDES, negateMinCost: '0' })
        .negateMinCost,
    ).toBe('0');
  });

  it('prüft abweichende Werte wie die Regeln der Organisation, leer ist erlaubt', () => {
    const parse = (patch: Record<string, unknown>) =>
      searchTermRuleOverridesSchema.safeParse({ ...NO_SEARCH_TERM_RULE_OVERRIDES, ...patch })
        .success;
    expect(parse({})).toBe(true);
    expect(parse({ negateMinCost: '200.50', harvestMinPurchases: 1 })).toBe(true);
    expect(parse({ harvestMaxAcos: '0' })).toBe(false);
    expect(parse({ harvestMinPurchases: 0 })).toBe(false);
    expect(parse({ negateMinCost: '1.234' })).toBe(false);
    expect(parse({ fremd: 1 })).toBe(false);
    expect(searchTermRuleOverridesSchema.safeParse({ negateMinCost: '5' }).success).toBe(false);
  });
});
