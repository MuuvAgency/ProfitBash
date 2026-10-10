import type {
  CatalogAdProduct,
  CatalogBlock,
  CatalogPreset,
  PresetBlock,
  StructureCatalog,
} from '@profitbash/shared/structure-catalog';
import type {
  PlannedCampaign,
  PlannedNegative,
  PlannedTarget,
} from '@profitbash/shared/campaign-setup';
import {
  NEGATIVE_KEYWORD_MAX_LENGTH,
  NEGATIVE_KEYWORD_MAX_WORDS,
  type AdChangeLimitLookup,
} from './ad-changes';
import { Dec, parseDecimal } from './decimal';
import {
  campaignNameIssues,
  campaignNameMaxLength,
  renderCampaignName,
  uniqueCampaignName,
} from './naming';

/**
 * Plan-Engine des Kampagnen-Setups (`docs/tasks/phase-4.md` 4.3), ohne I/O: Preset + Produktgruppe + Eingaben →
 * Kampagnen mit Ad Group, Anzeigen, Targets, Negatives, Namen, Geboten und Budgets, dazu Hinweise.
 *
 * Regeln:
 * - **Bausteine in der Reihenfolge des Presets.** Ein Baustein ohne passende Eingaben fällt mit Hinweis weg.
 * - **Keywords:** alle allgemeinen Keywords in Breit und Phrase; exakt in die Exakt-Sammlung, als markierte (`single`)
 *   in eine eigene Kampagne. Fehlt dem Preset einer der beiden Exakt-Bausteine, nimmt der andere alle.
 * - **Trennung (Isolation):** Exakt geplante Begriffe sind negativ exakt in Auto, Breit und Phrase, Einzel-Begriffe auch
 *   in der Exakt-Sammlung. Enthält das Preset einen Marken-Baustein, sind die Marken-Begriffe negativ Phrase in allen
 *   allgemeinen Keyword- und Auto-Kampagnen (Marke und Nicht-Marke getrennt, Ideen-Dokument C.2a).
 * - **Anzeigen:** der Hero (sonst das erste Produkt); bei mehreren Anzeigen je Kampagne (`1:n:1`) und bei Sponsored
 *   Display alle Produkte der Gruppe.
 * - **Gebote und Budgets:** Eingabe (Währung des Profils) vor Abweichung des Presets vor Baustein; Werte aus dem Katalog
 *   sind EUR und werden mit `eurRate` umgerechnet, auf zwei Nachkommastellen (kaufmännisch nach ADR 003: half-even).
 * - **Leitplanken (F-S7, F-S9):** immer CPC und ohne Off-Amazon, außer bewusst je Baustein freigeschaltet (`unlocks`);
 *   Wettbewerber nur von der Liste des Clients.
 * - **Hinweise:** `error` sperrt das Übermitteln (Grenzen von Amazon, fehlende SKU), `warning` verlangt einen Blick
 *   (schon vorhanden, freigeschaltet), `info` erklärt (weggelassen, Werbemittel nötig).
 */

/** Grenzen eines Keywords wie bei negativen Keywords in Phase 3 (exakt 10 Wörter, Phrase 4, 80 Zeichen). */
const tooLong = (text: string, maxWords: number) =>
  text.split(' ').length > maxWords || [...text].length > NEGATIVE_KEYWORD_MAX_LENGTH;

const AD_PRODUCT: Record<CatalogAdProduct, string> = {
  SP: 'SPONSORED_PRODUCTS',
  SB: 'SPONSORED_BRANDS',
  SD: 'SPONSORED_DISPLAY',
};

