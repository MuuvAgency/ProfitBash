import { plannedCampaignSchema } from '@profitbash/shared/campaign-setup';
import {
  DEFAULT_STRUCTURE_CATALOG,
  type CatalogPreset,
  type StructureCatalog,
} from '@profitbash/shared/structure-catalog';
import { describe, expect, it } from 'vitest';
import type { AdChangeLimitLookup } from './ad-changes';
import { buildCampaignPlan, type PlanInput, type PlannedCampaign } from './plan';

const catalog: StructureCatalog = DEFAULT_STRUCTURE_CATALOG;
const preset = (key: string): CatalogPreset => catalog.presets.find((p) => p.key === key)!;
const onlyBlocks = (...blocks: string[]): CatalogPreset => ({
  key: 'test',
  name: 'Test',
  description: '',
  blocks: blocks.map((block) => ({ block })),
  isDefault: false,
});

const noLimits: AdChangeLimitLookup = () => null;
const base = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  catalog,
  preset: preset('muuv-standard'),
  productGroup: {
    name: 'Flaschen',
    items: [
      { asin: 'B0FLASCHE1', sku: 'FL-750', isHero: true },
      { asin: 'B0FLASCHE2', sku: 'FL-500', isHero: false },
    ],
  },
  profile: {
    countryCode: 'DE',
    currencyCode: 'EUR',
    accountType: 'seller',
    clientName: 'Waldkauz',
  },
  eurRate: '1',
  keywords: [{ text: 'trinkflasche 1l', single: true }, { text: 'trinkflasche edelstahl' }],
  brandTerms: ['waldkauz'],
  productTargets: [{ asin: 'B0FREMD001' }],
  categories: [{ id: '12345', name: 'Trinkflaschen' }],
  conquestAsins: [],
  existing: { campaignNames: [], exactKeywords: [] },
  limitFor: noLimits,
  unlocks: {},
  ...overrides,
});
const byBlock = (campaigns: PlannedCampaign[], block: string) =>
  campaigns.filter((campaign) => campaign.block === block);
