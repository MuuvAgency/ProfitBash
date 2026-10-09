import { z } from 'zod';

/**
 * Struktur-Katalog (`docs/tasks/phase-4.md` 4.2, Ideen-Dokument C.2b, F-S8): **Bausteine** (eine Art von Kampagne),
 * **Graduation-Kanten** („Gewinner aus A kommen nach B“), **Presets** (Auswahl von Bausteinen mit Parametern) und das
 * **Namensschema**. Je Organisation ein Dokument, geprüft mit `structureCatalogSchema`; ohne gespeichertes Dokument gelten
 * die Startwerte `DEFAULT_STRUCTURE_CATALOG`. Werte und Bezeichnungen sind eigene (Eigenständigkeit, `CLAUDE.md`).
 *
 * Beträge (Standardgebot, Tagesbudget) sind Decimal-Strings in **EUR**: Der Katalog gilt für alle Marktplätze, die
 * Plan-Engine (4.3) rechnet sie mit dem Tageskurs in die Währung des Profils um und prüft die Grenzen von Amazon.
 * vCPM und Off-Amazon kennt der Katalog bewusst nicht (F-S7: gesperrt, nur je Kampagne im Setup freischaltbar).
 */

export const CATALOG_AD_PRODUCTS = ['SP', 'SB', 'SD'] as const;
export type CatalogAdProduct = (typeof CATALOG_AD_PRODUCTS)[number];

/** `audience`: Zielgruppen von Sponsored Display (Views, Käufe). */
export const BLOCK_TARGETINGS = ['auto', 'keyword', 'product', 'category', 'audience'] as const;
export const BLOCK_MATCH_TYPES = ['broad', 'phrase', 'exact'] as const;
/** Produkt-Targeting: genau diese ASIN oder „ähnlich wie“ (erweitert). */
export const BLOCK_PRODUCT_MATCHES = ['exact', 'expanded'] as const;
/** Kampagne : Anzeigen : Targets (Ideen-Dokument C.1); die Ad Group ist immer eine. */
export const BLOCK_STRUCTURES = ['1:1:1', '1:1:n', '1:n:1'] as const;
/** Woher die Ziele kommen: allgemeine Begriffe, eigene Marke, Wettbewerber, eigene Produkte. */
export const BLOCK_SOURCES = ['generic', 'brand', 'competitor', 'own'] as const;
/** Gebotsstrategie für SP (wie `AD_CHANGE_BIDDING_STRATEGIES`). */
export const BLOCK_BIDDING_STRATEGIES = ['SALES_DOWN_ONLY', 'SALES_UP_AND_DOWN', 'NONE'] as const;
/** Gebotsoptimierung für SD; nur CPC-Varianten (vCPM gesperrt, F-S7). */
export const BLOCK_SD_OPTIMIZATIONS = ['clicks', 'conversions'] as const;

/** Platzhalter des Namensschemas. */
export const NAMING_PLACEHOLDERS = [
  'adType',
  'block',
  'group',
  'target',
  'client',
  'country',
] as const;
export type NamingPlaceholder = (typeof NAMING_PLACEHOLDERS)[number];

export const MAX_CATALOG_BLOCKS = 60;
export const MAX_CATALOG_EDGES = 200;
export const MAX_CATALOG_PRESETS = 30;
export const MAX_PRESET_BLOCKS = 30;
export const MAX_PLACEMENT_PERCENT = 900;
export const MAX_NAMING_PATTERN_LENGTH = 120;

const KEY = /^[A-Z0-9]+(-[A-Z0-9]+)*$/;
const PRESET_KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Betrag mit höchstens zwei Nachkommastellen, Punkt als Trenner. */
const MONEY = /^\d{1,7}(\.\d{1,2})?$/;

const text = (max: number) =>
  z
    .string()
    .transform((value) => value.normalize('NFC').split(/\s+/u).filter(Boolean).join(' '))
    .pipe(z.string().min(1).max(max));
const money = z.string().regex(MONEY);
const percent = z.number().int().min(0).max(MAX_PLACEMENT_PERCENT);

