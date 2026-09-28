import type {
  MockAccount,
  MockAd,
  MockAdGroup,
  MockCampaign,
  MockProfile,
  MockTarget,
} from './mock-data';

/**
 * Demo-Daten mit Volumen für den Mock-Anbieter (`AMAZON_ADS_MOCK_SCALE=large`, nur Entwicklung, `phase-2.md` F12):
 * 6 Profile in EUR, GBP, SEK und PLN, rund 300 Kampagnen und rund 12 000 Targets (über der Grenze von 10 000
 * Zeilen im Explorer) für SP, SB und SD. Kennzahlen liefert `mockReportRows` wie beim kleinen Mock für jeden
 * angefragten Zeitraum, also auch 95 Tage Historie.
 *
 * Deterministisch: Ein fester Seed je Profil ergibt bei jedem Aufruf dieselben Entities, ein zweiter Sync
 * ändert nichts. Alle Namen sind erfunden (öffentliches Repo); Profile und Clients tragen „Demo“.
 *
 * Enthalten, damit Explorer und Abfragen die Sonderfälle zeigen: SB-Kampagnen ohne Kennzahlen (v3-Preview-Lücke,
 * `withoutReports`), Negatives auf Kampagnen- (nur SP) und Ad-Group-Ebene, pausierte und archivierte Entities,
 * SB-Kollektionen und SD-Bild-Ads mit mehreren ASINs, SD-vCPM-Kampagnen, ein Vendor-Profil ohne SKU.
 */

export interface LargeMockProfile extends MockProfile {
  countryCode: string;
  marketplaceId: string;
  timezone: string;
  accountId: string;
  accountName: string;
}

export const LARGE_MOCK_PROFILES: readonly LargeMockProfile[] = [
  {
    amazonProfileId: '7100000000000001',
    countryCode: 'DE',
    currencyCode: 'EUR',
    marketplaceId: 'A1PA6795UKMFR9',
    timezone: 'Europe/Berlin',
    accountType: 'seller',
    accountId: 'A1DEMOSELLER01',
    accountName: 'Demo Waldkauz DE',
  },
  {
    amazonProfileId: '7100000000000002',
    countryCode: 'FR',
    currencyCode: 'EUR',
    marketplaceId: 'A13V1IB3VIYZZH',
    timezone: 'Europe/Paris',
    accountType: 'seller',
    accountId: 'A1DEMOSELLER01',
    accountName: 'Demo Waldkauz FR',
  },
  {
    amazonProfileId: '7100000000000003',
    countryCode: 'UK',
    currencyCode: 'GBP',
    marketplaceId: 'A1F83G8C2ARO7P',
    timezone: 'Europe/London',
    accountType: 'vendor',
    accountId: 'ENTITY1DEMOVENDOR',
    accountName: 'Demo Lumen UK',
  },
  {
    amazonProfileId: '7100000000000004',
    countryCode: 'SE',
    currencyCode: 'SEK',
    marketplaceId: 'A2NODRKZP88ZB9',
    timezone: 'Europe/Stockholm',
    accountType: 'agency',
    accountId: 'ENTITY2DEMOAGENCY',
    accountName: 'Demo Lumen SE',
  },
  {
    amazonProfileId: '7100000000000005',
    countryCode: 'PL',
    currencyCode: 'PLN',
    marketplaceId: 'A1C3SOZRARQ6R3',
    timezone: 'Europe/Warsaw',
    accountType: 'seller',
    accountId: 'A1DEMOSELLER02',
    accountName: 'Demo Kranich PL',
  },
  {
    amazonProfileId: '7100000000000006',
    countryCode: 'IT',
    currencyCode: 'EUR',
    marketplaceId: 'APJ6JRA9NG5V4',
    timezone: 'Europe/Rome',
    accountType: 'seller',
    accountId: 'A1DEMOSELLER03',
    accountName: 'Demo Ohne Client IT',
  },
];

/** Clients für den Seed-Schritt (Clients kommen nicht von Amazon). Das IT-Profil bleibt ohne Client. */
export const LARGE_MOCK_CLIENTS: ReadonlyArray<{
  name: string;
  slug: string;
  amazonProfileIds: readonly string[];
}> = [
  {
    name: 'Waldkauz (Demo)',
    slug: 'waldkauz-demo',
    amazonProfileIds: ['7100000000000001', '7100000000000002'],
  },
  {
    name: 'Lumen (Demo)',
    slug: 'lumen-demo',
    amazonProfileIds: ['7100000000000003', '7100000000000004'],
  },
  { name: 'Kranich (Demo)', slug: 'kranich-demo', amazonProfileIds: ['7100000000000005'] },
];

