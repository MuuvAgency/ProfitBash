import { describe, expect, it } from 'vitest';
import {
  classifySheet,
  entityKind,
  mapHeader,
  mapValue,
  normalizeHeader,
  parseBulkAmount,
  parseBulkDate,
  parseBulkId,
  parseTargetExpression,
  BIDDING_STRATEGIES,
  BUDGET_POLICIES,
  BUDGET_TYPES,
  MATCH_TYPES,
  PLACEMENTS,
  STATES,
  TARGETING_TYPES,
} from './bulk-columns';

describe('Kopfzeilen', () => {
  it('normalisiert Schreibweisen, Leerzeichen und Zusätze', () => {
    expect(normalizeHeader('  Campaign Id ')).toBe(normalizeHeader('Campaign ID'));
    expect(normalizeHeader('Kampagnen-ID')).toBe(normalizeHeader('Kampagnen ID'));
    expect(normalizeHeader('ASIN (Nur zu Informationszwecken)')).toBe(normalizeHeader('ASIN'));
    expect(normalizeHeader('Campaign Name (Informational only)')).toBe(
      normalizeHeader('Campaign Name'),
    );
    expect(normalizeHeader('State (Read only)')).toBe(normalizeHeader('state'));
    expect(normalizeHeader('Name\u00a0der  Anzeigengruppe')).toBe(
      normalizeHeader('Name der Anzeigengruppe'),
    );
  });

  it('ordnet deutsche und englische Kopfzeilen denselben Spalten zu', () => {
    const de = mapHeader([
      'Produkt',
      'Entität',
      'Operation',
      'Kampagnen-ID',
      'Anzeigengruppen-ID',
      'Portfolio-ID',
      'Anzeigen-ID',
      'Keyword-ID',
      'Produkt-Targeting-ID',
      'Kampagnenname',
      'Name der Anzeigengruppe',
      'Startdatum',
      'Enddatum',
      'Targeting-Typ',
      'Zustand',
      'Tagesbudget',
      'SKU',
      'ASIN (Nur zu Informationszwecken)',
      'Standardgebot für die Anzeigengruppe',
      'Gebot',
      'Keyword-Text',
      'Übereinstimmungstyp',
      'Gebotsstrategie',
      'Platzierung',
      'Prozentsatz',
      'Ausdruck für Produkt-Targeting',
      'Impressions',
      'Klicks',
      'Ausgaben',
    ]);
    const en = mapHeader([
      'Product',
      'Entity',
      'Operation',
      'Campaign Id',
      'Ad Group Id',
      'Portfolio Id',
      'Ad Id',
      'Keyword Id',
      'Product Targeting Id',
      'Campaign Name',
      'Ad Group Name',
      'Start Date',
      'End Date',
      'Targeting Type',
      'State',
      'Daily Budget',
      'SKU',
      'ASIN (Informational only)',
      'Ad Group Default Bid',
      'Bid',
      'Keyword Text',
      'Match Type',
      'Bidding Strategy',
      'Placement',
      'Percentage',
      'Product Targeting Expression',
      'Impressions',
      'Clicks',
      'Spend',
    ]);
    expect(Object.fromEntries(de)).toEqual(Object.fromEntries(en));
    expect(de.get('entity')).toBe(1);
    expect(de.get('campaignId')).toBe(3);
    expect(de.get('productTargetingExpression')).toBe(25);
    // Kennzahlen (Zeitraumsummen) haben keine Spalte.
    expect([...de.values()]).not.toContain(26);
  });

  it('erkennt SD- und Portfolio-Spalten und nimmt bei Doppelten die erste', () => {
    const sd = mapHeader(['Entität', 'Taktik', 'Kostenart', 'Targeting-ID', 'Targeting-Ausdruck']);
    expect(Object.fromEntries(sd)).toEqual({
      entity: 0,
      tactic: 1,
      costType: 2,
      targetingId: 3,
      targetingExpression: 4,
    });
    const portfolios = mapHeader([
      'Portfolio-ID',
      'Portfolioname',
      'Budget-Betrag',
      'Budgetwährungscode',
      'Budget-Linie',
      'Anfangsdatum des Budgets',
      'Budget-Enddatum',
      'Zustand',
      'Zustand',
    ]);
    expect(Object.fromEntries(portfolios)).toEqual({
      portfolioId: 0,
      portfolioName: 1,
      budgetAmount: 2,
      budgetCurrencyCode: 3,
      budgetPolicy: 4,
      budgetStartDate: 5,
      budgetEndDate: 6,
      state: 7,
    });
    expect(mapHeader(['Budget Currency Code']).get('budgetCurrencyCode')).toBe(0);
  });
});