export const catalogBlockSchema = z.strictObject({
  /** Fester Schlüssel (`SP-KW-EXACT`); Kanten, Presets und Zuordnungen verweisen darauf. */
  key: z.string().max(32).regex(KEY),
  /** Kürzel im Kampagnennamen (`EXACT`). */
  code: z.string().max(16).regex(KEY),
  label: text(60),
  description: z.string().max(400).default(''),
  adProduct: z.enum(CATALOG_AD_PRODUCTS),
  targeting: z.enum(BLOCK_TARGETINGS),
  matchType: z.enum(BLOCK_MATCH_TYPES).nullable().default(null),
  productMatch: z.enum(BLOCK_PRODUCT_MATCHES).nullable().default(null),
  structure: z.enum(BLOCK_STRUCTURES),
  source: z.enum(BLOCK_SOURCES),
  /** Nur SP. */
  biddingStrategy: z.enum(BLOCK_BIDDING_STRATEGIES).nullable().default(null),
  /** Nur SD. */
  sdOptimization: z.enum(BLOCK_SD_OPTIMIZATIONS).nullable().default(null),
  /** EUR, Decimal-String. */
  defaultBid: money,
  /** EUR je Tag, Decimal-String. */
  dailyBudget: money,
  /** Gebotsanpassungen in Prozent (nur SP). */
  placements: z
    .strictObject({ topOfSearch: percent, productPages: percent, restOfSearch: percent })
    .nullable()
    .default(null),
  /** Rückblick der Zielgruppe in Tagen (nur SD-Retargeting). */
  lookbackDays: z.number().int().min(1).max(365).nullable().default(null),
});
export type CatalogBlock = z.output<typeof catalogBlockSchema>;

export const catalogEdgeSchema = z.strictObject({
  from: z.string().regex(KEY),
  to: z.string().regex(KEY),
});
export type CatalogEdge = z.output<typeof catalogEdgeSchema>;

/** Abweichungen eines Presets vom Baustein. */
export const presetBlockSchema = z.strictObject({
  block: z.string().regex(KEY),
  defaultBid: money.optional(),
  dailyBudget: money.optional(),
  topOfSearch: percent.optional(),
  lookbackDays: z.number().int().min(1).max(365).optional(),
});
export type PresetBlock = z.output<typeof presetBlockSchema>;

export const catalogPresetSchema = z.strictObject({
  key: z.string().max(32).regex(PRESET_KEY),
  name: text(60),
  description: z.string().max(400).default(''),
  /** Bausteine in der Reihenfolge, in der das Setup sie anlegt. */
  blocks: z.array(presetBlockSchema).min(1).max(MAX_PRESET_BLOCKS),
  isDefault: z.boolean().default(false),
});
export type CatalogPreset = z.output<typeof catalogPresetSchema>;

const PLACEHOLDER = /\{([^{}]*)\}/g;

/** Platzhalter in einem Muster, in der Reihenfolge des Vorkommens. */
export function namingPlaceholders(pattern: string): string[] {
  return [...pattern.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

export const namingSchema = z
  .strictObject({ pattern: z.string().trim().min(1).max(MAX_NAMING_PATTERN_LENGTH) })
  .superRefine((naming, ctx) => {
    const found = namingPlaceholders(naming.pattern);
    if (found.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Das Namensschema braucht mindestens einen Platzhalter',
      });
    }
    for (const name of found) {
      if (!(NAMING_PLACEHOLDERS as readonly string[]).includes(name)) {
        ctx.addIssue({ code: 'custom', message: `Unbekannter Platzhalter {${name}}` });
      }
    }
  });