export interface PlanInput {
  catalog: StructureCatalog;
  /** Wirksames Preset (`effectivePreset`). */
  preset: CatalogPreset;
  productGroup: {
    name: string;
    items: readonly { asin: string; sku: string | null; isHero: boolean }[];
  };
  profile: {
    countryCode: string;
    currencyCode: string;
    accountType: string;
    clientName: string | null;
  };
  /** 1 EUR in der Währung des Profils (Decimal-String; `1` für EUR). */
  eurRate: string;
  /** Allgemeine Keywords; `bid` in der Währung des Profils (z. B. CPC von der Harvest-Merkliste, F8). */
  keywords: readonly { text: string; single?: boolean; bid?: string }[];
  /** Begriffe der eigenen Marke (Marken-Baustein, Trennung). */
  brandTerms: readonly string[];
  /** Fremde Produkte als Ziel; `single` → eigene Kampagne. */
  productTargets: readonly { asin: string; single?: boolean; bid?: string }[];
  categories: readonly { id: string; name: string; bid?: string }[];
  /** Wettbewerber-Liste des Clients, von Hand gepflegt (F-S9). */
  conquestAsins: readonly string[];
  /** Was es im Profil schon gibt (Dubletten). */
  existing: {
    campaignNames: readonly string[];
    exactKeywords: readonly { text: string; campaignName: string }[];
  };
  limitFor: AdChangeLimitLookup;
  /** Bewusst freigeschaltet je Baustein (F-S7). */
  unlocks: Readonly<Record<string, { vcpm?: boolean; offAmazon?: boolean }>>;
  /**
   * Gebote aus den eigenen Daten des Profils (F13, Währung des Profils, z. B. mittlerer CPC der letzten 60 Tage):
   * ersetzen für Sponsored Products Preset und Baustein; ein Gebot aus der Eingabe geht vor.
   */
  profileBids?: ProfileBids;
}

export interface ProfileBids {
  keyword?: Partial<Record<'broad' | 'phrase' | 'exact', string>>;
  product?: string;
  category?: string;
}

/** Formen des Plans aus `@profitbash/shared/campaign-setup` (ein Entwurf speichert sie so). */
export type { PlannedCampaign, PlannedNegative, PlannedTarget };

export type PlanHint =
  | { severity: 'info'; code: 'noHero' }
  | { severity: 'info'; code: 'bidFromProfile'; block: string }
  | { severity: 'info'; code: 'keywordIsBrand'; keyword: string }
  | { severity: 'warning'; code: 'ownAsinAsTarget'; asin: string }
  | { severity: 'warning'; code: 'vcpmBidPerThousand'; campaign: string }
  | { severity: 'error'; code: 'noProducts' }
  | { severity: 'error'; code: 'brandTermTooLong'; keyword: string }
  | {
      severity: 'info';
      code:
        | 'skippedNoKeywords'
        | 'skippedNoBrandTerms'
        | 'skippedNoCategories'
        | 'skippedNoProductTargets'
        | 'skippedNoConquestList'
        | 'skippedUnknownBlock'
        | 'skippedNoProducts';
      block: string;
    }
  | { severity: 'info'; code: 'needsCreative'; campaign: string }
  | { severity: 'warning'; code: 'campaignNameExists'; campaign: string; existing: string }
  | { severity: 'warning'; code: 'keywordAlreadyExact'; keyword: string; existing: string }
  | { severity: 'warning'; code: 'vcpmUnlocked' | 'offAmazonUnlocked'; campaign: string }
  | { severity: 'error'; code: 'vcpmNotAvailable' | 'offAmazonNotAvailable'; campaign: string }
  | {
      severity: 'error';
      code: 'bidOutOfRange' | 'budgetOutOfRange';
      campaign: string;
      value: string;
      min: string;
      max: string;
    }
  | { severity: 'error'; code: 'campaignNameInvalid'; campaign: string; issue: string }
  | { severity: 'error'; code: 'keywordTooLong'; keyword: string }
  | { severity: 'error'; code: 'missingSku'; asin: string };

export interface CampaignPlan {
  campaigns: PlannedCampaign[];
  hints: PlanHint[];
}

/** Der Wettbewerber-Baustein (Conquesting) nimmt nur die Liste des Clients (F-S9). */
const isConquest = (block: CatalogBlock) => block.key === 'SP-PAT-CONQUEST';

