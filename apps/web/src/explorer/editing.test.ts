import { describe, expect, it } from 'vitest';
import type { GridRow } from './columns';
import {
  bulkInputs,
  currentFieldValue,
  editIssue,
  indexOpenChanges,
  openEntry,
  parseMoneyInput,
  parsePercentInput,
  placementPercent,
  type OpenChange,
} from './editing';

const row = (patch: Partial<GridRow> = {}): GridRow =>
  ({
    id: 'e1',
    profileId: 'p1',
    currencyCode: 'EUR',
    adProduct: 'SPONSORED_PRODUCTS',
    name: 'Zeile',
    state: 'ENABLED',
    removed: false,
    placeholder: false,
    attributes: {},
    ...patch,
  }) as GridRow;

const open = (patch: Partial<OpenChange>): OpenChange =>
  ({
    id: 'c1',
    profileId: 'p1',
    status: 'pending',
    channel: null,
    submissionId: null,
    operation: 'update',
    entityType: 'target',
    entityId: 'e1',
    campaignId: 'k1',
    adGroupId: 'g1',
    field: 'bid',
    after: '0.80',
    negative: null,
    mine: true,
    userName: 'Ada',
    ...patch,
  }) as OpenChange;

describe('editIssue', () => {
  it('erlaubt je Ebene nur die Felder der Entity', () => {
    expect(
      editIssue('campaign', row({ attributes: { budgetType: 'DAILY' } }), 'budget'),
    ).toBeNull();
    expect(editIssue('target', row(), 'bid')).toBeNull();
    expect(editIssue('adGroup', row(), 'default_bid')).toBeNull();
    expect(editIssue('productAd', row(), 'state')).toBeNull();
    expect(editIssue('target', row(), 'budget')).toBe('notEditable');
    expect(editIssue('portfolio', row(), 'budget')).toBe('notEditable');
    expect(editIssue('searchTerm', row(), 'state')).toBe('notEditable');
  });

  it('sperrt Summenzeile, entfernte, unbekannte und archivierte Zeilen', () => {
    expect(editIssue('target', row({ isTotal: true }), 'bid')).toBe('notEditable');
    expect(editIssue('target', row({ removed: true }), 'bid')).toBe('entityRemoved');
    expect(editIssue('target', row({ placeholder: true }), 'bid')).toBe('notEditable');
    expect(editIssue('target', row({ state: 'archived' }), 'bid')).toBe('entityArchived');
  });

  it('ändert nur Tagesbudgets und Strategie und Platzierungen nur für Sponsored Products', () => {
    expect(editIssue('campaign', row({ attributes: { budgetType: 'LIFETIME' } }), 'budget')).toBe(
      'budgetNotDaily',
    );
    const sb = row({ adProduct: 'SPONSORED_BRANDS' });
    expect(editIssue('campaign', sb, 'bidding_strategy')).toBe('adProductNotSupported');
    expect(editIssue('campaign', sb, 'placement_top')).toBe('adProductNotSupported');
    expect(editIssue('campaign', row(), 'placement_top')).toBeNull();
  });
});

describe('currentFieldValue', () => {
  it('liest Zustand, Beträge, Strategie und Platzierungen aus der Zeile', () => {
    const campaign = row({
      attributes: {
        budgetAmount: '20',
        biddingStrategy: 'SALES_DOWN_ONLY',
        placementBidAdjustments: [
          { placement: 'PLACEMENT_TOP', percentage: 50 },
          { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: '25' },
        ],
      },
    });
    expect(currentFieldValue(campaign, 'state')).toBe('ENABLED');
    expect(currentFieldValue(campaign, 'budget')).toBe('20');
    expect(currentFieldValue(campaign, 'bidding_strategy')).toBe('SALES_DOWN_ONLY');
    expect(currentFieldValue(campaign, 'placement_top')).toBe('50');
    expect(currentFieldValue(campaign, 'placement_product_page')).toBe('25');
    expect(currentFieldValue(campaign, 'placement_rest_of_search')).toBe('0');
    expect(currentFieldValue(row({ attributes: { bid: '0.5' } }), 'bid')).toBe('0.5');
    expect(currentFieldValue(row(), 'bid')).toBeNull();
    expect(placementPercent(null, 'PLACEMENT_TOP')).toBe('0');
  });
});