export const structureCatalogSchema = z
  .strictObject({
    blocks: z.array(catalogBlockSchema).min(1).max(MAX_CATALOG_BLOCKS),
    edges: z.array(catalogEdgeSchema).max(MAX_CATALOG_EDGES),
    presets: z.array(catalogPresetSchema).min(1).max(MAX_CATALOG_PRESETS),
    naming: namingSchema,
  })
  .superRefine((catalog, ctx) => {
    const add = (message: string) => ctx.addIssue({ code: 'custom', message });
    const blocks = new Map<string, CatalogBlock>();
    for (const block of catalog.blocks) {
      if (blocks.has(block.key)) add(`Baustein ${block.key} gibt es zweimal`);
      blocks.set(block.key, block);
      if (block.matchType !== null && block.targeting !== 'keyword') {
        add(`Baustein ${block.key}: Match-Typ nur bei Keywords`);
      }
      if (block.targeting === 'keyword' && block.matchType === null) {
        add(`Baustein ${block.key}: Keywords brauchen einen Match-Typ`);
      }
      if (block.productMatch !== null && block.targeting !== 'product') {
        add(`Baustein ${block.key}: Produkt-Match nur bei Produkt-Targets`);
      }
      if (block.biddingStrategy !== null && block.adProduct !== 'SP') {
        add(`Baustein ${block.key}: Gebotsstrategie nur bei Sponsored Products`);
      }
      if (block.placements !== null && block.adProduct !== 'SP') {
        add(`Baustein ${block.key}: Platzierungen nur bei Sponsored Products`);
      }
      if (block.adProduct === 'SD' && block.sdOptimization === null) {
        add(`Baustein ${block.key}: Sponsored Display braucht eine Gebotsoptimierung`);
      }
      if (block.sdOptimization !== null && block.adProduct !== 'SD') {
        add(`Baustein ${block.key}: Gebotsoptimierung nur bei Sponsored Display`);
      }
      if (block.targeting === 'audience' && block.adProduct !== 'SD') {
        add(`Baustein ${block.key}: Zielgruppen nur bei Sponsored Display`);
      }
      if (block.targeting === 'auto' && block.adProduct !== 'SP') {
        add(`Baustein ${block.key}: Automatisch nur bei Sponsored Products`);
      }
    }

    const edges = new Set<string>();
    for (const edge of catalog.edges) {
      const label = `Kante ${edge.from} → ${edge.to}`;
      const id = `${edge.from}>${edge.to}`;
      if (edges.has(id)) add(`${label} gibt es zweimal`);
      edges.add(id);
      if (!blocks.has(edge.from) || !blocks.has(edge.to)) add(`${label}: unbekannter Baustein`);
      else if (edge.from === edge.to) add(`${label}: Baustein zeigt auf sich selbst`);
      else if (blocks.get(edge.from)!.source === 'brand') {
        add(`${label}: Marken-Bausteine graduieren nie`);
      }
    }

    const presets = new Set<string>();
    for (const preset of catalog.presets) {
      if (presets.has(preset.key)) add(`Preset ${preset.key} gibt es zweimal`);
      presets.add(preset.key);
      const used = new Set<string>();
      for (const entry of preset.blocks) {
        if (!blocks.has(entry.block))
          add(`Preset ${preset.key}: unbekannter Baustein ${entry.block}`);
        if (used.has(entry.block)) add(`Preset ${preset.key}: Baustein ${entry.block} zweimal`);
        used.add(entry.block);
      }
    }
    if (catalog.presets.filter((preset) => preset.isDefault).length !== 1) {
      add('Genau ein Preset ist der Standard');
    }
  })
  .meta({ id: 'StructureCatalog' });
export type StructureCatalog = z.output<typeof structureCatalogSchema>;
export type StructureCatalogInput = z.input<typeof structureCatalogSchema>;

// ---------------------------------------------------------------------------
// Startwerte (eigene Werte, Dominik korrigiert sie in der Oberfläche; F4)
// ---------------------------------------------------------------------------

type BlockSeed = Omit<
  CatalogBlock,
  | 'matchType'
  | 'productMatch'
  | 'biddingStrategy'
  | 'sdOptimization'
  | 'placements'
  | 'lookbackDays'
> &
  Partial<CatalogBlock>;

const spBlock = (seed: BlockSeed): CatalogBlock => ({
  matchType: null,
  productMatch: null,
  biddingStrategy: 'SALES_DOWN_ONLY',
  sdOptimization: null,
  placements: { topOfSearch: 0, productPages: 0, restOfSearch: 0 },
  lookbackDays: null,
  ...seed,
});
const otherBlock = (seed: BlockSeed): CatalogBlock => ({
  matchType: null,
  productMatch: null,
  biddingStrategy: null,
  sdOptimization: null,
  placements: null,
  lookbackDays: null,
  ...seed,
});

