import { describe, expect, it } from 'vitest';
import {
  AD_CHANGE_FIELDS_BY_ENTITY,
  adChangeFieldKind,
  adChangeInputSchema,
  adChangeAdjustmentIssue,
  adChangeValueIssue,
  normalizeNegativeKeywordText,
  stageAdChangesRequestSchema,
  MAX_AD_CHANGES_PER_REQUEST,
} from './ad-changes';

const ID = '7f1f7a52-0d0b-4b0e-9a55-0a4b7b6a0001';
const OTHER_ID = '7f1f7a52-0d0b-4b0e-9a55-0a4b7b6a0002';

describe('Felder je Entity (phase-3.md F3)', () => {
  it('erlaubt je Entity nur ihre Felder', () => {
    expect(AD_CHANGE_FIELDS_BY_ENTITY.campaign).toEqual([
      'state',
      'budget',
      'bidding_strategy',
      'placement_top',
      'placement_rest_of_search',
      'placement_product_page',
      'placement_amazon_business',
    ]);
    expect(AD_CHANGE_FIELDS_BY_ENTITY.ad_group).toEqual(['state', 'default_bid']);
    expect(AD_CHANGE_FIELDS_BY_ENTITY.target).toEqual(['state', 'bid']);
    expect(AD_CHANGE_FIELDS_BY_ENTITY.product_ad).toEqual(['state']);
    expect(AD_CHANGE_FIELDS_BY_ENTITY.negative_target).toEqual(['state']);
  });

  it('kennt die Art jedes Felds', () => {
    expect(adChangeFieldKind('state')).toBe('enum');
    expect(adChangeFieldKind('bidding_strategy')).toBe('enum');
    expect(adChangeFieldKind('budget')).toBe('money');
    expect(adChangeFieldKind('default_bid')).toBe('money');
    expect(adChangeFieldKind('bid')).toBe('money');
    expect(adChangeFieldKind('placement_top')).toBe('percent');
  });
});

describe('adChangeValueIssue', () => {
  it('lehnt ein Feld ab, das die Entity nicht hat', () => {
    expect(adChangeValueIssue('target', 'budget', '10')).toBe('fieldNotAllowed');
    expect(adChangeValueIssue('product_ad', 'bid', '0.50')).toBe('fieldNotAllowed');
  });

  it('nimmt die drei Zustände, bei Negatives nur das Archivieren', () => {
    for (const state of ['ENABLED', 'PAUSED', 'ARCHIVED']) {
      expect(adChangeValueIssue('campaign', 'state', state)).toBeNull();
    }
    expect(adChangeValueIssue('campaign', 'state', 'enabled')).toBe('invalidValue');
    expect(adChangeValueIssue('negative_target', 'state', 'ARCHIVED')).toBeNull();
    expect(adChangeValueIssue('negative_target', 'state', 'PAUSED')).toBe('invalidValue');
  });

  it('nimmt Beträge als Decimal-String größer 0 mit höchstens zwei Nachkommastellen', () => {
    expect(adChangeValueIssue('target', 'bid', '0.75')).toBeNull();
    expect(adChangeValueIssue('campaign', 'budget', '25')).toBeNull();
    for (const value of ['0', '0.00', '-1', '0.755', '1e2', '1,50', '', ' 1']) {
      expect(adChangeValueIssue('target', 'bid', value), value).toBe('invalidValue');
    }
  });

  it('nimmt Platzierungen als ganze Prozent von 0 bis 900', () => {
    expect(adChangeValueIssue('campaign', 'placement_top', '0')).toBeNull();
    expect(adChangeValueIssue('campaign', 'placement_top', '900')).toBeNull();
    for (const value of ['901', '-1', '12.5', '050', '']) {
      expect(adChangeValueIssue('campaign', 'placement_top', value), value).toBe('invalidValue');
    }
  });

  it('nimmt die setzbaren Gebotsstrategien', () => {
    expect(adChangeValueIssue('campaign', 'bidding_strategy', 'SALES_DOWN_ONLY')).toBeNull();
    expect(adChangeValueIssue('campaign', 'bidding_strategy', 'SALES_UP_AND_DOWN')).toBeNull();
    expect(adChangeValueIssue('campaign', 'bidding_strategy', 'NONE')).toBeNull();
    expect(adChangeValueIssue('campaign', 'bidding_strategy', 'RULE_BASED')).toBe('invalidValue');
  });
});