const clean = (text: string) => text.normalize('NFC').split(/\s+/u).filter(Boolean).join(' ');
const money = (value: Dec) => value.toFixed(2);

/**
 * Doppelte (ohne Groß/Klein) zusammenführen, leere fallen weg: erste Schreibweise, `single`, wenn einer der Einträge es
 * ist, das erste angegebene Gebot.
 */
function merged<T extends { single?: boolean; bid?: string }>(
  entries: readonly T[],
  key: (entry: T) => string,
): T[] {
  const byKey = new Map<string, T>();
  for (const entry of entries) {
    const id = key(entry).toLowerCase();
    if (id === '') continue;
    const known = byKey.get(id);
    if (!known) byKey.set(id, { ...entry });
    else {
      if (entry.single) known.single = true;
      if (known.bid === undefined && entry.bid !== undefined) known.bid = entry.bid;
    }
  }
  return [...byKey.values()];
}

/** Doppelte (ohne Groß/Klein) und leere Einträge fallen weg, die erste Schreibweise bleibt. */
function unique<T>(entries: readonly T[], key: (entry: T) => string): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const id = key(entry).toLowerCase();
    if (id === '' || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

interface Slot {
  /** Wert für `{target}` im Namen (nur bei einer Kampagne je Ziel). */
  target: string | null;
  targets: PlannedTarget[];
}

export function buildCampaignPlan(input: PlanInput): CampaignPlan {
  const hints: PlanHint[] = [];
  const hint = (entry: PlanHint) => {
    const id = JSON.stringify(entry);
    if (!hints.some((existing) => JSON.stringify(existing) === id)) hints.push(entry);
  };
  const rate = parseDecimal(input.eurRate);
  const fromEur = (value: string) => money(parseDecimal(value).mul(rate));
  const fromProfile = (value: string) => money(parseDecimal(value));

  const blocks = new Map(input.catalog.blocks.map((block) => [block.key, block]));
  const presetBlocks = input.preset.blocks.filter((entry) => {
    if (blocks.has(entry.block)) return true;
    hint({ severity: 'info', code: 'skippedUnknownBlock', block: entry.block });
    return false;
  });
  const inPreset = (test: (block: CatalogBlock) => boolean) =>
    presetBlocks.some((entry) => test(blocks.get(entry.block)!));

  // --- Eingaben bereinigen ---------------------------------------------------------------------------------------
  const hasBrand = inPreset((block) => block.source === 'brand');
  const brandTerms = unique(input.brandTerms.map(clean), (term) => term);
  /** Enthält das Keyword einen Marken-Begriff als Wortfolge (wie ein negatives Phrase-Keyword)? */
  const isBrand = (text: string) => {
    const padded = ` ${text.toLowerCase()} `;
    return brandTerms.some((term) => padded.includes(` ${term.toLowerCase()} `));
  };
  const keywords = merged(
    input.keywords.map((keyword) => ({ ...keyword, text: clean(keyword.text) })),
    (keyword) => keyword.text,
  ).filter((keyword) => {
    // Mit Marken-Baustein sind Marken-Suchen getrennt: In allgemeinen Kampagnen wären sie negativ und liefen nie.
    if (!hasBrand || !isBrand(keyword.text)) return true;
    hint({ severity: 'info', code: 'keywordIsBrand', keyword: keyword.text });
    return false;
  });
  const items = input.productGroup.items.map((item) => ({
    ...item,
    asin: item.asin.trim().toUpperCase(),
  }));
  const ownAsins = unique(
    items.map((item) => item.asin),
    (asin) => asin,
  );
  const productTargets = merged(
    input.productTargets.map((target) => ({ ...target, asin: target.asin.trim().toUpperCase() })),
    (target) => target.asin,
  ).filter((target) => {
    if (!ownAsins.includes(target.asin)) return true;
    hint({ severity: 'warning', code: 'ownAsinAsTarget', asin: target.asin });
    return false;
  });
  const conquest = unique(
    input.conquestAsins.map((asin) => asin.trim().toUpperCase()),
    (asin) => asin,
  );
  const categories = unique(input.categories, (category) => category.id);
  for (const { text } of keywords) {
    if (tooLong(text, NEGATIVE_KEYWORD_MAX_WORDS.EXACT)) {
      hint({ severity: 'error', code: 'keywordTooLong', keyword: text });
    }
  }
  // Marken-Begriffe stehen als negative Phrase in den allgemeinen Kampagnen: deren Grenze gilt.
  for (const term of brandTerms) {
    if (
      tooLong(term, hasBrand ? NEGATIVE_KEYWORD_MAX_WORDS.PHRASE : NEGATIVE_KEYWORD_MAX_WORDS.EXACT)
    ) {
      hint({ severity: 'error', code: 'brandTermTooLong', keyword: term });
    }
  }

  const hero = items.find((item) => item.isHero) ?? items[0];
  if (items.length === 0) hint({ severity: 'error', code: 'noProducts' });
  else if (!items.some((item) => item.isHero)) hint({ severity: 'info', code: 'noHero' });

  // Exakt-Verteilung: markierte einzeln, Rest gesammelt; fehlt ein Baustein, nimmt der andere alle.
  const isExact = (single: boolean) => (block: CatalogBlock) =>
    block.adProduct === 'SP' &&
    block.source === 'generic' &&
    block.targeting === 'keyword' &&
    block.matchType === 'exact' &&
    (block.structure === '1:1:1') === single;
  const hasExactMulti = inPreset(isExact(false));
  const hasExactSingle = inPreset(isExact(true));
  const exactSingle = keywords.filter((keyword) =>
    hasExactSingle ? keyword.single === true || !hasExactMulti : false,
  );
  const exactMulti = keywords.filter((keyword) => hasExactMulti && !exactSingle.includes(keyword));
  // Produkt-Targets wie Keywords; der Wettbewerber-Baustein hat seine eigene Liste und zählt nicht mit.
  const isProductBlock = (single: boolean) => (block: CatalogBlock) =>
    block.adProduct === 'SP' &&
    block.targeting === 'product' &&
    block.source === 'competitor' &&
    !isConquest(block) &&
    (block.structure === '1:1:1') === single;
  const hasPatMulti = inPreset(isProductBlock(false));
  const hasPatSingle = inPreset(isProductBlock(true));
  const singleProducts = productTargets.filter((target) =>
    hasPatSingle ? target.single === true || !hasPatMulti : false,
  );
  const multiProducts = productTargets.filter((target) => !singleProducts.includes(target));

  /** Gebot aus dem Profil (nur SP; die Daten stammen aus SP-Targets), sonst `undefined`. */
  const profileBid = (block: CatalogBlock): string | undefined => {
    if (block.adProduct !== 'SP' || !input.profileBids) return undefined;
    switch (block.targeting) {
      case 'keyword':
        return block.matchType ? input.profileBids.keyword?.[block.matchType] : undefined;
      case 'product':
        return input.profileBids.product;
      case 'category':
        return input.profileBids.category;
      default:
        return undefined;
    }
  };
  /** Standardgebot eines Bausteins: Profil vor Preset vor Baustein. */
  const defaultBid = (block: CatalogBlock, entry: PresetBlock) => {
    const fromData = profileBid(block);
    if (fromData !== undefined) {
      hint({ severity: 'info', code: 'bidFromProfile', block: block.key });
      return fromProfile(fromData);
    }
    return fromEur(entry.defaultBid ?? block.defaultBid);
  };

  // --- Ziele je Baustein -----------------------------------------------------------------------------------------
  function slotsFor(block: CatalogBlock, entry: PresetBlock): Slot[] | null {
    const bid = (own?: string) => (own !== undefined ? fromProfile(own) : defaultBid(block, entry));
    const perTarget = block.structure === '1:1:1';
    const pack = (targets: PlannedTarget[], label: (target: PlannedTarget) => string): Slot[] =>
      perTarget
        ? targets.map((target) => ({ target: label(target), targets: [target] }))
        : [{ target: null, targets }];
    const keywordTargets = (list: readonly { text: string; bid?: string }[]) =>
      list.map((keyword): PlannedTarget => ({
        type: 'keyword',
        text: keyword.text,
        matchType: block.matchType!,
        bid: bid(keyword.bid),
      }));
    const productList = (
      list: readonly { asin: string; bid?: string }[],
      match: 'exact' | 'expanded',
    ) =>
      list.map((target): PlannedTarget => ({
        type: 'product',
        asin: target.asin,
        match,
        bid: bid(target.bid),
      }));
    const skip = (code: Extract<PlanHint, { block: string }>['code']) => {
      hint({ severity: 'info', code, block: block.key });
      return null;
    };
    const label = (target: PlannedTarget) =>
      target.type === 'keyword' ? target.text : target.type === 'product' ? target.asin : '';

    switch (block.targeting) {
      case 'auto':
        return [{ target: null, targets: [] }];
      case 'keyword': {
        if (block.source === 'brand') {
          return brandTerms.length > 0
            ? pack(keywordTargets(brandTerms.map((text) => ({ text }))), label)
            : skip('skippedNoBrandTerms');
        }
        let list = keywords;
        if (block.adProduct === 'SP' && block.matchType === 'exact') {
          list = block.structure === '1:1:1' ? exactSingle : exactMulti;
        }
        return list.length > 0 ? pack(keywordTargets(list), label) : skip('skippedNoKeywords');
      }
      case 'category':
        return categories.length > 0
          ? [
              {
                target: null,
                targets: categories.map((category) => ({
                  type: 'category',
                  categoryId: category.id,
                  name: category.name,
                  bid: bid(category.bid),
                })),
              },
            ]
          : skip('skippedNoCategories');
      case 'product': {
        if (block.source === 'own') {
          const asins = block.productMatch === 'expanded' && hero ? [hero.asin] : ownAsins;
          return asins.length > 0
            ? pack(
                productList(
                  asins.map((asin) => ({ asin })),
                  block.productMatch ?? 'exact',
                ),
                label,
              )
            : skip('skippedNoProducts');
        }
        if (isConquest(block)) {
          return conquest.length > 0
            ? pack(
                productList(
                  conquest.map((asin) => ({ asin })),
                  'exact',
                ),
                label,
              )
            : skip('skippedNoConquestList');
        }
        // SB und SD nehmen alle; bei SP teilen sich Sammlung und Einzel-Kampagnen die Liste.
        const list =
          block.adProduct !== 'SP' ? productTargets : perTarget ? singleProducts : multiProducts;
        return list.length > 0
          ? pack(productList(list, block.productMatch ?? 'exact'), label)
          : skip('skippedNoProductTargets');
      }
      case 'audience': {
        // Der Katalog lässt nur Rückblicke zu, die Amazon kennt (`SD_LOOKBACK_DAYS`, geprüft im Schema).
        const lookbackDays = (entry.lookbackDays ?? block.lookbackDays ?? 30) as Extract<
          PlannedTarget,
          { type: 'audience' }
        >['lookbackDays'];
        return [
          {
            target: `${lookbackDays}D`,
            targets: [
              {
                type: 'audience',
                audience: block.audience ?? 'views',
                lookbackDays,
                bid: bid(),
              },
            ],
          },
        ];
      }
    }
  }

  // --- Kampagnen ------------------------------------------------------------------------------------------------
  const takenNames = new Set(input.existing.campaignNames.map((name) => name.toLowerCase()));
  const planned: string[] = [];
  const campaigns: PlannedCampaign[] = [];
  const ads = (block: CatalogBlock) => {
    const list =
      block.structure === '1:n:1' || block.adProduct === 'SD' ? items : hero ? [hero] : [];
    const vendor = input.profile.accountType === 'vendor';
    for (const item of list) {
      // Sponsored Brands bewerben über die ASIN.
      if (input.profile.accountType === 'seller' && item.sku === null && block.adProduct !== 'SB') {
        hint({ severity: 'error', code: 'missingSku', asin: item.asin });
      }
    }
    return list.map((item) => ({ asin: item.asin, sku: vendor ? null : item.sku }));
  };

  const maxNameLength = campaignNameMaxLength(input.profile.accountType);
  for (const entry of presetBlocks) {
    const block = blocks.get(entry.block)!;
    const slots = slotsFor(block, entry);
    if (!slots) continue;
    for (const slot of slots) {
      const rendered = renderCampaignName(input.catalog.naming.pattern, {
        adType: block.adProduct,
        block: block.code,
        group: input.productGroup.name,
        target: slot.target,
        client: input.profile.clientName,
        country: input.profile.countryCode,
      });
      const name = uniqueCampaignName(rendered, [...takenNames, ...planned], maxNameLength);
      planned.push(name);
      if (takenNames.has(rendered.toLowerCase())) {
        hint({
          severity: 'warning',
          code: 'campaignNameExists',
          campaign: name,
          existing: rendered,
        });
      }
      for (const issue of campaignNameIssues(name, maxNameLength)) {
        hint({ severity: 'error', code: 'campaignNameInvalid', campaign: name, issue });
      }

      const unlock = input.unlocks[block.key] ?? {};
      let costType: 'cpc' | 'vcpm' = 'cpc';
      if (unlock.vcpm) {
        if (block.adProduct === 'SP')
          hint({ severity: 'error', code: 'vcpmNotAvailable', campaign: name });
        else {
          costType = 'vcpm';
          hint({ severity: 'warning', code: 'vcpmUnlocked', campaign: name });
          hint({ severity: 'warning', code: 'vcpmBidPerThousand', campaign: name });
        }
      }
      let offAmazon = false;
      if (unlock.offAmazon) {
        if (block.adProduct !== 'SP') {
          hint({ severity: 'error', code: 'offAmazonNotAvailable', campaign: name });
        } else {
          offAmazon = true;
          hint({ severity: 'warning', code: 'offAmazonUnlocked', campaign: name });
        }
      }
      if (block.adProduct === 'SB')
        hint({ severity: 'info', code: 'needsCreative', campaign: name });

      campaigns.push({
        block: block.key,
        adProduct: block.adProduct,
        targeting: block.targeting,
        name,
        state: 'ENABLED',
        currencyCode: input.profile.currencyCode,
        dailyBudget: fromEur(entry.dailyBudget ?? block.dailyBudget),
        biddingStrategy: block.biddingStrategy,
        sdOptimization: block.sdOptimization,
        costType,
        offAmazon,
        placements: block.placements && {
          ...block.placements,
          ...(entry.topOfSearch !== undefined && { topOfSearch: entry.topOfSearch }),
        },
        // Sponsored Brands: Anzeigenformat des Bausteins (4.10).
        ...(block.adProduct === 'SB' && block.sbAdFormat !== null && { sbAdFormat: block.sbAdFormat }),
        adGroup: { name, defaultBid: defaultBid(block, entry) },
        ads: ads(block),
        targets: slot.targets,
        negatives: [],
      });
    }
  }

  // --- Trennung über Negatives ----------------------------------------------------------------------------------
  // In der Reihenfolge der Eingabe.
  const exactTexts = keywords
    .filter((keyword) => exactMulti.includes(keyword) || exactSingle.includes(keyword))
    .map((keyword) => keyword.text);
  const negativeExact = (texts: readonly string[]): PlannedNegative[] =>
    texts.map((text) => ({ type: 'keyword', text, matchType: 'negativeExact' }));
  const brandNegatives = brandTerms.map((text): PlannedNegative => ({
    type: 'keyword',
    text,
    matchType: 'negativePhrase',
  }));
  // Geplante fremde Produkte (Sammlung und einzeln) in Auto und Kategorie negativ, einzelne auch in der Sammlung.
  const productNegatives = (list: readonly { asin: string }[]): PlannedNegative[] =>
    list.map(({ asin }) => ({ type: 'product', asin, matchType: 'negativeExact' }));
  const plannedProducts = productTargets.filter(
    (target) =>
      (hasPatMulti && multiProducts.includes(target)) ||
      (hasPatSingle && singleProducts.includes(target)),
  );
  for (const campaign of campaigns) {
    const block = blocks.get(campaign.block)!;
    if (block.source !== 'generic' && block.source !== 'competitor') continue;
    if (block.adProduct === 'SP') {
      if (
        block.targeting === 'auto' ||
        (block.targeting === 'keyword' && block.matchType !== 'exact')
      ) {
        campaign.negatives.push(...negativeExact(exactTexts));
      } else if (block.targeting === 'keyword' && block.structure !== '1:1:1') {
        campaign.negatives.push(...negativeExact(exactSingle.map((keyword) => keyword.text)));
      }
      if (block.targeting === 'auto' || block.targeting === 'category') {
        campaign.negatives.push(...productNegatives(plannedProducts));
      } else if (isProductBlock(false)(block) && hasPatSingle) {
        campaign.negatives.push(...productNegatives(singleProducts));
      }
    }
    // Marke getrennt: allgemeine Keyword- und Auto-Kampagnen (SP und SB) bekommen die Marken-Begriffe negativ.
    const generalKeywords =
      block.source === 'generic' &&
      (block.targeting === 'auto' || block.targeting === 'keyword') &&
      block.adProduct !== 'SD';
    if (hasBrand && generalKeywords) campaign.negatives.push(...brandNegatives);
  }

  // --- Dubletten und Grenzen ------------------------------------------------------------------------------------
  const exactInProfile = new Map(
    input.existing.exactKeywords.map((keyword) => [
      clean(keyword.text).toLowerCase(),
      keyword.campaignName,
    ]),
  );
  for (const campaign of campaigns) {
    for (const target of campaign.targets) {
      if (target.type !== 'keyword' || target.matchType !== 'exact') continue;
      const existing = exactInProfile.get(target.text.toLowerCase());
      if (existing !== undefined) {
        hint({ severity: 'warning', code: 'keywordAlreadyExact', keyword: target.text, existing });
      }
    }
  }
  for (const campaign of campaigns) {
    const check = (field: 'bid' | 'default_bid' | 'budget', value: string) => {
      const limit = input.limitFor({
        adProduct: AD_PRODUCT[campaign.adProduct],
        countryCode: input.profile.countryCode,
        field,
        costType: campaign.costType,
      });
      if (!limit) return;
      const amount = new Dec(value);
      if (amount.lt(limit.min) || amount.gt(limit.max)) {
        hint({
          severity: 'error',
          code: field === 'budget' ? 'budgetOutOfRange' : 'bidOutOfRange',
          campaign: campaign.name,
          value,
          min: limit.min,
          max: limit.max,
        });
      }
    };
    check('budget', campaign.dailyBudget);
    check('default_bid', campaign.adGroup.defaultBid);
    for (const target of campaign.targets) check('bid', target.bid);
  }

  return { campaigns, hints };
}

export { reviewCampaignPlan, type PlanReviewInput, type PlanReviewIssue } from './plan-review';
export { planSetupItems, type SetupItemSpec } from './setup-items';
export {
  harvestCpc,
  harvestInputs,
  isAsinSearchTerm,
  planSourceNegatives,
  type HarvestHint,
  type HarvestMarkSource,
  type HarvestSelection,
} from './harvest';
