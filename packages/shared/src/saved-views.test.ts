import { describe, expect, it } from 'vitest';
import {
  MAX_SAVED_VIEW_NAME_LENGTH,
  savedViewCreateSchema,
  savedViewPatchSchema,
  savedViewStateSchema,
} from './saved-views';

const CLIENT = '5b0c2c3e-7f1a-4c43-9d7e-2f0f5c1a9b01';
const PROFILE = '5b0c2c3e-7f1a-4c43-9d7e-2f0f5c1a9b02';

const filters = {
  clientIds: [CLIENT],
  withoutClient: false,
  profileIds: [PROFILE],
  period: { preset: 'last30' },
  comparison: 'previous',
  currency: 'auto',
  attribution: 'console',
};

const explorer = {
  level: 'target',
  drill: { portfolioId: null, campaignId: CLIENT, adGroupId: null },
  includeRemoved: false,
  adProducts: ['SPONSORED_PRODUCTS'],
  chartMetrics: ['cost', 'sales'],
  columns: ['name', 'cost', 'sales'],
  sort: { column: 'cost', direction: 'desc' },
};

describe('Zustand gespeicherter Ansichten (F8)', () => {
  it('nimmt die Filterleiste und im Explorer Ebene, Drill-Down, Spalten, Chart und Sortierung', () => {
    expect(savedViewStateSchema.parse({ filters, explorer })).toEqual({ filters, explorer });
    expect(savedViewStateSchema.parse({ filters })).toEqual({ filters });
  });

  it('prüft Zeitraum, Vergleich, Währung und IDs', () => {
    const bad = (patch: Record<string, unknown>) =>
      savedViewStateSchema.safeParse({ filters: { ...filters, ...patch } }).success;
    expect(bad({ period: { preset: 'last99' } })).toBe(false);
    expect(bad({ period: { preset: 'custom' } })).toBe(false);
    expect(
      bad({ period: { preset: 'custom', range: { from: '2026-09-01', to: '2026-09-10' } } }),
    ).toBe(true);
    expect(bad({ comparison: 'never' })).toBe(false);
    expect(bad({ currency: 'eur' })).toBe(false);
    expect(bad({ profileIds: ['keine-uuid'] })).toBe(false);
    expect(bad({ profileIds: null })).toBe(true);
  });

  it('lehnt unbekannte Ebenen, Kennzahlen und Spaltennamen ab', () => {
    const bad = (patch: Record<string, unknown>) =>
      savedViewStateSchema.safeParse({ filters, explorer: { ...explorer, ...patch } }).success;
    expect(bad({ level: 'keyword' })).toBe(false);
    expect(bad({ chartMetrics: ['cost', 'profit'] })).toBe(false);
    expect(bad({ columns: ['<script>'] })).toBe(false);
    expect(bad({ sort: { column: 'cost', direction: 'up' } })).toBe(false);
    expect(bad({ columns: null, sort: null })).toBe(true);
  });
});

describe('Anlegen und Ändern', () => {
  it('kürzt den Namen und verlangt einen Explorer-Teil genau im Bereich „explorer“', () => {
    expect(
      savedViewCreateSchema.parse({
        name: '  Top-Targets ',
        area: 'explorer',
        state: { filters, explorer },
      }).name,
    ).toBe('Top-Targets');
    expect(
      savedViewCreateSchema.safeParse({ name: 'A', area: 'explorer', state: { filters } }).success,
    ).toBe(false);
    expect(
      savedViewCreateSchema.safeParse({
        name: 'A',
        area: 'dashboard',
        state: { filters, explorer },
      }).success,
    ).toBe(false);
    expect(
      savedViewCreateSchema.safeParse({ name: '   ', area: 'dashboard', state: { filters } })
        .success,
    ).toBe(false);
    expect(
      savedViewCreateSchema.safeParse({
        name: 'x'.repeat(MAX_SAVED_VIEW_NAME_LENGTH + 1),
        area: 'dashboard',
        state: { filters },
      }).success,
    ).toBe(false);
  });

  it('ändert Name, Freigabe oder Zustand, aber nie nichts', () => {
    expect(savedViewPatchSchema.safeParse({}).success).toBe(false);
    expect(savedViewPatchSchema.parse({ shared: true })).toEqual({ shared: true });
  });
});