describe('adChangeInputSchema', () => {
  it('nimmt eine Feldänderung', () => {
    const input = {
      operation: 'update',
      entityType: 'target',
      entityId: ID,
      field: 'bid',
      value: '0.75',
    };
    expect(adChangeInputSchema.parse(input)).toEqual(input);
  });

  it('lehnt unbekannte Felder der Anfrage ab (kein „vorher“ aus dem Browser)', () => {
    const result = adChangeInputSchema.safeParse({
      operation: 'update',
      entityType: 'target',
      entityId: ID,
      field: 'bid',
      value: '0.75',
      before: '0.10',
    });
    expect(result.success).toBe(false);
  });

  it('lehnt einen ungültigen Wert mit Pfad `value` ab', () => {
    const result = adChangeInputSchema.safeParse({
      operation: 'update',
      entityType: 'target',
      entityId: ID,
      field: 'bid',
      value: '0',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['value']);
  });

  it('nimmt ein negatives Keyword und fasst Leerraum zusammen', () => {
    const parsed = adChangeInputSchema.parse({
      operation: 'create_negative',
      campaignId: ID,
      adGroupId: OTHER_ID,
      negative: { type: 'keyword', keywordText: '  LED   Lampe ', matchType: 'EXACT' },
    });
    expect(parsed).toEqual({
      operation: 'create_negative',
      campaignId: ID,
      adGroupId: OTHER_ID,
      negative: { type: 'keyword', keywordText: 'LED Lampe', matchType: 'EXACT' },
    });
  });

  it('nimmt eine negative ASIN auf Kampagnenebene in Großbuchstaben', () => {
    const parsed = adChangeInputSchema.parse({
      operation: 'create_negative',
      campaignId: ID,
      adGroupId: null,
      negative: { type: 'product', asin: 'b0abc12345' },
    });
    expect(parsed).toMatchObject({
      adGroupId: null,
      negative: { type: 'product', asin: 'B0ABC12345' },
    });
  });

  it('lehnt leere und zu lange Keywords, breite Negatives und falsche ASINs ab', () => {
    const negative = (value: unknown) =>
      adChangeInputSchema.safeParse({
        operation: 'create_negative',
        campaignId: ID,
        adGroupId: null,
        negative: value,
      }).success;
    expect(negative({ type: 'keyword', keywordText: '   ', matchType: 'EXACT' })).toBe(false);
    expect(negative({ type: 'keyword', keywordText: 'x'.repeat(81), matchType: 'EXACT' })).toBe(
      false,
    );
    expect(negative({ type: 'keyword', keywordText: 'lampe', matchType: 'BROAD' })).toBe(false);
    expect(negative({ type: 'product', asin: 'B0ABC' })).toBe(false);
  });
});

describe('normalizeNegativeKeywordText', () => {
  it('kürzt Ränder, fasst Leerraum zusammen und normalisiert Unicode, ohne die Schreibung zu ändern', () => {
    expect(normalizeNegativeKeywordText('  Küche \t Lampe ')).toBe('Küche Lampe');
  });
});

describe('stageAdChangesRequestSchema', () => {
  const change = {
    operation: 'update',
    entityType: 'target',
    entityId: ID,
    field: 'bid',
    value: '1',
  };

  it('verlangt mindestens eine Änderung und eine bekannte Herkunft', () => {
    expect(stageAdChangesRequestSchema.safeParse({ origin: 'explorer', changes: [] }).success).toBe(
      false,
    );
    expect(
      stageAdChangesRequestSchema.safeParse({ origin: 'revert', changes: [change] }).success,
    ).toBe(false);
    expect(
      stageAdChangesRequestSchema.safeParse({ origin: 'search_terms', changes: [change] }).success,
    ).toBe(true);
  });

  it('begrenzt die Zahl der Änderungen je Anfrage', () => {
    const changes = Array.from({ length: MAX_AD_CHANGES_PER_REQUEST + 1 }, () => change);
    expect(stageAdChangesRequestSchema.safeParse({ origin: 'explorer', changes }).success).toBe(
      false,
    );
  });
});

describe('Anpassen (±Prozent, ±Betrag; 3.5)', () => {
  const adjust = (patch: Record<string, unknown>) =>
    adChangeInputSchema.safeParse({
      operation: 'adjust',
      entityType: 'target',
      entityId: '00000000-0000-4000-8000-000000000001',
      field: 'bid',
      mode: 'percent',
      value: '10',
      ...patch,
    }).success;

  it('nimmt Prozent und Beträge mit Vorzeichen und höchstens zwei Nachkommastellen', () => {
    for (const value of ['10', '-10', '12.5', '-99.99', '250']) {
      expect(adChangeAdjustmentIssue('percent', value), value).toBeNull();
    }
    for (const value of ['0.05', '-0.10', '3']) {
      expect(adChangeAdjustmentIssue('amount', value), value).toBeNull();
    }
  });

  it('lehnt 0, mehr als zwei Nachkommastellen, andere Schreibweisen und −100 % oder weniger ab', () => {
    for (const value of [
      '0',
      '0.00',
      '-0',
      '1.234',
      '+5',
      '1e2',
      ' 5',
      '5,5',
      '',
      '-100',
      '-100.00',
      '-250',
    ]) {
      expect(adChangeAdjustmentIssue('percent', value), value).toBe('invalidValue');
    }
    expect(adChangeAdjustmentIssue('amount', '-250')).toBeNull();
  });

  it('gilt nur für Budget und Gebote der passenden Entity', () => {
    expect(adjust({})).toBe(true);
    expect(
      adjust({ entityType: 'campaign', field: 'budget', mode: 'amount', value: '-2.50' }),
    ).toBe(true);
    expect(adjust({ entityType: 'campaign', field: 'bid' })).toBe(false);
    expect(adjust({ field: 'state' })).toBe(false);
    expect(adjust({ value: '-100' })).toBe(false);
    expect(adjust({ before: '1' })).toBe(false);
  });
});