const DEFAULT_BLOCKS: CatalogBlock[] = [
  spBlock({
    key: 'SP-AUTO',
    code: 'AUTO',
    label: 'Automatisch',
    description: 'Automatische Ausspielung zum Finden neuer Suchbegriffe und Produkte.',
    adProduct: 'SP',
    targeting: 'auto',
    structure: '1:1:n',
    source: 'generic',
    defaultBid: '0.45',
    dailyBudget: '15',
  }),
  spBlock({
    key: 'SP-KW-BROAD-CLUSTER',
    code: 'BROAD',
    label: 'Breit-Cluster',
    description:
      'Weitgehend passende Keywords, gebündelt je Themen-Cluster (Standard statt Phrase).',
    adProduct: 'SP',
    targeting: 'keyword',
    matchType: 'broad',
    structure: '1:1:n',
    source: 'generic',
    defaultBid: '0.55',
    dailyBudget: '15',
  }),
  spBlock({
    key: 'SP-KW-PHRASE',
    code: 'PHRASE',
    label: 'Phrase',
    description: 'Wortgruppe; optional, kein Start-Preset nutzt sie.',
    adProduct: 'SP',
    targeting: 'keyword',
    matchType: 'phrase',
    structure: '1:1:n',
    source: 'generic',
    defaultBid: '0.60',
    dailyBudget: '10',
  }),
  spBlock({
    key: 'SP-KW-EXACT',
    code: 'EXACT',
    label: 'Exakt',
    description: 'Mehrere exakte Keywords in einer Kampagne.',
    adProduct: 'SP',
    targeting: 'keyword',
    matchType: 'exact',
    structure: '1:1:n',
    source: 'generic',
    defaultBid: '0.70',
    dailyBudget: '20',
    placements: { topOfSearch: 20, productPages: 0, restOfSearch: 0 },
  }),
  spBlock({
    key: 'SP-KW-EXACT-SINGLE',
    code: 'EXACT1',
    label: 'Exakt einzeln',
    description: 'Ein exaktes Keyword je Kampagne, für Begriffe mit genug Volumen.',
    adProduct: 'SP',
    targeting: 'keyword',
    matchType: 'exact',
    structure: '1:1:1',
    source: 'generic',
    defaultBid: '0.80',
    dailyBudget: '15',
    placements: { topOfSearch: 30, productPages: 0, restOfSearch: 0 },
  }),
  spBlock({
    key: 'SP-BRAND-DEF',
    code: 'BRAND',
    label: 'Marke verteidigen',
    description: 'Exakte Suchen nach der eigenen Marke, mit niedrigem Gebot; graduiert nie.',
    adProduct: 'SP',
    targeting: 'keyword',
    matchType: 'exact',
    structure: '1:1:n',
    source: 'brand',
    defaultBid: '0.40',
    dailyBudget: '10',
  }),
  spBlock({
    key: 'SP-CAT',
    code: 'CAT',
    label: 'Kategorie',
    description:
      'Ausspielung in Kategorien, auf Wunsch mit Einschränkungen (Preis, Sterne, Marke).',
    adProduct: 'SP',
    targeting: 'category',
    structure: '1:1:n',
    source: 'generic',
    defaultBid: '0.45',
    dailyBudget: '10',
  }),
  spBlock({
    key: 'SP-PAT',
    code: 'PAT',
    label: 'Produkte',
    description: 'Ausgewählte fremde Produkte als Ziel.',
    adProduct: 'SP',
    targeting: 'product',
    productMatch: 'exact',
    structure: '1:1:n',
    source: 'competitor',
    defaultBid: '0.50',
    dailyBudget: '10',
  }),
  spBlock({
    key: 'SP-PAT-EXPANDED-SELF',
    code: 'PAT-EXP',
    label: 'Ähnlich wie eigene',
    description:
      'Produkte, die den eigenen ähneln (erweitertes Produkt-Targeting mit der eigenen ASIN).',
    adProduct: 'SP',
    targeting: 'product',
    productMatch: 'expanded',
    structure: '1:1:n',
    source: 'own',
    defaultBid: '0.45',
    dailyBudget: '10',
  }),
  spBlock({
    key: 'SP-PAT-SINGLE-ASIN',
    code: 'PAT1',
    label: 'Produkt einzeln',
    description: 'Ein fremdes Produkt je Kampagne, für Ziele mit genug Volumen.',
    adProduct: 'SP',
    targeting: 'product',
    productMatch: 'exact',
    structure: '1:1:1',
    source: 'competitor',
    defaultBid: '0.60',
    dailyBudget: '10',
  }),
  spBlock({
    key: 'SP-PAT-CONQUEST',
    code: 'PAT-COMP',
    label: 'Wettbewerber',
    description: 'Produkte von der Wettbewerber-Liste des Clients (von Hand gepflegt).',
    adProduct: 'SP',
    targeting: 'product',
    productMatch: 'exact',
    structure: '1:1:n',
    source: 'competitor',
    defaultBid: '0.55',
    dailyBudget: '10',
  }),
  spBlock({
    key: 'SP-PAT-SHIELD',
    code: 'PAT-DEF',
    label: 'Eigene Produkte schützen',
    description: 'Eigene Produktseiten belegen, damit dort keine fremde Anzeige steht.',
    adProduct: 'SP',
    targeting: 'product',
    productMatch: 'exact',
    structure: '1:1:n',
    source: 'own',
    defaultBid: '0.35',
    dailyBudget: '5',
  }),
  otherBlock({
    key: 'SB-HEADER-KW',
    code: 'HEADER',
    label: 'Marken-Anzeige oben',
    description: 'Sponsored Brands mit Logo und Überschrift auf exakte Gewinner-Keywords.',
    adProduct: 'SB',
    targeting: 'keyword',
    matchType: 'exact',
    structure: '1:n:1',
    source: 'generic',
    defaultBid: '0.90',
    dailyBudget: '15',
  }),
  otherBlock({
    key: 'SB-VIDEO-KW',
    code: 'VIDEO',
    label: 'Video',
    description: 'Sponsored Brands Video auf exakte Gewinner-Keywords.',
    adProduct: 'SB',
    targeting: 'keyword',
    matchType: 'exact',
    structure: '1:1:n',
    source: 'generic',
    defaultBid: '0.80',
    dailyBudget: '15',
  }),
  otherBlock({
    key: 'SB-PAT',
    code: 'PAT',
    label: 'Marken-Anzeige auf Produktseiten',
    description: 'Sponsored Brands auf ausgewählten Produktseiten.',
    adProduct: 'SB',
    targeting: 'product',
    productMatch: 'exact',
    structure: '1:n:1',
    source: 'competitor',
    defaultBid: '0.70',
    dailyBudget: '10',
  }),
  otherBlock({
    key: 'SD-CAT',
    code: 'CAT',
    label: 'Display Kategorie',
    description: 'Sponsored Display in Kategorien (nur CPC).',
    adProduct: 'SD',
    targeting: 'category',
    structure: '1:1:n',
    source: 'generic',
    sdOptimization: 'clicks',
    defaultBid: '0.50',
    dailyBudget: '10',
  }),
  otherBlock({
    key: 'SD-PAT',
    code: 'PAT',
    label: 'Display Produkte',
    description: 'Sponsored Display auf ausgewählten Produkten (nur CPC).',
    adProduct: 'SD',
    targeting: 'product',
    productMatch: 'exact',
    structure: '1:1:n',
    source: 'competitor',
    sdOptimization: 'clicks',
    defaultBid: '0.50',
    dailyBudget: '10',
  }),
  otherBlock({
    key: 'SD-RT-VIEWS',
    code: 'RT-VIEW',
    label: 'Retargeting Ansichten',
    description: 'Wer die eigenen Produkte angesehen und nicht gekauft hat (nur CPC).',
    adProduct: 'SD',
    targeting: 'audience',
    structure: '1:1:n',
    source: 'own',
    sdOptimization: 'conversions',
    defaultBid: '0.55',
    dailyBudget: '10',
    lookbackDays: 30,
  }),
  otherBlock({
    key: 'SD-RT-PURCHASE',
    code: 'RT-BUY',
    label: 'Retargeting Käufe',
    description: 'Wer die eigenen Produkte gekauft hat, für Wiederkäufe (nur CPC).',
    adProduct: 'SD',
    targeting: 'audience',
    structure: '1:1:n',
    source: 'own',
    sdOptimization: 'conversions',
    defaultBid: '0.50',
    dailyBudget: '10',
    lookbackDays: 60,
  }),
];

