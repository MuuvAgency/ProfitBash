import type { CheckKind, CheckSettings } from '@profitbash/shared/automation-checks';
import { Dec, formatDecimal, parseDecimal, type DecimalString } from './decimal';
import type { RuleSubject } from './rules';

/**
 * Prüfungen „kein Geld verbrennen“ (`docs/tasks/phase-5.md` 5.10), ohne I/O: Befunde eines Profils aus Struktur
 * und Zeitraumsummen des Datenstands. Ein Befund ist an (Art, Entity, `key`) zu erkennen; der Lauf gleicht damit
 * ab, was neu ist und was verschwunden.
 */

type Sums = RuleSubject['metrics'];

export interface ChecksInput {
  settings: CheckSettings;
  profileId: string;
  /** Ein Euro in der Währung des Profils. */
  eurRate: DecimalString;
  /** Ziel von Profil bzw. Client in Prozent (Kampagnen tragen Produkte mehrerer Gruppen); `null` ohne Ziel. */
  goalAcos: DecimalString | null;
  campaigns: readonly {
    id: string;
    state: string;
    costType: string | null;
    metrics: Sums | null;
    /** Gebotsanpassungen je Platzierung mit den Summen der Platzierung, soweit die Datei sie liefert. */
    placements: readonly { placement: string; percent: number; metrics: Sums | null }[];
    /** Die Kampagne fällt unter mindestens einen Budget-Cap. */
    capped: boolean;
  }[];
  targets: readonly { id: string; campaignId: string; state: string; metrics: Sums }[];
}

export interface CheckResult {
  kind: CheckKind;
  entityType: 'campaign' | 'target' | 'profile';
  entityId: string;
  campaignId: string | null;
  /** Unterscheidet mehrere Befunde einer Art an derselben Entity (Platzierung), sonst leer. */
  key: string;
  detail: Record<string, unknown>;
}

const ACTIVE = 'ENABLED';
const percent = (value: Dec) => formatDecimal(value.toDecimalPlaces(2));

export function runChecks(input: ChecksInput): CheckResult[] {
  const { settings } = input;
  const results: CheckResult[] = [];
  const active = input.campaigns.filter((campaign) => campaign.state === ACTIVE);
  const goal = input.goalAcos === null ? null : parseDecimal(input.goalAcos);

  for (const campaign of active) {
    const base = {
      entityType: 'campaign' as const,
      entityId: campaign.id,
      campaignId: campaign.id,
    };
    if (settings.enabled.vcpm && campaign.costType?.toUpperCase() === 'VCPM') {
      results.push({ kind: 'vcpm', ...base, key: '', detail: {} });
    }
    if (!settings.enabled.placement || goal === null) continue;
    for (const { placement, percent: adjustment, metrics } of campaign.placements) {
      if (adjustment < settings.placementMinPercent) continue;
      const own = metrics !== null && parseDecimal(metrics.spend).isPositive();
      const sums = own ? metrics : campaign.metrics;
      if (sums === null) continue;
      const spend = parseDecimal(sums.spend);
      const sales = parseDecimal(sums.sales);
      if (!spend.isPositive() || spend.isZero()) continue;
      // Ausgaben ohne Umsatz liegen über jedem Ziel.
      const acos = sales.isZero() ? null : spend.div(sales).mul(100);
      if (acos !== null && acos.lte(goal)) continue;
      results.push({
        kind: 'placement',
        ...base,
        key: placement,
        detail: {
          percent: adjustment,
          acos: acos && percent(acos),
          goalAcos: formatDecimal(goal),
          basis: own ? 'placement' : 'campaign',
          spend: formatDecimal(spend),
          sales: formatDecimal(sales),
        },
      });
    }
  }

  if (settings.enabled.spendNoOrders) {
    const activeIds = new Set(active.map((campaign) => campaign.id));
    const minSpend = parseDecimal(settings.spendNoOrdersMinEur).mul(parseDecimal(input.eurRate));
    for (const target of input.targets) {
      if (target.state !== ACTIVE || !activeIds.has(target.campaignId)) continue;
      const spend = parseDecimal(target.metrics.spend);
      if (target.metrics.orders > 0 || spend.lt(minSpend)) continue;
      results.push({
        kind: 'spendNoOrders',
        entityType: 'target',
        entityId: target.id,
        campaignId: target.campaignId,
        key: '',
        detail: { spend: formatDecimal(spend), clicks: target.metrics.clicks },
      });
    }
  }

  const profile = { entityType: 'profile' as const, entityId: input.profileId, campaignId: null };
  if (settings.enabled.noGoal && goal === null && active.length > 0) {
    results.push({ kind: 'noGoal', ...profile, key: '', detail: { campaigns: active.length } });
  }
  const uncapped = active.filter((campaign) => !campaign.capped).length;
  if (settings.enabled.noCap && uncapped > 0) {
    results.push({ kind: 'noCap', ...profile, key: '', detail: { campaigns: uncapped } });
  }
  return results;
}