/** Kampagnen je Profil (zusammen 300). */
const CAMPAIGNS_PER_PROFILE = [60, 55, 50, 50, 45, 40];

/** Sortiment je Profil: erfundene Produktwörter, daraus Kampagnen, Keywords und Portfolios. */
const CATALOGS: ReadonlyArray<{ brand: string; products: readonly string[] }> = [
  {
    brand: 'Waldkauz',
    products: [
      'Wanderrucksack',
      'Trinkflasche',
      'Stirnlampe',
      'Zeltheringe',
      'Isomatte',
      'Regenjacke',
    ],
  },
  {
    brand: 'Waldkauz',
    products: ['Wanderrucksack', 'Trinkflasche', 'Stirnlampe', 'Schlafsack', 'Kocher', 'Isomatte'],
  },
  {
    brand: 'Lumen',
    products: ['Tischleuchte', 'Lichterkette', 'Nachtlicht', 'Deckenleuchte', 'Leselampe'],
  },
  {
    brand: 'Lumen',
    products: ['Tischleuchte', 'Lichterkette', 'Wandleuchte', 'Gartenleuchte', 'Leselampe'],
  },
  {
    brand: 'Kranich',
    products: ['Holzpuzzle', 'Malset', 'Bauklötze', 'Spielteppich', 'Kinderrucksack', 'Knete'],
  },
  {
    brand: 'Ohne Client',
    products: ['Teedose', 'Gewürzmühle', 'Brotkasten', 'Schneidebrett', 'Vorratsglas'],
  },
];

const ADJECTIVES = [
  'leicht',
  'wasserdicht',
  'faltbar',
  'groß',
  'klein',
  'nachhaltig',
  'kinder',
  'set',
  'premium',
  'günstig',
  'robust',
  'bunt',
  'aus holz',
  'mit usb',
  'geschenk',
  'extra lang',
];
const MATCH_TYPES = ['EXACT', 'PHRASE', 'BROAD'];
const AUTO_MATCH_TYPES = [
  'SEARCH_CLOSE_MATCH',
  'SEARCH_LOOSE_MATCH',
  'ASIN_SUBSTITUTE_RELATED',
  'ASIN_ACCESSORY_RELATED',
];
const SB_THEMES = ['KEYWORDS_RELATED_TO_YOUR_BRAND', 'KEYWORDS_RELATED_TO_YOUR_LANDING_PAGES'];

const SP = 'SPONSORED_PRODUCTS';
const SB = 'SPONSORED_BRANDS';
const SD = 'SPONSORED_DISPLAY';

