import type { CatalogEdge, PresetSwitch } from '@profitbash/shared/structure-catalog';
import { Dec, formatDecimal, parseDecimal, type DecimalString } from './decimal';
import { isAsinSearchTerm } from './harvest';
import { comparableSearchTerm } from './search-terms';

/**
 * Graduation- und Preset-Vorschläge (`docs/tasks/phase-5.md` 5.11b), ohne I/O: was nach den Kanten und
 * Preset-Wechseln des Struktur-Katalogs (5.11a) im Datei-Zeitraum fällig wäre. Angenommen wird immer von Hand
 * (Merkliste bzw. Preset der Produktgruppe).
 */

const percent = (value: Dec) => formatDecimal(value.toDecimalPlaces(2));
/** ACoS in Prozent; `null` ohne Umsatz. */
const acosOf = (spend: Dec, sales: Dec) => (sales.isZero() ? null : spend.div(sales).mul(100));

export interface GraduationInput {
  blocks: readonly { key: string; targeting: string }[];
  edges: readonly CatalogEdge[];
  /** Baustein je Amazon-Kampagnen-ID (aus dem Setup oder von Hand bestätigt, 5.11a). */
  campaignBlocks: ReadonlyMap<string, string>;
  /** Suchbegriff-Zeilen eines Datei-Zeitraums. */
  rows: readonly {
    searchTerm: string;
    amazonCampaignId: string;
    clicks: number;
    orders: number;
    spend: DecimalString;
    sales: DecimalString;
  }[];
  /** Harvest-Regel des Profils (Suchbegriff-Einstufung); gilt je Feld, das die Kante leer lässt. `maxAcos` als Bruch. */
  harvest: { minOrders: number; maxAcos: DecimalString };
  /** Wirksames Ziel in Prozent; ohne Ziel gilt der ACoS der Harvest-Regel. */
  goalAcos: DecimalString | null;
  /** Begriffe auf der Merkliste (Vergleichsform). */
  marked: ReadonlySet<string>;
  /** Je Begriff die Bausteine der Kampagnen, die ihn schon exakt buchen (`null` = Kampagne ohne Baustein). */
  exactIn: ReadonlyMap<string, readonly (string | null)[]>;
}

export interface GraduationProposal {
  termKey: string;
  searchTerm: string;
  fromBlock: string;
  /** Ziel-Bausteine, deren Kante die Kriterien erfüllt. */
  toBlocks: string[];
  /** Kampagne der ersten Zeile des Begriffs im Baustein (Anzeige). */
  amazonCampaignId: string;
  clicks: number;
  orders: number;
  spend: DecimalString;
  sales: DecimalString;
  acos: DecimalString;
}

/** Bausteine, die über Kanten von `key` aus erreichbar sind, samt `key`. */
function downstream(edges: readonly CatalogEdge[], key: string): Set<string> {
  const seen = new Set([key]);
  for (const current of seen) {
    for (const edge of edges) if (edge.from === current) seen.add(edge.to);
  }
  return seen;
}

/**
 * Je Suchbegriff höchstens ein Vorschlag: aus dem Baustein, in dem er die meisten Bestellungen hat und mindestens
 * eine ausgehende Kante erfüllt. Eine Kante zählt nicht, wenn der Begriff im Ziel, weiter hinten oder in einer
 * Kampagne ohne Baustein schon exakt gebucht ist.
 */