const DEFAULT_EDGES: CatalogEdge[] = [
  { from: 'SP-AUTO', to: 'SP-KW-BROAD-CLUSTER' },
  { from: 'SP-AUTO', to: 'SP-KW-EXACT' },
  { from: 'SP-AUTO', to: 'SP-PAT' },
  { from: 'SP-KW-BROAD-CLUSTER', to: 'SP-KW-EXACT' },
  { from: 'SP-KW-PHRASE', to: 'SP-KW-EXACT' },
  { from: 'SP-KW-EXACT', to: 'SP-KW-EXACT-SINGLE' },
  { from: 'SP-KW-EXACT-SINGLE', to: 'SB-VIDEO-KW' },
  { from: 'SP-KW-EXACT-SINGLE', to: 'SB-HEADER-KW' },
  { from: 'SP-CAT', to: 'SP-PAT' },
  { from: 'SP-PAT', to: 'SP-PAT-SINGLE-ASIN' },
  { from: 'SD-CAT', to: 'SD-PAT' },
];

const blocks = (...keys: (string | PresetBlock)[]): PresetBlock[] =>
  keys.map((entry) => (typeof entry === 'string' ? { block: entry } : entry));

const DEFAULT_PRESETS: CatalogPreset[] = [
  {
    key: 'muuv-standard',
    name: 'Muuv-Standard',
    description:
      'Mischung für die meisten Produkte: Automatisch als Quelle, Breit-Cluster und Exakt, Einzel-Kampagnen für starke Begriffe, eigene Marke getrennt.',
    blocks: blocks(
      'SP-AUTO',
      'SP-KW-BROAD-CLUSTER',
      'SP-KW-EXACT',
      'SP-KW-EXACT-SINGLE',
      'SP-BRAND-DEF',
      'SP-CAT',
      'SP-PAT',
      'SP-PAT-SHIELD',
      'SD-RT-VIEWS',
    ),
    isDefault: true,
  },
  {
    key: 'control',
    name: 'Kontrolle',
    description:
      'Für umsatzstarke Hero-Produkte mit engem ACoS-Ziel: viele Einzel-Kampagnen, Breit nur für Haupt-Begriffe, Automatisch und Produkte als Zulieferer.',
    blocks: blocks(
      { block: 'SP-AUTO', dailyBudget: '10' },
      { block: 'SP-KW-BROAD-CLUSTER', dailyBudget: '10' },
      { block: 'SP-KW-EXACT-SINGLE', dailyBudget: '20' },
      'SP-BRAND-DEF',
      'SP-CAT',
      'SP-PAT',
      'SP-PAT-SINGLE-ASIN',
    ),
    isDefault: false,
  },
  {
    key: 'funnel-hub',
    name: 'Funnel-Hub',
    description:
      'Zum Skalieren eines breiten Sortiments: kräftige Auto-Kampagne als Quelle, Breit-Cluster, Produkt-Trichter, Display-Retargeting und Video.',
    blocks: blocks(
      { block: 'SP-AUTO', dailyBudget: '25' },
      'SP-KW-BROAD-CLUSTER',
      'SP-KW-EXACT',
      'SP-CAT',
      'SP-PAT',
      'SP-PAT-EXPANDED-SELF',
      'SB-VIDEO-KW',
      'SD-RT-VIEWS',
      'SD-RT-PURCHASE',
    ),
    isDefault: false,
  },
  {
    key: 'launch',
    name: 'Launch',
    description:
      'Für neue Produkte mit Ranking-Ziel: Automatisch und Breit zum Lernen, Exakt auf die Haupt-Begriffe mit Fokus auf den Platz oben in der Suche.',
    blocks: blocks(
      { block: 'SP-AUTO', dailyBudget: '20' },
      { block: 'SP-KW-BROAD-CLUSTER', dailyBudget: '20' },
      { block: 'SP-KW-EXACT', defaultBid: '0.90', dailyBudget: '25', topOfSearch: 60 },
      'SP-BRAND-DEF',
    ),
    isDefault: false,
  },
  {
    key: 'profit-defend',
    name: 'Profit und Verteidigung',
    description:
      'Für Bestandsprodukte mit knapper Marge: eigene Marke und Produktseiten schützen, Wiederkäufer ansprechen, keine Wachstums-Bausteine.',
    blocks: blocks(
      { block: 'SP-BRAND-DEF', defaultBid: '0.30' },
      'SP-PAT-SHIELD',
      'SP-KW-EXACT-SINGLE',
      'SD-RT-PURCHASE',
    ),
    isDefault: false,
  },
  {
    key: 'consumable',
    name: 'Verbrauchsgut',
    description:
      'Wie der Muuv-Standard, dazu Retargeting der Käufer mit einem Rückblick passend zum Wiederkauf.',
    blocks: blocks(
      'SP-AUTO',
      'SP-KW-BROAD-CLUSTER',
      'SP-KW-EXACT',
      'SP-KW-EXACT-SINGLE',
      'SP-BRAND-DEF',
      'SP-PAT-SHIELD',
      { block: 'SD-RT-PURCHASE', lookbackDays: 90 },
    ),
    isDefault: false,
  },
];

