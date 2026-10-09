import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRUCTURE_CATALOG,
  structureCatalogSchema,
  type StructureCatalog,
} from './structure-catalog';

const clone = (): StructureCatalog => structuredClone(DEFAULT_STRUCTURE_CATALOG);
const issues = (catalog: unknown) => {
  const result = structureCatalogSchema.safeParse(catalog);
  return result.success ? [] : result.error.issues;
};
/** Befunde der eigenen Prüfung als `{ issue, ...Parameter }`. */
const found = (catalog: unknown) =>
  issues(catalog).flatMap((issue) =>
    issue.code === 'custom' ? [issue.params as { issue: string } & Record<string, unknown>] : [],
  );

describe('Startwerte des Struktur-Katalogs', () => {
  it('sind gültig', () => {
    expect(issues(DEFAULT_STRUCTURE_CATALOG)).toEqual([]);
  });

  it('haben sechs Presets, genau eines als Standard', () => {
    expect(DEFAULT_STRUCTURE_CATALOG.presets).toHaveLength(6);
    expect(DEFAULT_STRUCTURE_CATALOG.presets.filter((preset) => preset.isDefault)).toHaveLength(1);
  });

  it('bieten Phrase nur als Option: kein Preset nutzt sie, alle Keyword-Presets nutzen Breit-Cluster', () => {
    const phrase = DEFAULT_STRUCTURE_CATALOG.blocks.filter((block) => block.matchType === 'phrase');
    expect(phrase).toHaveLength(1);
    for (const preset of DEFAULT_STRUCTURE_CATALOG.presets) {
      expect(preset.blocks.map((entry) => entry.block)).not.toContain(phrase[0]!.key);
    }
  });

  it('lassen die Marken-Verteidigung ohne ausgehende Kante', () => {
    const brand = DEFAULT_STRUCTURE_CATALOG.blocks.filter((block) => block.source === 'brand');
    expect(brand.length).toBeGreaterThan(0);
    for (const block of brand) {
      expect(DEFAULT_STRUCTURE_CATALOG.edges.some((edge) => edge.from === block.key)).toBe(false);
    }
  });

  it('kennen alle Anzeigentypen, Display nur mit CPC-Optimierung', () => {
    const types = new Set(DEFAULT_STRUCTURE_CATALOG.blocks.map((block) => block.adProduct));
    expect([...types].sort()).toEqual(['SB', 'SD', 'SP']);
    for (const block of DEFAULT_STRUCTURE_CATALOG.blocks.filter((b) => b.adProduct === 'SD')) {
      expect(['clicks', 'conversions']).toContain(block.sdOptimization);
    }
  });

  it('nutzen englische Kürzel im Namensschema', () => {
    expect(DEFAULT_STRUCTURE_CATALOG.naming.pattern).toBe(
      '{adType} | {block} | {group} | {target}',
    );
    const codes = DEFAULT_STRUCTURE_CATALOG.blocks.map((block) => block.code);
    expect(codes).toEqual(expect.arrayContaining(['AUTO', 'BROAD', 'EXACT', 'EXACT1', 'BRAND']));
  });
});