describe('Blätter', () => {
  it('erkennt Kampagnen-Blätter auf Deutsch und Englisch, tolerant in der Schreibweise', () => {
    expect(classifySheet('Portfolios')).toBe('portfolios');
    expect(classifySheet('Sponsored Products-Kampagnen')).toBe('sp');
    expect(classifySheet('Sponsored Products Campaigns')).toBe('sp');
    expect(classifySheet('Sponsored Brands-Kampagnen')).toBe('sb');
    expect(classifySheet('Sponsored Brands Campaigns')).toBe('sb');
    expect(classifySheet('SB Anzeigengruppe Kampagnen')).toBe('sb');
    expect(classifySheet('SB Multi Ad Group Campaigns')).toBe('sb');
    expect(classifySheet('SB multi-ad group campaigns')).toBe('sb');
    expect(classifySheet('Sponsored Display-Kampagnen')).toBe('sd');
    expect(classifySheet('Sponsored Display Campaigns')).toBe('sd');
  });

  it('übergeht Suchbegriff-Berichte und Hilfsblätter', () => {
    expect(classifySheet('SP Bericht „Suchbegriff“')).toBeNull();
    expect(classifySheet('SB Bericht „Suchbegriff“')).toBeNull();
    expect(classifySheet('SP Search Term Report')).toBeNull();
    expect(classifySheet('Config')).toBeNull();
    expect(classifySheet('Sheet8')).toBeNull();
  });
});