describe('indexOpenChanges', () => {
  it('trennt je Stelle die eigene Vormerkung, fremde Vormerkungen und Übermitteltes', () => {
    const index = indexOpenChanges([
      open({ id: 'mine' }),
      open({ id: 'other', mine: false, userName: 'Emil', after: '0.90' }),
      open({ id: 'sent', status: 'submitted', channel: 'bulk_file', after: '0.70' }),
      open({ id: 'state', field: 'state', after: 'PAUSED' }),
      open({ id: 'neg', operation: 'create', entityId: null, field: null }),
    ]);
    const entry = openEntry(index, 'target', 'e1', 'bid')!;
    expect(entry.mine?.id).toBe('mine');
    expect(entry.others.map((c) => c.id)).toEqual(['other']);
    expect(entry.submitted.map((c) => c.id)).toEqual(['sent']);
    expect(openEntry(index, 'target', 'e1', 'state')!.mine?.id).toBe('state');
    expect(openEntry(index, 'productAd', 'e1', 'state')).toBeUndefined();
    expect(openEntry(index, 'target', 'e2', 'bid')).toBeUndefined();
  });
});

describe('Eingaben', () => {
  it('liest Beträge mit Komma oder Punkt, höchstens zwei Nachkommastellen, größer 0', () => {
    expect(parseMoneyInput('0,75')).toBe('0.75');
    expect(parseMoneyInput(' 12.5 ')).toBe('12.5');
    expect(parseMoneyInput('3')).toBe('3');
    for (const text of ['', '0', '0,00', '1,234', '-1', 'abc', '1e3']) {
      expect(parseMoneyInput(text), text).toBeNull();
    }
  });

  it('liest Platzierungen als ganze Prozent von 0 bis 900', () => {
    expect(parsePercentInput('0')).toBe('0');
    expect(parsePercentInput(' 900 ')).toBe('900');
    for (const text of ['', '901', '12,5', '-5', '050']) {
      expect(parsePercentInput(text), text).toBeNull();
    }
  });
});

describe('bulkInputs', () => {
  const rows = [
    row({ id: 'a', attributes: { bid: '0.50' } }),
    row({ id: 'b', currencyCode: 'GBP', attributes: { bid: '0.40' } }),
    row({ id: 'c', state: 'ARCHIVED' }),
  ];

  it('setzt einen festen Wert je Währung und überspringt gesperrte Zeilen mit Grund', () => {
    const result = bulkInputs('target', rows, {
      field: 'bid',
      mode: 'fixed',
      values: { EUR: '0.75', GBP: '0.60' },
    });
    expect(result.inputs).toEqual([
      { operation: 'update', entityType: 'target', entityId: 'a', field: 'bid', value: '0.75' },
      { operation: 'update', entityType: 'target', entityId: 'b', field: 'bid', value: '0.60' },
    ]);
    expect(result.skipped).toEqual([{ id: 'c', reason: 'entityArchived' }]);
  });

  it('gibt Prozent und Beträge mit Vorzeichen als Anpassung an den Server (der rechnet)', () => {
    const percent = bulkInputs('target', rows, {
      field: 'bid',
      mode: 'percent',
      direction: 'decrease',
      value: '10',
    });
    expect(percent.inputs[0]).toEqual({
      operation: 'adjust',
      entityType: 'target',
      entityId: 'a',
      field: 'bid',
      mode: 'percent',
      value: '-10',
    });
    const amount = bulkInputs('target', rows, {
      field: 'bid',
      mode: 'amount',
      direction: 'increase',
      values: { EUR: '0.05', GBP: '0.04' },
    });
    expect(amount.inputs.map((input) => 'value' in input && input.value)).toEqual(['0.05', '0.04']);
  });

  it('ändert den Zustand; Negatives lassen sich nur archivieren', () => {
    const state = bulkInputs('campaign', rows, { field: 'state', value: 'PAUSED' });
    expect(state.inputs).toHaveLength(2);
    expect(state.inputs[0]).toMatchObject({
      entityType: 'campaign',
      field: 'state',
      value: 'PAUSED',
    });
    const negatives = bulkInputs('negative', rows, { field: 'state', value: 'ARCHIVED' });
    expect(negatives.inputs[0]).toMatchObject({ entityType: 'negative_target', value: 'ARCHIVED' });
  });
});