export function graduationProposals(input: GraduationInput): GraduationProposal[] {
  const targeting = new Map(input.blocks.map((block) => [block.key, block.targeting]));
  const goal = input.goalAcos === null ? null : parseDecimal(input.goalAcos);
  const harvestAcos = parseDecimal(input.harvest.maxAcos).mul(100);

  interface Sum {
    termKey: string;
    searchTerm: string;
    fromBlock: string;
    amazonCampaignId: string;
    clicks: number;
    orders: number;
    spend: Dec;
    sales: Dec;
  }
  const sums = new Map<string, Sum>();
  for (const row of input.rows) {
    const fromBlock = input.campaignBlocks.get(row.amazonCampaignId);
    if (fromBlock === undefined) continue;
    const termKey = comparableSearchTerm(row.searchTerm);
    if (termKey === '' || input.marked.has(termKey)) continue;
    const key = `${fromBlock}\n${termKey}`;
    const sum = sums.get(key) ?? {
      termKey,
      searchTerm: row.searchTerm,
      fromBlock,
      amazonCampaignId: row.amazonCampaignId,
      clicks: 0,
      orders: 0,
      spend: new Dec(0),
      sales: new Dec(0),
    };
    sum.clicks += row.clicks;
    sum.orders += row.orders;
    sum.spend = sum.spend.plus(parseDecimal(row.spend));
    sum.sales = sum.sales.plus(parseDecimal(row.sales));
    sums.set(key, sum);
  }

  const best = new Map<string, GraduationProposal>();
  for (const sum of sums.values()) {
    const acos = acosOf(sum.spend, sum.sales);
    if (acos === null) continue;
    const wanted = isAsinSearchTerm(sum.searchTerm) ? 'product' : 'keyword';
    const booked = input.exactIn.get(sum.termKey) ?? [];
    const toBlocks = input.edges
      .filter((edge) => {
        if (edge.from !== sum.fromBlock || targeting.get(edge.to) !== wanted) return false;
        if (sum.orders < (edge.minOrders ?? input.harvest.minOrders)) return false;
        const maxAcos =
          edge.maxAcosPercentOfGoal !== null && goal !== null
            ? goal.mul(edge.maxAcosPercentOfGoal).div(100)
            : harvestAcos;
        if (acos.gt(maxAcos)) return false;
        const reached = downstream(input.edges, edge.to);
        return !booked.some((block) => block === null || reached.has(block));
      })
      .map((edge) => edge.to);
    if (toBlocks.length === 0) continue;
    const current = best.get(sum.termKey);
    if (current && current.orders >= sum.orders) continue;
    best.set(sum.termKey, {
      termKey: sum.termKey,
      searchTerm: sum.searchTerm,
      fromBlock: sum.fromBlock,
      toBlocks,
      amazonCampaignId: sum.amazonCampaignId,
      clicks: sum.clicks,
      orders: sum.orders,
      spend: formatDecimal(sum.spend),
      sales: formatDecimal(sum.sales),
      acos: percent(acos),
    });
  }
  return [...best.values()];
}

export interface PresetSwitchInput {
  switches: readonly PresetSwitch[];
  /** Produktgruppen mit wirksamem Preset, den Summen ihrer Produkte im Datenstand und ihrem wirksamen Ziel. */
  groups: readonly {
    id: string;
    presetKey: string;
    orders: number;
    spend: DecimalString;
    sales: DecimalString;
    goalAcos: DecimalString | null;
  }[];
  /** Ein Euro in der Währung des Profils (Mindest-Ausgaben stehen im Katalog in EUR). */
  eurRate: DecimalString;
}

export interface PresetSwitchProposal {
  productGroupId: string;
  from: string;
  to: string;
  orders: number;
  spend: DecimalString;
  sales: DecimalString;
  /** `null`: Ausgaben ohne Umsatz. */
  acos: DecimalString | null;
  goalAcos: DecimalString | null;
}

/** Je Produktgruppe der erste Wechsel aus ihrem Preset, dessen gesetzte Bedingungen alle zutreffen. */
export function presetSwitchProposals(input: PresetSwitchInput): PresetSwitchProposal[] {
  const eurRate = parseDecimal(input.eurRate);
  return input.groups.flatMap((group): PresetSwitchProposal[] => {
    const spend = parseDecimal(group.spend);
    const acos = acosOf(spend, parseDecimal(group.sales));
    const goal = group.goalAcos === null ? null : parseDecimal(group.goalAcos);
    const match = input.switches.find((entry) => {
      if (entry.from !== group.presetKey) return false;
      if (entry.minOrders !== null && group.orders < entry.minOrders) return false;
      if (entry.minSpend !== null && spend.lt(parseDecimal(entry.minSpend).mul(eurRate))) {
        return false;
      }
      if (entry.acos === null) return true;
      if (goal === null || spend.isZero()) return false;
      const limit = goal.mul(entry.acos.percentOfGoal).div(100);
      // Ausgaben ohne Umsatz liegen über jeder Schwelle.
      return entry.acos.comparison === 'gte'
        ? acos === null || acos.gte(limit)
        : acos !== null && acos.lte(limit);
    });
    if (!match) return [];
    return [
      {
        productGroupId: group.id,
        from: match.from,
        to: match.to,
        orders: group.orders,
        spend: group.spend,
        sales: group.sales,
        acos: acos && percent(acos),
        goalAcos: group.goalAcos,
      },
    ];
  });
}