describe('Werte', () => {
  it('bildet Zustände, Targeting-Typen und Match-Typen auf die Schreibweise des Exports ab', () => {
    expect(mapValue(STATES, 'Aktiviert')).toEqual({ value: 'ENABLED', known: true });
    expect(mapValue(STATES, 'enabled')).toEqual({ value: 'ENABLED', known: true });
    expect(mapValue(STATES, 'Angehalten').value).toBe('PAUSED');
    expect(mapValue(STATES, 'paused').value).toBe('PAUSED');
    expect(mapValue(STATES, 'Archiviert').value).toBe('ARCHIVED');
    expect(mapValue(STATES, 'archived').value).toBe('ARCHIVED');
    expect(mapValue(TARGETING_TYPES, 'Manuell').value).toBe('MANUAL');
    expect(mapValue(TARGETING_TYPES, 'Automatisch').value).toBe('AUTO');
    expect(mapValue(TARGETING_TYPES, 'Auto').value).toBe('AUTO');
    expect(mapValue(MATCH_TYPES, 'Genau Passend').value).toBe('EXACT');
    expect(mapValue(MATCH_TYPES, 'exact').value).toBe('EXACT');
    expect(mapValue(MATCH_TYPES, 'Wortgruppe').value).toBe('PHRASE');
    expect(mapValue(MATCH_TYPES, 'Weitgehend').value).toBe('BROAD');
    expect(mapValue(MATCH_TYPES, 'broad').value).toBe('BROAD');
    // Negatives: Die Tabelle trägt die Negation, der Match-Typ wie beim Export ohne Präfix.
    expect(mapValue(MATCH_TYPES, 'Negativ Genau Passend').value).toBe('EXACT');
    expect(mapValue(MATCH_TYPES, 'negativeExact').value).toBe('EXACT');
    expect(mapValue(MATCH_TYPES, 'Negative Wortgruppe').value).toBe('PHRASE');
    expect(mapValue(MATCH_TYPES, 'negativePhrase').value).toBe('PHRASE');
  });

  it('erkennt Gebotsstrategien auch mit geschütztem Leerzeichen und Gedankenstrich', () => {
    expect(mapValue(BIDDING_STRATEGIES, 'Dynamische Gebote\u00a0– nur senken').value).toBe(
      'SALES_DOWN_ONLY',
    );
    expect(mapValue(BIDDING_STRATEGIES, 'Dynamic bids - down only').value).toBe('SALES_DOWN_ONLY');
    expect(mapValue(BIDDING_STRATEGIES, 'Dynamic bids - up and down').value).toBe(
      'SALES_UP_AND_DOWN',
    );
    expect(mapValue(BIDDING_STRATEGIES, 'Dynamische Gebote – erhöhen und senken').value).toBe(
      'SALES_UP_AND_DOWN',
    );
    expect(mapValue(BIDDING_STRATEGIES, 'Feste Gebote').value).toBe('NONE');
    expect(mapValue(BIDDING_STRATEGIES, 'Fixed bid').value).toBe('NONE');
  });

  it('bildet Platzierungen, Budget-Typen und Budget-Linien ab', () => {
    expect(mapValue(PLACEMENTS, 'Top-Platzierung').value).toBe('PLACEMENT_TOP');
    expect(mapValue(PLACEMENTS, 'Placement Top').value).toBe('PLACEMENT_TOP');
    expect(mapValue(PLACEMENTS, 'Platzierung Rest der Suche').value).toBe(
      'PLACEMENT_REST_OF_SEARCH',
    );
    expect(mapValue(PLACEMENTS, 'Placement Product Page').value).toBe('PLACEMENT_PRODUCT_PAGE');
    expect(mapValue(PLACEMENTS, 'Platzierung für Amazon Business').value).toBe(
      'SITE_AMAZON_BUSINESS',
    );
    expect(mapValue(BUDGET_TYPES, 'daily').value).toBe('DAILY');
    expect(mapValue(BUDGET_TYPES, 'Lifetime').value).toBe('LIFETIME');
    expect(mapValue(BUDGET_POLICIES, 'Keine Obergrenze').value).toBe('NO_CAP');
    expect(mapValue(BUDGET_POLICIES, 'Date Range').value).toBe('DATE_RANGE');
  });

  it('reicht unbekannte Werte unverändert durch', () => {
    expect(mapValue(STATES, ' Irgendwas Neues ')).toEqual({
      value: 'Irgendwas Neues',
      known: false,
    });
  });

  it('erkennt Entity-Typen auf Deutsch und Englisch', () => {
    expect(entityKind('Kampagne')).toBe('campaign');
    expect(entityKind('Campaign')).toBe('campaign');
    expect(entityKind('Anzeigengruppe')).toBe('adGroup');
    expect(entityKind('Ad Group')).toBe('adGroup');
    expect(entityKind('Produktanzeige')).toBe('productAd');
    expect(entityKind('Product Ad')).toBe('productAd');
    expect(entityKind('Keyword')).toBe('keyword');
    expect(entityKind('Negatives Keyword')).toBe('negativeKeyword');
    expect(entityKind('Negative Keyword')).toBe('negativeKeyword');
    expect(entityKind('Campaign Negative Keyword')).toBe('campaignNegativeKeyword');
    expect(entityKind('Negatives Keyword auf Kampagnenebene')).toBe('campaignNegativeKeyword');
    expect(entityKind('Produkt-Targeting')).toBe('productTargeting');
    expect(entityKind('Product Targeting')).toBe('productTargeting');
    expect(entityKind('Negatives Produkt-Targeting')).toBe('negativeProductTargeting');
    expect(entityKind('Campaign Negative Product Targeting')).toBe(
      'campaignNegativeProductTargeting',
    );
    expect(entityKind('Gebotsanpassung')).toBe('biddingAdjustment');
    expect(entityKind('Bidding Adjustment')).toBe('biddingAdjustment');
    expect(entityKind('Audience Targeting')).toBe('audienceTargeting');
    expect(entityKind('Contextual Targeting')).toBe('contextualTargeting');
    expect(entityKind('Portfolio')).toBe('portfolio');
    expect(entityKind('Video Ad')).toBe('unsupported');
    expect(entityKind('Etwas anderes')).toBeNull();
  });
});

