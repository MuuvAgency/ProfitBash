import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STRUCTURE_CATALOG,
  structureCatalogSchema,
  type StructureCatalog,
} from './structure-catalog';

const clone = (): StructureCatalog => structuredClone(DEFAULT_STRUCTURE_CATALOG);
const issues = (catalog: unknown) => {
  const result = structureCatalogSchema.safeParse(catalog);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

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
  it('verlangt eindeutige Schlüssel von Bausteinen und Presets', () => {
    const catalog = clone();
    catalog.blocks.push({ ...catalog.blocks[0]! });
    expect(issues(catalog)).toContain(`Baustein ${catalog.blocks[0]!.key} gibt es zweimal`);
    const presets = clone();
    presets.presets.push({ ...presets.presets[1]!, isDefault: false });
    expect(issues(presets)).toContain(`Preset ${presets.presets[1]!.key} gibt es zweimal`);
  });

  it('verlangt Kanten zwischen bekannten Bausteinen, ohne Schleife und ohne Kante aus der Marken-Verteidigung', () => {
    const unknown = clone();
    unknown.edges.push({ from: 'SP-AUTO', to: 'SP-GIBT-ES-NICHT' });
    expect(issues(unknown)).toContain('Kante SP-AUTO → SP-GIBT-ES-NICHT: unbekannter Baustein');

    const loop = clone();
    loop.edges.push({ from: 'SP-AUTO', to: 'SP-AUTO' });
    expect(issues(loop)).toContain('Kante SP-AUTO → SP-AUTO: Baustein zeigt auf sich selbst');

    const brand = clone();
    brand.edges.push({ from: 'SP-BRAND-DEF', to: 'SP-KW-EXACT' });
    expect(issues(brand)).toContain(
      'Kante SP-BRAND-DEF → SP-KW-EXACT: Marken-Bausteine graduieren nie',
    );

    const twice = clone();
    twice.edges.push({ ...twice.edges[0]! });
    expect(issues(twice).some((message) => message.endsWith('gibt es zweimal'))).toBe(true);
  });

  it('verlangt Presets aus bekannten Bausteinen und genau einen Standard', () => {
    const unknown = clone();
    unknown.presets[0]!.blocks.push({ block: 'SP-GIBT-ES-NICHT' });
    expect(issues(unknown)).toContain(
      `Preset ${unknown.presets[0]!.key}: unbekannter Baustein SP-GIBT-ES-NICHT`,
    );

    const none = clone();
    for (const preset of none.presets) preset.isDefault = false;
    expect(issues(none)).toContain('Genau ein Preset ist der Standard');

    const empty = clone();
    empty.presets[0]!.blocks = [];
    expect(issues(empty).length).toBeGreaterThan(0);
  });

  it('prüft Werte der Bausteine (Geld als Decimal-String, Platzierungen 0–900 %, Match-Typ nur bei Keywords)', () => {
    const money = clone();
    money.blocks[0]!.defaultBid = '0,50';
    expect(issues(money).length).toBeGreaterThan(0);

    const placement = clone();
    placement.blocks[0]!.placements = { topOfSearch: 901, productPages: 0, restOfSearch: 0 };
    expect(issues(placement).length).toBeGreaterThan(0);

    const match = clone();
    const auto = match.blocks.find((block) => block.targeting === 'auto')!;
    auto.matchType = 'exact';
    expect(issues(match)).toContain(`Baustein ${auto.key}: Match-Typ nur bei Keywords`);
  });

  it('kennt im Namensschema nur bekannte Platzhalter', () => {
    const catalog = clone();
    catalog.naming.pattern = '{adType} | {unbekannt}';
    expect(issues(catalog)).toContain('Unbekannter Platzhalter {unbekannt}');
    catalog.naming.pattern = 'nur Text';
    expect(issues(catalog)).toContain('Das Namensschema braucht mindestens einen Platzhalter');
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