const one = (campaigns: PlannedCampaign[], block: string) => {
  const found = byBlock(campaigns, block);
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe('buildCampaignPlan: Struktur und Namen', () => {
  it('liefert Kampagnen in der Form, die ein Entwurf speichert', () => {
    for (const key of ['muuv-standard', 'funnel-hub', 'launch']) {
      for (const campaign of buildCampaignPlan(base({ preset: preset(key) })).campaigns) {
        expect(plannedCampaignSchema.parse(campaign)).toEqual(campaign);
      }
    }
  });

  it('legt je Baustein des Presets Kampagnen mit Namen nach dem Schema an', () => {
    const plan = buildCampaignPlan(base());
    expect(plan.campaigns.map((campaign) => campaign.name)).toEqual([
      'SP | AUTO | Flaschen',
      'SP | BROAD | Flaschen',
      'SP | EXACT | Flaschen',
      'SP | EXACT1 | Flaschen | trinkflasche 1l',
      'SP | BRAND | Flaschen',
      'SP | CAT | Flaschen',
      'SP | PAT | Flaschen',
      'SP | PAT-DEF | Flaschen',
      'SD | RT-VIEW | Flaschen | 30D',
    ]);
    // Neue Kampagnen sind aktiv (F6), CPC und ohne Off-Amazon (F-S7).
    for (const campaign of plan.campaigns) {
      expect(campaign).toMatchObject({ state: 'ENABLED', costType: 'cpc', offAmazon: false });
    }
  });

  it('verteilt Keywords: Breit und Exakt für alle, einzeln nur markierte; Marke getrennt', () => {
    const { campaigns } = buildCampaignPlan(base());
    expect(one(campaigns, 'SP-KW-BROAD-CLUSTER').targets).toEqual([
      { type: 'keyword', text: 'trinkflasche 1l', matchType: 'broad', bid: '0.55' },
      { type: 'keyword', text: 'trinkflasche edelstahl', matchType: 'broad', bid: '0.55' },
    ]);
    expect(
      one(campaigns, 'SP-KW-EXACT').targets.map((t) => t.type === 'keyword' && t.text),
    ).toEqual(['trinkflasche edelstahl']);
    expect(one(campaigns, 'SP-KW-EXACT-SINGLE').targets).toEqual([
      { type: 'keyword', text: 'trinkflasche 1l', matchType: 'exact', bid: '0.80' },
    ]);
    expect(one(campaigns, 'SP-BRAND-DEF').targets).toEqual([
      { type: 'keyword', text: 'waldkauz', matchType: 'exact', bid: '0.40' },
    ]);
  });

  it('legt ohne Exakt-Baustein jedes Keyword als eigene Kampagne an (Preset „Kontrolle“)', () => {
    const { campaigns } = buildCampaignPlan(base({ preset: preset('control') }));
    expect(byBlock(campaigns, 'SP-KW-EXACT-SINGLE').map((campaign) => campaign.name)).toEqual([
      'SP | EXACT1 | Flaschen | trinkflasche 1l',
      'SP | EXACT1 | Flaschen | trinkflasche edelstahl',
    ]);
  });

  it('isoliert: Exakt-Begriffe negativ in Auto, Breit und Exakt-Sammlung, Marke negativ in allen allgemeinen', () => {
    const { campaigns } = buildCampaignPlan(base());
    const negatives = (block: string) => one(campaigns, block).negatives;
    expect(negatives('SP-AUTO')).toEqual([
      { type: 'keyword', text: 'trinkflasche 1l', matchType: 'negativeExact' },
      { type: 'keyword', text: 'trinkflasche edelstahl', matchType: 'negativeExact' },
      { type: 'product', asin: 'B0FREMD001', matchType: 'negativeExact' },
      { type: 'keyword', text: 'waldkauz', matchType: 'negativePhrase' },
    ]);
    expect(negatives('SP-KW-EXACT')).toEqual([
      { type: 'keyword', text: 'trinkflasche 1l', matchType: 'negativeExact' },
      { type: 'keyword', text: 'waldkauz', matchType: 'negativePhrase' },
    ]);
    expect(negatives('SP-KW-EXACT-SINGLE')).toEqual([
      { type: 'keyword', text: 'waldkauz', matchType: 'negativePhrase' },
    ]);
    expect(negatives('SP-BRAND-DEF')).toEqual([]);
  });

  it('prüft Namen gegen die Höchstlänge des Kontos (Vendoren 116 Zeichen)', () => {
    const group = {
      name: 'g'.repeat(105),
      items: [{ asin: 'B0FLASCHE1', sku: null, isHero: true }],
    };
    const profile = {
      countryCode: 'DE',
      currencyCode: 'EUR',
      accountType: 'vendor',
      clientName: null,
    };
    const vendor = buildCampaignPlan(base({ profile, productGroup: group }));
    const seller = buildCampaignPlan(
      base({
        profile: { ...profile, accountType: 'seller' },
        productGroup: { ...group, items: [{ ...group.items[0]!, sku: 'FL' }] },
      }),
    );
    const tooLong = (plan: ReturnType<typeof buildCampaignPlan>) =>
      plan.hints.filter(
        (hint) =>
          hint.code === 'campaignNameInvalid' &&
          hint.issue === 'tooLong' &&
          hint.campaign === one(plan.campaigns, 'SP-AUTO').name,
      );

    expect(one(vendor.campaigns, 'SP-AUTO').name.length).toBe(117);
    expect(tooLong(vendor)).toHaveLength(1);
    expect(tooLong(seller)).toEqual([]);
  });

  it('bewirbt den Hero, bei Display und Marken-Anzeigen alle Produkte; Vendoren ohne SKU', () => {
    const { campaigns } = buildCampaignPlan(base());
    expect(one(campaigns, 'SP-AUTO').ads).toEqual([{ asin: 'B0FLASCHE1', sku: 'FL-750' }]);
    expect(one(campaigns, 'SD-RT-VIEWS').ads).toHaveLength(2);

    const vendor = buildCampaignPlan(
      base({
        profile: {
          countryCode: 'DE',
          currencyCode: 'EUR',
          accountType: 'vendor',
          clientName: null,
        },
        productGroup: {
          name: 'Flaschen',
          items: [{ asin: 'B0FLASCHE1', sku: null, isHero: false }],
        },
      }),
    );
    expect(one(vendor.campaigns, 'SP-AUTO').ads).toEqual([{ asin: 'B0FLASCHE1', sku: null }]);
    expect(vendor.hints).toContainEqual({ severity: 'info', code: 'noHero' });
  });

  it('nutzt Produkt-Targets, Kategorien, eigene ASINs und Zielgruppen', () => {
    const { campaigns } = buildCampaignPlan(base({ preset: preset('funnel-hub') }));
    expect(one(campaigns, 'SP-PAT').targets).toEqual([
      { type: 'product', asin: 'B0FREMD001', match: 'exact', bid: '0.50' },
    ]);
    expect(one(campaigns, 'SP-CAT').targets).toEqual([
      { type: 'category', categoryId: '12345', name: 'Trinkflaschen', bid: '0.45' },
    ]);
    expect(one(campaigns, 'SP-PAT-EXPANDED-SELF').targets).toEqual([
      { type: 'product', asin: 'B0FLASCHE1', match: 'expanded', bid: '0.45' },
    ]);
    expect(one(campaigns, 'SD-RT-PURCHASE').targets).toEqual([
      { type: 'audience', audience: 'purchases', lookbackDays: 60, bid: '0.50' },
    ]);
  });

  it('verteilt Produkt-Targets wie Keywords: markierte einzeln, Rest gesammelt; Wettbewerber zählen nicht mit', () => {
    const targets = [{ asin: 'B0FREMD001', single: true }, { asin: 'B0FREMD002' }];
    const both = buildCampaignPlan(
      base({ preset: onlyBlocks('SP-PAT', 'SP-PAT-SINGLE-ASIN'), productTargets: targets }),
    );
    expect(
      one(both.campaigns, 'SP-PAT').targets.map((t) => t.type === 'product' && t.asin),
    ).toEqual(['B0FREMD002']);
    expect(byBlock(both.campaigns, 'SP-PAT-SINGLE-ASIN').map((c) => c.name)).toEqual([
      'SP | PAT1 | Flaschen | B0FREMD001',
    ]);
    // Neben dem Wettbewerber-Baustein ohne Sammel-Baustein: alle Produkte einzeln.
    const conquest = buildCampaignPlan(
      base({
        preset: onlyBlocks('SP-PAT-CONQUEST', 'SP-PAT-SINGLE-ASIN'),
        productTargets: targets,
        conquestAsins: ['B0KONKUR01'],
      }),
    );
    expect(byBlock(conquest.campaigns, 'SP-PAT-SINGLE-ASIN')).toHaveLength(2);
  });

  it('lässt Bausteine ohne Eingaben weg und sagt warum', () => {
    const plan = buildCampaignPlan(
      base({ keywords: [], brandTerms: [], productTargets: [], categories: [] }),
    );
    expect(plan.campaigns.map((campaign) => campaign.block)).toEqual([
      'SP-AUTO',
      'SP-PAT-SHIELD',
      'SD-RT-VIEWS',
    ]);
    expect(plan.hints).toEqual(
      expect.arrayContaining([
        { severity: 'info', code: 'skippedNoKeywords', block: 'SP-KW-BROAD-CLUSTER' },
        { severity: 'info', code: 'skippedNoBrandTerms', block: 'SP-BRAND-DEF' },
        { severity: 'info', code: 'skippedNoCategories', block: 'SP-CAT' },
        { severity: 'info', code: 'skippedNoProductTargets', block: 'SP-PAT' },
      ]),
    );
  });
});

describe('buildCampaignPlan: Gebote und Budgets', () => {
  it('rechnet EUR-Werte in die Währung des Profils um (zwei Nachkommastellen)', () => {
    const { campaigns } = buildCampaignPlan(
      base({
        profile: {
          countryCode: 'SE',
          currencyCode: 'SEK',
          accountType: 'seller',
          clientName: null,
        },
        eurRate: '11.237',
      }),
    );
    const auto = one(campaigns, 'SP-AUTO');
    expect(auto.dailyBudget).toBe('168.56');
    expect(auto.adGroup.defaultBid).toBe('5.06');
    expect(auto.currencyCode).toBe('SEK');
  });

  it('nimmt Abweichungen des Presets und Gebote aus der Eingabe (Währung des Profils) vor dem Baustein', () => {
    const { campaigns } = buildCampaignPlan(
      base({
        preset: preset('launch'),
        keywords: [{ text: 'trinkflasche edelstahl', bid: '1.23' }, { text: 'flasche' }],
      }),
    );
    const exact = one(campaigns, 'SP-KW-EXACT');
    expect(exact.dailyBudget).toBe('25.00');
    expect(exact.placements).toEqual({ topOfSearch: 60, productPages: 0, restOfSearch: 0 });
    expect(exact.targets).toEqual([
      { type: 'keyword', text: 'trinkflasche edelstahl', matchType: 'exact', bid: '1.23' },
      { type: 'keyword', text: 'flasche', matchType: 'exact', bid: '0.90' },
    ]);
  });

  it('nimmt Gebote aus den Daten des Profils vor Preset und Baustein, aber nach der Eingabe (F13)', () => {
    const plan = buildCampaignPlan(
      base({
        preset: preset('funnel-hub'),
        keywords: [{ text: 'trinkflasche edelstahl', bid: '1.23' }, { text: 'flasche' }],
        profileBids: { keyword: { exact: '0.71', broad: '0.44' }, product: '0.52' },
      }),
    );
    const exact = one(plan.campaigns, 'SP-KW-EXACT');
    expect(exact.adGroup.defaultBid).toBe('0.71');
    expect(exact.targets.map((target) => target.bid)).toEqual(['1.23', '0.71']);
    expect(one(plan.campaigns, 'SP-KW-BROAD-CLUSTER').adGroup.defaultBid).toBe('0.44');
    expect(one(plan.campaigns, 'SP-PAT').targets[0]!.bid).toBe('0.52');
    // Ohne Wert im Profil: Katalog (Kategorie), und nie für SB/SD (die Daten stammen aus SP).
    const without = buildCampaignPlan(base({ preset: preset('funnel-hub') }));
    expect(one(plan.campaigns, 'SP-CAT').targets[0]!.bid).toBe(
      one(without.campaigns, 'SP-CAT').targets[0]!.bid,
    );
    expect(plan.hints).toContainEqual({
      severity: 'info',
      code: 'bidFromProfile',
      block: 'SP-KW-EXACT',
    });
    expect(plan.hints).not.toContainEqual({
      severity: 'info',
      code: 'bidFromProfile',
      block: 'SP-CAT',
    });
  });

  it('meldet Gebote und Budgets außerhalb der Grenzen von Amazon als Fehler', () => {
    const limits: AdChangeLimitLookup = ({ field }) =>
      field === 'budget' ? { min: '20', max: '1000000' } : { min: '0.10', max: '0.60' };
    const plan = buildCampaignPlan(base({ limitFor: limits }));
    expect(plan.hints).toContainEqual({
      severity: 'error',
      code: 'budgetOutOfRange',
      campaign: 'SP | AUTO | Flaschen',
      value: '15.00',
      min: '20',
      max: '1000000',
    });
    expect(plan.hints).toContainEqual({
      severity: 'error',
      code: 'bidOutOfRange',
      campaign: 'SP | EXACT1 | Flaschen | trinkflasche 1l',
      value: '0.80',
      min: '0.10',
      max: '0.60',
    });
  });
});

describe('buildCampaignPlan: Dubletten und Leitplanken', () => {
  it('erkennt vergebene Kampagnennamen (ohne Groß/Klein) und zählt den Namen hoch', () => {
    const plan = buildCampaignPlan(
      base({ existing: { campaignNames: ['sp | auto | flaschen'], exactKeywords: [] } }),
    );
    expect(one(plan.campaigns, 'SP-AUTO').name).toBe('SP | AUTO | Flaschen 2');
    expect(plan.hints).toContainEqual({
      severity: 'warning',
      code: 'campaignNameExists',
      campaign: 'SP | AUTO | Flaschen 2',
      existing: 'SP | AUTO | Flaschen',
    });
  });

  it('erkennt Keywords, die im Profil schon exakt gebucht sind', () => {
    const plan = buildCampaignPlan(
      base({
        existing: {
          campaignNames: [],
          exactKeywords: [{ text: 'Trinkflasche 1l', campaignName: 'Alt | Exakt' }],
        },
      }),
    );
    expect(plan.hints).toContainEqual({
      severity: 'warning',
      code: 'keywordAlreadyExact',
      keyword: 'trinkflasche 1l',
      existing: 'Alt | Exakt',
    });
  });

  it('meldet Keywords über den Grenzen von Amazon (Länge, Wörter)', () => {
    const plan = buildCampaignPlan(base({ keywords: [{ text: 'a b c d e f g h i j k' }] }));
    expect(plan.hints).toContainEqual({
      severity: 'error',
      code: 'keywordTooLong',
      keyword: 'a b c d e f g h i j k',
    });
  });

  it('sperrt vCPM und Off-Amazon; je Kampagne bewusst freischaltbar, mit Warnung', () => {
    const plan = buildCampaignPlan(
      base({
        unlocks: {
          'SD-RT-VIEWS': { vcpm: true },
          'SP-AUTO': { offAmazon: true },
          'SP-PAT': { vcpm: true },
        },
      }),
    );
    expect(one(plan.campaigns, 'SD-RT-VIEWS').costType).toBe('vcpm');
    expect(one(plan.campaigns, 'SP-AUTO').offAmazon).toBe(true);
    expect(one(plan.campaigns, 'SP-PAT').costType).toBe('cpc');
    expect(plan.hints).toEqual(
      expect.arrayContaining([
        { severity: 'warning', code: 'vcpmUnlocked', campaign: 'SD | RT-VIEW | Flaschen | 30D' },
        { severity: 'warning', code: 'offAmazonUnlocked', campaign: 'SP | AUTO | Flaschen' },
        { severity: 'error', code: 'vcpmNotAvailable', campaign: 'SP | PAT | Flaschen' },
      ]),
    );
  });

  it('nimmt Wettbewerber nur von der Liste des Clients (F-S9)', () => {
    const conquest = onlyBlocks('SP-PAT-CONQUEST');
    expect(buildCampaignPlan(base({ preset: conquest })).hints).toContainEqual({
      severity: 'info',
      code: 'skippedNoConquestList',
      block: 'SP-PAT-CONQUEST',
    });
    const plan = buildCampaignPlan(base({ preset: conquest, conquestAsins: ['B0KONKUR01'] }));
    expect(one(plan.campaigns, 'SP-PAT-CONQUEST').targets).toEqual([
      { type: 'product', asin: 'B0KONKUR01', match: 'exact', bid: '0.55' },
    ]);
  });

  it('meldet fehlende SKU bei Sellern und Marken-Anzeigen, die Werbemittel brauchen', () => {
    const plan = buildCampaignPlan(
      base({
        preset: onlyBlocks('SP-AUTO', 'SB-VIDEO-KW'),
        productGroup: {
          name: 'Flaschen',
          items: [{ asin: 'B0FLASCHE1', sku: null, isHero: true }],
        },
      }),
    );
    expect(plan.hints).toEqual(
      expect.arrayContaining([
        { severity: 'error', code: 'missingSku', asin: 'B0FLASCHE1' },
        { severity: 'info', code: 'needsCreative', campaign: 'SB | VIDEO | Flaschen' },
      ]),
    );
  });

  it('macht Namen auch innerhalb des Plans eindeutig', () => {
    const plan = buildCampaignPlan(
      base({
        catalog: { ...catalog, naming: { pattern: '{adType} {group}' } },
        preset: onlyBlocks('SP-AUTO', 'SP-CAT'),
      }),
    );
    expect(plan.campaigns.map((campaign) => campaign.name)).toEqual([
      'SP Flaschen',
      'SP Flaschen 2',
    ]);
  });
});

describe('buildCampaignPlan: Review-Befunde', () => {
  it('nimmt Keywords mit Marken-Begriff aus den allgemeinen Listen (Marke ist getrennt)', () => {
    const plan = buildCampaignPlan(
      base({
        brandTerms: ['Waldkauz'],
        keywords: [{ text: 'waldkauz' }, { text: 'Waldkauz flasche' }, { text: 'trinkflasche' }],
      }),
    );
    expect(
      one(plan.campaigns, 'SP-KW-BROAD-CLUSTER').targets.map((t) => t.type === 'keyword' && t.text),
    ).toEqual(['trinkflasche']);
    expect(
      one(plan.campaigns, 'SP-BRAND-DEF').targets.map((t) => t.type === 'keyword' && t.text),
    ).toEqual(['Waldkauz']);
    expect(plan.hints).toEqual(
      expect.arrayContaining([
        { severity: 'info', code: 'keywordIsBrand', keyword: 'waldkauz' },
        { severity: 'info', code: 'keywordIsBrand', keyword: 'Waldkauz flasche' },
      ]),
    );
  });

  it('führt doppelte Eingaben zusammen (einzeln, wenn eine davon einzeln ist; erstes Gebot)', () => {
    const plan = buildCampaignPlan(
      base({
        keywords: [
          { text: '  Trinkflasche ' },
          { text: 'trinkflasche', single: true, bid: '0.99' },
        ],
        productTargets: [{ asin: 'b0fremd001' }, { asin: 'B0FREMD001', single: true }],
        preset: onlyBlocks('SP-KW-EXACT', 'SP-KW-EXACT-SINGLE', 'SP-PAT', 'SP-PAT-SINGLE-ASIN'),
      }),
    );
    expect(one(plan.campaigns, 'SP-KW-EXACT-SINGLE').targets).toEqual([
      { type: 'keyword', text: 'Trinkflasche', matchType: 'exact', bid: '0.99' },
    ]);
    expect(one(plan.campaigns, 'SP-PAT-SINGLE-ASIN').name).toBe(
      'SP | PAT1 | Flaschen | B0FREMD001',
    );
  });

  it('isoliert Produkt-Targets: geplante fremde ASINs negativ in Auto und Kategorie, einzelne auch in der Sammlung', () => {
    const plan = buildCampaignPlan(
      base({
        preset: onlyBlocks('SP-AUTO', 'SP-CAT', 'SP-PAT', 'SP-PAT-SINGLE-ASIN'),
        productTargets: [{ asin: 'B0FREMD001', single: true }, { asin: 'B0FREMD002' }],
      }),
    );
    const products = (block: string) =>
      one(plan.campaigns, block).negatives.filter((negative) => negative.type === 'product');
    expect(products('SP-AUTO')).toEqual([
      { type: 'product', asin: 'B0FREMD001', matchType: 'negativeExact' },
      { type: 'product', asin: 'B0FREMD002', matchType: 'negativeExact' },
    ]);
    expect(products('SP-CAT')).toHaveLength(2);
    expect(products('SP-PAT')).toEqual([
      { type: 'product', asin: 'B0FREMD001', matchType: 'negativeExact' },
    ]);
  });

  it('trägt die Targeting-Art in jede Kampagne (für die Bulk-Datei, unabhängig vom späteren Katalog)', () => {
    const { campaigns } = buildCampaignPlan(base());
    expect(one(campaigns, 'SP-AUTO').targeting).toBe('auto');
    expect(one(campaigns, 'SP-KW-EXACT').targeting).toBe('keyword');
    expect(one(campaigns, 'SD-RT-VIEWS').targeting).toBe('audience');
  });

  it('verlangt keine SKU für Sponsored Brands und meldet eine leere Gruppe als Fehler', () => {
    const sb = buildCampaignPlan(
      base({
        preset: onlyBlocks('SB-VIDEO-KW'),
        productGroup: {
          name: 'Flaschen',
          items: [{ asin: 'B0FLASCHE1', sku: null, isHero: true }],
        },
      }),
    );
    expect(sb.hints.some((hint) => hint.code === 'missingSku')).toBe(false);
    const empty = buildCampaignPlan(base({ productGroup: { name: 'Flaschen', items: [] } }));
    expect(empty.hints).toContainEqual({ severity: 'error', code: 'noProducts' });
  });

  it('prüft Marken-Begriffe gegen die Grenze negativer Phrasen (4 Wörter)', () => {
    const plan = buildCampaignPlan(base({ brandTerms: ['eins zwei drei vier fünf'] }));
    expect(plan.hints).toContainEqual({
      severity: 'error',
      code: 'brandTermTooLong',
      keyword: 'eins zwei drei vier fünf',
    });
  });

  it('meldet eigene ASINs unter den fremden Produkten und plant sie dort nicht', () => {
    const plan = buildCampaignPlan(
      base({ productTargets: [{ asin: 'b0flasche1' }, { asin: 'B0FREMD001' }] }),
    );
    expect(
      one(plan.campaigns, 'SP-PAT').targets.map((t) => t.type === 'product' && t.asin),
    ).toEqual(['B0FREMD001']);
    expect(plan.hints).toContainEqual({
      severity: 'warning',
      code: 'ownAsinAsTarget',
      asin: 'B0FLASCHE1',
    });
  });

  it('setzt bei Sponsored Brands das Format des Bausteins: Kollektion mit allen Produkten, Video mit dem Hero (4.10)', () => {
    const plan = buildCampaignPlan(base({ preset: onlyBlocks('SB-HEADER-KW', 'SB-VIDEO-KW') }));
    const header = one(plan.campaigns, 'SB-HEADER-KW');
    const video = one(plan.campaigns, 'SB-VIDEO-KW');
    expect(header.sbAdFormat).toBe('collection');
    expect(header.ads.length).toBeGreaterThan(1);
    expect(video.sbAdFormat).toBe('video');
    expect(video.ads).toHaveLength(1);
    expect(one(buildCampaignPlan(base()).campaigns, 'SP-AUTO').sbAdFormat).toBeUndefined();
  });

  it('gibt allgemeinen SB-Keyword-Kampagnen die Marken-Negatives', () => {
    const plan = buildCampaignPlan(base({ preset: onlyBlocks('SP-BRAND-DEF', 'SB-HEADER-KW') }));
    expect(one(plan.campaigns, 'SB-HEADER-KW').negatives).toEqual([
      { type: 'keyword', text: 'waldkauz', matchType: 'negativePhrase' },
    ]);
  });

  it('warnt bei freigeschaltetem vCPM, dass das Gebot dann je 1000 sichtbare Impressionen gilt', () => {
    const plan = buildCampaignPlan(base({ unlocks: { 'SD-RT-VIEWS': { vcpm: true } } }));
    expect(plan.hints).toContainEqual({
      severity: 'warning',
      code: 'vcpmBidPerThousand',
      campaign: 'SD | RT-VIEW | Flaschen | 30D',
    });
  });

  it('rechnet Gebote aus der Eingabe nicht um, nur Katalogwerte; Rückblick aus dem Preset; Phrase isoliert', () => {
    const plan = buildCampaignPlan(
      base({
        preset: {
          ...preset('consumable'),
          blocks: [...preset('consumable').blocks, { block: 'SP-KW-PHRASE' }],
        },
        profile: {
          countryCode: 'PL',
          currencyCode: 'PLN',
          accountType: 'seller',
          clientName: null,
        },
        eurRate: '4.3',
        keywords: [{ text: 'trinkflasche', bid: '2.15' }],
      }),
    );
    expect(one(plan.campaigns, 'SP-KW-EXACT').targets[0]).toMatchObject({ bid: '2.15' });
    expect(one(plan.campaigns, 'SP-KW-BROAD-CLUSTER').targets[0]).toMatchObject({ bid: '2.15' });
    expect(one(plan.campaigns, 'SP-AUTO').adGroup.defaultBid).toBe('1.94');
    expect(one(plan.campaigns, 'SD-RT-PURCHASE').targets[0]).toMatchObject({ lookbackDays: 90 });
    expect(one(plan.campaigns, 'SP-KW-PHRASE').negatives).toContainEqual({
      type: 'keyword',
      text: 'trinkflasche',
      matchType: 'negativeExact',
    });
  });
});