describe('Zellen', () => {
  it('normalisiert Beträge mit Gleitkomma-Resten auf 15 signifikante Stellen', () => {
    expect(parseBulkAmount('123.45000000000002')).toBe('123.45');
    expect(parseBulkAmount('0.7499999999999999')).toBe('0.75');
    expect(parseBulkAmount('1E-3')).toBe('0.001');
    expect(parseBulkAmount('25')).toBe('25');
    expect(parseBulkAmount(' 0 ')).toBe('0');
    expect(parseBulkAmount('')).toBeNull();
    expect(parseBulkAmount('0,75')).toBe('invalid');
    expect(parseBulkAmount('abc')).toBe('invalid');
    expect(parseBulkAmount('1e999')).toBe('invalid');
  });

  it('liest Tage YYYYMMDD', () => {
    expect(parseBulkDate('20260115')).toBe('2026-01-15');
    expect(parseBulkDate('')).toBeNull();
    expect(parseBulkDate('20261332')).toBe('invalid');
    expect(parseBulkDate('46000')).toBe('invalid');
  });

  it('nimmt IDs nur als Ziffern-Text, nie aus Zahlzellen', () => {
    expect(parseBulkId('123456789012345', false)).toBe('123456789012345');
    expect(parseBulkId(' 123456789012 ', false)).toBe('123456789012');
    expect(parseBulkId('', false)).toBeNull();
    expect(parseBulkId('123456789012345', true)).toBe('invalid');
    expect(parseBulkId('1.23456789012345E+14', false)).toBe('invalid');
  });
});

describe('Ausdrücke für Produkt-Targeting', () => {
  it('liefert ASIN-, Kategorie- und Auto-Targets in der Form des Exports', () => {
    expect(parseTargetExpression('asin="B0WALDKAUZ1"', '')).toEqual({
      known: true,
      targetType: 'product',
      matchType: 'PRODUCT_EXACT',
      expression: { matchType: 'PRODUCT_EXACT', asin: 'B0WALDKAUZ1' },
    });
    expect(parseTargetExpression('close-match', '')).toEqual({
      known: true,
      targetType: 'auto',
      matchType: 'SEARCH_CLOSE_MATCH',
      expression: { matchType: 'SEARCH_CLOSE_MATCH' },
    });
    expect(parseTargetExpression('loose-match', '').matchType).toBe('SEARCH_LOOSE_MATCH');
    expect(parseTargetExpression('substitutes', '').matchType).toBe('ASIN_SUBSTITUTE_RELATED');
    expect(parseTargetExpression('complements', '').matchType).toBe('ASIN_ACCESSORY_RELATED');
    expect(
      parseTargetExpression(
        'category="123456" brand="789" price-less-than="20"',
        'category="Waldschuhe" brand="Waldkauz" price-less-than="20"',
      ),
    ).toEqual({
      known: true,
      targetType: 'category',
      matchType: null,
      expression: {
        productCategoryId: '123456',
        productCategoryResolved: 'Waldschuhe',
        productBrand: '789',
        productBrandResolved: 'Waldkauz',
        productPriceLessThan: '20',
      },
    });
  });

  it('liest SD-Zielgruppen und unbekannte Ausdrücke als Text', () => {
    expect(parseTargetExpression('views=(exactProduct lookback=30)', '')).toEqual({
      known: true,
      targetType: 'audience',
      matchType: null,
      expression: {
        event: 'VIEWS',
        lookback: 30,
        bulkExpression: 'views=(exactProduct lookback=30)',
      },
    });
    expect(parseTargetExpression('audience="424242"', '')).toEqual({
      known: true,
      targetType: 'audience',
      matchType: null,
      expression: { audienceId: '424242' },
    });
    expect(parseTargetExpression('etwas=neues', '')).toEqual({
      known: false,
      targetType: 'product',
      matchType: null,
      expression: { bulkExpression: 'etwas=neues' },
    });
  });
});