describe('Prüfung eines geänderten Katalogs', () => {
  it('verlangt eindeutige Schlüssel von Bausteinen und Presets und eindeutige Kürzel je Anzeigentyp', () => {
    const catalog = clone();
    catalog.blocks.push({ ...catalog.blocks[0]! });
    expect(found(catalog)).toContainEqual({ issue: 'duplicateBlock', key: 'SP-AUTO' });
    const presets = clone();
    presets.presets.push({ ...presets.presets[1]!, isDefault: false });
    expect(found(presets)).toContainEqual({ issue: 'duplicatePreset', key: 'control' });
    const codes = clone();
    codes.blocks.find((block) => block.key === 'SP-KW-PHRASE')!.code = 'EXACT';
    expect(found(codes)).toContainEqual({ issue: 'duplicateCode', code: 'EXACT', adProduct: 'SP' });
    // Dasselbe Kürzel in verschiedenen Anzeigentypen ist erlaubt (der Name trägt den Typ).
    expect(issues(DEFAULT_STRUCTURE_CATALOG)).toEqual([]);
  });

  it('verlangt Kanten zwischen bekannten Bausteinen, ohne Schleife und ohne Kante aus der Marken-Verteidigung', () => {
    const unknown = clone();
    unknown.edges.push({ from: 'SP-AUTO', to: 'SP-GIBT-ES-NICHT' });
    expect(found(unknown)).toContainEqual({
      issue: 'edgeUnknownBlock',
      from: 'SP-AUTO',
      to: 'SP-GIBT-ES-NICHT',
    });

    const self = clone();
    self.edges.push({ from: 'SP-AUTO', to: 'SP-AUTO' });
    expect(found(self)).toContainEqual({ issue: 'edgeCycle', key: 'SP-AUTO' });

    const cycle = clone();
    cycle.edges.push({ from: 'SP-KW-EXACT', to: 'SP-AUTO' });
    expect(found(cycle).some((issue) => issue.issue === 'edgeCycle')).toBe(true);

    const brand = clone();
    brand.edges.push({ from: 'SP-BRAND-DEF', to: 'SP-KW-EXACT' });
    expect(found(brand)).toContainEqual({
      issue: 'edgeFromBrand',
      from: 'SP-BRAND-DEF',
      to: 'SP-KW-EXACT',
    });

    const twice = clone();
    twice.edges.push({ ...twice.edges[0]! });
    expect(found(twice).some((issue) => issue.issue === 'duplicateEdge')).toBe(true);
  });

  it('verlangt Presets aus bekannten Bausteinen, passende Abweichungen und genau einen Standard', () => {
    const unknown = clone();
    unknown.presets[0]!.blocks.push({ block: 'SP-GIBT-ES-NICHT' });
    expect(found(unknown)).toContainEqual({
      issue: 'presetUnknownBlock',
      preset: 'muuv-standard',
      block: 'SP-GIBT-ES-NICHT',
    });

    const none = clone();
    for (const preset of none.presets) preset.isDefault = false;
    expect(found(none)).toContainEqual({ issue: 'oneDefault' });

    const empty = clone();
    empty.presets[0]!.blocks = [];
    expect(issues(empty).length).toBeGreaterThan(0);

    const top = clone();
    top.presets[0]!.blocks.push({ block: 'SD-CAT', topOfSearch: 20 });
    expect(found(top)).toContainEqual({
      issue: 'presetTopWithoutPlacements',
      preset: 'muuv-standard',
      block: 'SD-CAT',
    });
    const lookback = clone();
    lookback.presets[0]!.blocks[0]!.lookbackDays = 30;
    expect(found(lookback)).toContainEqual({
      issue: 'presetLookbackWithoutAudience',
      preset: 'muuv-standard',
      block: 'SP-AUTO',
    });
  });

  it('prüft Werte der Bausteine (Geld als Decimal-String, Platzierungen 0–900 %, Felder je Art)', () => {
    const money = clone();
    money.blocks[0]!.defaultBid = '0,50';
    expect(issues(money).length).toBeGreaterThan(0);

    const placement = clone();
    placement.blocks[0]!.placements = { topOfSearch: 901, productPages: 0, restOfSearch: 0 };
    expect(issues(placement).length).toBeGreaterThan(0);

    const match = clone();
    match.blocks[0]!.matchType = 'exact';
    expect(found(match)).toContainEqual({ issue: 'matchTypeOnlyKeyword', key: 'SP-AUTO' });

    const lookback = clone();
    lookback.blocks[0]!.lookbackDays = 30;
    expect(found(lookback)).toContainEqual({ issue: 'lookbackOnlyAudience', key: 'SP-AUTO' });
    const missing = clone();
    missing.blocks.find((block) => block.key === 'SD-RT-VIEWS')!.lookbackDays = null;
    expect(found(missing)).toContainEqual({ issue: 'audienceNeedsLookback', key: 'SD-RT-VIEWS' });
    const kind = clone();
    kind.blocks.find((block) => block.key === 'SD-RT-VIEWS')!.audience = null;
    kind.blocks[0]!.audience = 'views';
    expect(found(kind)).toEqual(
      expect.arrayContaining([
        { issue: 'audienceKind', key: 'SD-RT-VIEWS' },
        { issue: 'audienceKind', key: 'SP-AUTO' },
      ]),
    );
  });

  it('kennt im Namensschema nur bekannte Platzhalter', () => {
    const catalog = clone();
    catalog.naming.pattern = '{adType} | {unbekannt}';
    expect(found(catalog)).toContainEqual({ issue: 'namingUnknownPlaceholder', name: 'unbekannt' });
    catalog.naming.pattern = 'nur Text';
    expect(found(catalog)).toContainEqual({ issue: 'namingNoPlaceholder' });
  });

  it('nennt bei Fehlern in Feldern den Pfad (für die Meldung in der Oberfläche)', () => {
    const money = clone();
    money.blocks[2]!.defaultBid = 'abc';
    const result = structureCatalogSchema.safeParse(money);
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.path).toEqual(['blocks', 2, 'defaultBid']);
  });
});

describe('effectivePreset', () => {
  it('nimmt die Produktgruppe vor dem Client vor dem Standard; unbekannte Schlüssel zählen nicht', async () => {
    const { effectivePreset } = await import('./structure-catalog');
    const catalog = DEFAULT_STRUCTURE_CATALOG;
    expect(effectivePreset(catalog, {}).key).toBe('muuv-standard');
    expect(effectivePreset(catalog, { client: 'launch' }).key).toBe('launch');
    expect(effectivePreset(catalog, { client: 'launch', productGroup: 'control' }).key).toBe(
      'control',
    );
    expect(effectivePreset(catalog, { client: 'launch', productGroup: 'geloescht' }).key).toBe(
      'launch',
    );
  });
});