/** Startwerte; wer den Katalog ändert, speichert ein eigenes Dokument (`structureCatalogSchema`). */
export const DEFAULT_STRUCTURE_CATALOG: StructureCatalog = {
  blocks: DEFAULT_BLOCKS,
  edges: DEFAULT_EDGES,
  presets: DEFAULT_PRESETS,
  naming: { pattern: '{adType} | {block} | {group} | {target}' },
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export const structureCatalogResponseSchema = z
  .object({
    catalog: structureCatalogSchema,
    /** Zähler für das Speichern (409 bei gleichzeitiger Änderung); 0 = Startwerte, noch nichts gespeichert. */
    version: z.number().int(),
    updatedAt: z.string().nullable(),
    /** Preset je Client (ohne Eintrag gilt der Standard). */
    clientPresets: z.array(z.object({ clientId: z.uuid(), presetKey: z.string() })),
    /** Clients der Organisation, für die Zuordnung. */
    clients: z.array(z.object({ id: z.uuid(), name: z.string() })),
  })
  .meta({ id: 'StructureCatalogResponse' });
export type StructureCatalogResponse = z.infer<typeof structureCatalogResponseSchema>;

export const saveStructureCatalogRequestSchema = z
  .strictObject({ catalog: structureCatalogSchema, version: z.number().int().min(0) })
  .meta({ id: 'SaveStructureCatalogRequest' });

export const presetKeySchema = z.string().max(32).regex(PRESET_KEY);

export const setClientPresetRequestSchema = z
  .strictObject({ presetKey: presetKeySchema.nullable() })
  .meta({ id: 'SetClientPresetRequest' });

/** Wirksames Preset: Produktgruppe vor Client vor Standard; unbekannte Schlüssel (gelöschte Presets) zählen nicht. */
export function effectivePreset(
  catalog: StructureCatalog,
  keys: { productGroup?: string | null; client?: string | null },
): CatalogPreset {
  const find = (key: string | null | undefined) =>
    key ? catalog.presets.find((preset) => preset.key === key) : undefined;
  return (
    find(keys.productGroup) ??
    find(keys.client) ??
    catalog.presets.find((preset) => preset.isDefault) ??
    catalog.presets[0]!
  );
}