/** Mulberry32: kleiner, deterministischer Zufallsgenerator. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seedOf(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** Konto eines Demo-Profils. Unbekannte Profile bekommen ein leeres Konto. */
export function largeMockAccount(profile: MockProfile): MockAccount {
  const index = LARGE_MOCK_PROFILES.findIndex((p) => p.amazonProfileId === profile.amazonProfileId);
  const empty = { profile, portfolios: [], campaigns: [], adGroups: [], targets: [], ads: [] };
  if (index < 0) return empty;

  const rnd = random(seedOf(`profitbash-demo-${profile.amazonProfileId}`));
  const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;
  const chance = (p: number) => rnd() < p;
  const money = (min: number, max: number, decimals = 2) =>
    (min + rnd() * (max - min)).toFixed(decimals);

  let counter = 0;
  const id = () => `${profile.amazonProfileId}${String((counter += 1)).padStart(6, '0')}`;
  const catalog = CATALOGS[index]!;
  const letter = String.fromCharCode(65 + index);
  const seller = profile.accountType !== 'vendor';

  // Produkte (ASIN, SKU) je Produktwort: 6–10 Varianten.
  const products = catalog.products.map((word, w) =>
    Array.from({ length: int(6, 10) }, (_, v) => {
      const n = w * 100 + v + 1;
      return {
        asin: `B0${letter}${String(n).padStart(7, '0')}`,
        sku: `${catalog.brand.slice(0, 3).toUpperCase()}-${word.slice(0, 4).toUpperCase()}-${v + 1}`,
      };
    }),
  );

  const portfolios = [
    ...catalog.products.slice(0, 4).map((word, i) => ({
      id: id(),
      name: `${catalog.brand} ${word}`,
      budget: i % 2 === 0 ? money(500, 5000) : null,
      policy: i % 2 === 0 ? 'MONTHLY_RECURRING' : 'NO_CAP',
    })),
    { id: id(), name: `${catalog.brand} Marke`, budget: money(1000, 3000), policy: 'DATE_RANGE' },
  ];

  const campaigns: MockCampaign[] = [];
  const adGroups: MockAdGroup[] = [];
  const targets: MockTarget[] = [];
  const ads: MockAd[] = [];

  const campaignState = () => {
    const r = rnd();
    return r < 0.7 ? 'ENABLED' : r < 0.9 ? 'PAUSED' : 'ARCHIVED';
  };
  const childState = (parent: string) =>
    parent === 'ARCHIVED' ? 'ARCHIVED' : chance(0.85) ? 'ENABLED' : 'PAUSED';
  const keyword = (word: string) => {
    const base = word.toLowerCase();
    return chance(0.3) ? base : `${base} ${pick(ADJECTIVES)}`;
  };

  for (let c = 0; c < CAMPAIGNS_PER_PROFILE[index]!; c += 1) {
    const w = int(0, catalog.products.length - 1);
    const word = catalog.products[w]!;
    const range = products[w]!;
    const r = rnd();
    const adProduct = r < 0.7 ? SP : r < 0.85 ? SB : SD;
    const state = campaignState();
    const portfolioId = chance(0.7) ? pick(portfolios).id : null;
    const campaignId = id();

    if (adProduct === SP) {
      const auto = chance(0.25);
      const productTargeting = !auto && chance(0.3);
      const suffix = auto
        ? 'Auto'
        : productTargeting
          ? 'Produkte'
          : pick(['Exakt', 'Phrase', 'Breit']);
      campaigns.push({
        id: campaignId,
        adProduct,
        name: `SP ${catalog.brand} ${word} ${suffix} ${c + 1}`,
        state,
        targeting: auto ? 'AUTO' : 'MANUAL',
        budget: money(5, 150),
        portfolioId,
      });
      for (let g = 0, groups = int(2, 3); g < groups; g += 1) {
        const groupId = id();
        const groupState = childState(state);
        adGroups.push({
          id: groupId,
          campaignId,
          name: `${word} ${g + 1}`,
          state: groupState,
          defaultBid: money(0.2, 1.8),
        });
        const count = auto ? AUTO_MATCH_TYPES.length : int(22, 36);
        for (let t = 0; t < count; t += 1) {
          const details = auto
            ? { matchType: AUTO_MATCH_TYPES[t]! }
            : productTargeting
              ? chance(0.8)
                ? {
                    matchType: 'PRODUCT_EXACT',
                    asin: `B0Z${String(int(1, 9_999_999)).padStart(7, '0')}`,
                  }
                : {
                    productCategoryId: String(int(1_000_000, 9_999_999)),
                    productCategoryResolved: word,
                  }
              : { matchType: pick(MATCH_TYPES), keyword: keyword(word) };
          const kw = 'keyword' in details ? String(details.keyword) : null;
          targets.push({
            id: id(),
            campaignId,
            adGroupId: groupId,
            state: childState(groupState),
            negative: false,
            targetType: auto
              ? 'AUTO'
              : productTargeting
                ? 'asin' in details
                  ? 'PRODUCT'
                  : 'PRODUCT_CATEGORY'
                : 'KEYWORD',
            details,
            bid: money(0.15, 2.5),
            ...(kw !== null && {
              searchTerms: chance(0.5) ? [kw] : [kw, `${kw} ${pick(ADJECTIVES)}`],
            }),
            ...(auto && { searchTerms: [keyword(word), keyword(word)] }),
            ...(productTargeting && { searchTerms: [pick(range).asin.toLowerCase()] }),
          });
        }
        for (let n = 0, negatives = int(0, 2); n < negatives; n += 1) {
          targets.push({
            id: id(),
            campaignId,
            adGroupId: groupId,
            state: 'ENABLED',
            negative: true,
            targetType: 'KEYWORD',
            details: { matchType: 'EXACT', keyword: `${word.toLowerCase()} gebraucht` },
            bid: null,
          });
        }
        for (let a = 0, count = int(1, 4); a < count; a += 1) {
          const product = pick(range);
          ads.push({
            id: id(),
            campaignId,
            adGroupId: groupId,
            state: childState(groupState),
            adType: 'PRODUCT_AD',
            asins: [product.asin],
            ...(seller && { sku: product.sku }),
          });
        }
      }
      for (let n = 0, negatives = int(0, 3); n < negatives; n += 1) {
        const byKeyword = chance(0.5);
        targets.push({
          id: id(),
          campaignId,
          adGroupId: null,
          state: 'ENABLED',
          negative: true,
          targetType: byKeyword ? 'KEYWORD' : 'PRODUCT',
          details: byKeyword
            ? { matchType: 'EXACT', keyword: `${word.toLowerCase()} kostenlos` }
            : {
                matchType: 'PRODUCT_EXACT',
                asin: `B0Y${String(int(1, 9_999_999)).padStart(7, '0')}`,
              },
          bid: null,
        });
      }
      continue;
    }

    if (adProduct === SB) {
      const collection = chance(0.5);
      campaigns.push({
        id: campaignId,
        adProduct,
        name: `SB ${catalog.brand} ${word} ${collection ? 'Kollektion' : 'Video'} ${c + 1}`,
        state,
        targeting: 'MANUAL',
        budget: money(10, 80),
        portfolioId,
        ...(chance(0.25) && { withoutReports: true }),
      });
      for (let g = 0, groups = int(1, 2); g < groups; g += 1) {
        const groupId = id();
        const groupState = childState(state);
        adGroups.push({
          id: groupId,
          campaignId,
          name: `${word} Marke ${g + 1}`,
          state: groupState,
          defaultBid: null,
        });
        for (let t = 0, count = int(6, 12); t < count; t += 1) {
          const theme = t === 0;
          const kw = keyword(word);
          targets.push({
            id: id(),
            campaignId,
            adGroupId: groupId,
            state: childState(groupState),
            negative: false,
            targetType: theme ? 'THEME' : 'KEYWORD',
            details: theme
              ? { matchType: pick(SB_THEMES) }
              : { matchType: pick(MATCH_TYPES), keyword: kw },
            bid: money(0.4, 3),
            searchTerms: [theme ? `${catalog.brand.toLowerCase()} ${word.toLowerCase()}` : kw],
          });
        }
        targets.push({
          id: id(),
          campaignId,
          adGroupId: groupId,
          state: 'ENABLED',
          negative: true,
          targetType: 'KEYWORD',
          details: { matchType: 'EXACT', keyword: `${word.toLowerCase()} reparatur` },
          bid: null,
        });
        const asins = collection
          ? [pick(range).asin, pick(range).asin, pick(range).asin].filter(
              (a, i, all) => all.indexOf(a) === i,
            )
          : [pick(range).asin];
        ads.push({
          id: id(),
          campaignId,
          adGroupId: groupId,
          state: childState(groupState),
          adType: collection ? 'PRODUCT_COLLECTION' : 'VIDEO',
          asins,
        });
      }
      continue;
    }

    const audiences = chance(0.5);
    const vcpm = audiences && chance(0.6);
    campaigns.push({
      id: campaignId,
      adProduct,
      name: `SD ${catalog.brand} ${word} ${audiences ? 'Zielgruppen' : 'Produkte'} ${c + 1}`,
      state,
      targeting: audiences ? 'T00030' : 'T00020',
      costType: vcpm ? 'VCPM' : 'CPC',
      budget: money(5, 60),
      portfolioId,
    });
    for (let g = 0, groups = int(1, 2); g < groups; g += 1) {
      const groupId = id();
      const groupState = childState(state);
      adGroups.push({
        id: groupId,
        campaignId,
        name: `${word} ${audiences ? 'Zielgruppe' : 'Produkte'} ${g + 1}`,
        state: groupState,
        defaultBid: vcpm ? money(2, 8) : money(0.3, 1.5),
      });
      for (let t = 0, count = int(4, 8); t < count; t += 1) {
        const category = !audiences && chance(0.3);
        targets.push({
          id: id(),
          campaignId,
          adGroupId: groupId,
          state: childState(groupState),
          negative: false,
          targetType: audiences ? 'AUDIENCE' : category ? 'PRODUCT_CATEGORY' : 'PRODUCT',
          details: audiences
            ? { event: pick(['VIEWS', 'PURCHASES']), lookback: pick([7, 14, 30, 60]) }
            : category
              ? {
                  productCategoryId: String(int(1_000_000, 9_999_999)),
                  productCategoryResolved: word,
                }
              : { matchType: 'PRODUCT_EXACT', asin: pick(range).asin },
          bid: audiences ? null : money(0.3, 2),
        });
      }
      if (!audiences) {
        targets.push({
          id: id(),
          campaignId,
          adGroupId: groupId,
          state: 'ENABLED',
          negative: true,
          targetType: 'PRODUCT',
          details: { matchType: 'PRODUCT_EXACT', asin: pick(range).asin },
          bid: null,
        });
      }
      const image = chance(0.3);
      const first = pick(range);
      ads.push({
        id: id(),
        campaignId,
        adGroupId: groupId,
        state: childState(groupState),
        adType: image ? 'IMAGE' : 'PRODUCT_AD',
        asins: image
          ? [first.asin, range.find((p) => p !== first)?.asin ?? first.asin]
          : [first.asin],
        ...(seller && { sku: first.sku }),
      });
    }
  }

  return { profile, portfolios, campaigns, adGroups, targets, ads };
}
