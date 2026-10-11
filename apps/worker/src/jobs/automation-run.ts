import { amazonAdsValueLimit } from '@profitbash/amazon-ads';
import {
  listAutomationRunProfiles,
  loadAutomationRunEntities,
  planAutomationRun,
  saveAutomationRun,
  type AutomationPeriodSums,
  type AutomationProposalInput,
  type AutomationRunEntities,
  type AutomationRunPlan,
  type Db,
} from '@profitbash/db';
import {
  decideCampaign,
  decideTarget,
  effectiveGoal,
  enforceCap,
  formatDecimal,
  parseDecimal,
  type CapAction,
  type Decision,
} from '@profitbash/engine';
import { z } from 'zod';
import type { JobOutcome, JobRunResult, RunJob } from '../run-job';

/**
 * Job `automation-run` je Profil (`docs/tasks/phase-5.md` 5.7): Datenstand → Regeln → Optimizer → Leitplanken →
 * Lauf und Vorschläge. Nichts geht an Amazon: Im Schattenmodus bleiben die Vorschläge im Protokoll, im Modus
 * `cart` landen sie im Warenkorb des zuständigen Nutzers (ADR 006).
 */

export const automationRunJobDataSchema = z.object({
  organizationId: z.uuid(),
  profileId: z.uuid(),
});
export type AutomationRunJobData = z.infer<typeof automationRunJobDataSchema>;

const ACTIVE = 'ENABLED';
const state = (value: string | null) => value?.toUpperCase() ?? '';

/**
 * Rechnet die Vorschläge eines Laufs (ohne I/O). `counts`: geprüfte Targets und Kampagnen und je Grund, wie oft es
 * keinen Vorschlag gab (`manualPending`: von Hand gelegte offene Änderung; `budgetCap`: Kampagne unter einem Cap
 * mit Prognose über dem Betrag, bei der es nichts zu senken gibt).
 *
 * Vorrang (Dominik, 2026-10-11): Liegt die Prognose eines Caps über dem Betrag, gilt für dessen Kampagnen der
 * Vorschlag des Enforcers, Budget-Regeln ruhen dort. Fällt eine Kampagne unter mehrere solche Caps, gilt der
 * strengste Vorschlag (pausieren vor dem niedrigsten Budget).
 */
export function computeAutomationProposals(
  plan: AutomationRunPlan,
  entities: AutomationRunEntities,
): { proposals: AutomationProposalInput[]; counts: Record<string, number> } {
  const { profile, eurRate } = plan;
  // Beträge der Leitplanken sind in EUR (`phase-5.md` 5.4).
  const inProfileCurrency = (eur: string) =>
    formatDecimal(parseDecimal(eur).times(parseDecimal(eurRate)));
  const guardrails = {
    maxBidChangePercent: plan.guardrails.maxBidChangePercent,
    bidFloorCpcPercent: plan.guardrails.bidFloorCpcPercent,
    bidFloor: plan.guardrails.bidFloorEur && inProfileCurrency(plan.guardrails.bidFloorEur),
    maxBid: plan.guardrails.maxBidEur && inProfileCurrency(plan.guardrails.maxBidEur),
    minClicks: plan.guardrails.minClicks,
    minSpend: inProfileCurrency(plan.guardrails.minSpendEur),
  };
  const goalAcos = (productGroupIds: readonly string[]) =>
    effectiveGoal(plan.goals, {
      clientId: profile.clientId,
      profileId: profile.id,
      productGroupIds,
    })?.acos ?? null;
  const limit = (adProduct: string, field: 'bid' | 'budget', costType: string | null) =>
    amazonAdsValueLimit({ adProduct, countryCode: profile.countryCode, field, costType }) ?? null;
  const sums = ({ clicks, spend, sales }: AutomationPeriodSums) => ({ clicks, spend, sales });

  const proposals: AutomationProposalInput[] = [];
  const counts: Record<string, number> = { targets: 0, campaigns: 0 };
  const count = (key: string) => (counts[key] = (counts[key] ?? 0) + 1);
  const take = (
    decision: Decision,
    entity: Pick<AutomationProposalInput, 'entityType' | 'entityId' | 'campaignId' | 'adGroupId'>,
    detail: Record<string, unknown>,
  ) => {
    if (decision.kind === 'none') return count(decision.reason);
    proposals.push({
      ...entity,
      field: decision.field,
      before: decision.before,
      after: decision.after,
      source: decision.source,
      ruleId: decision.ruleId,
      limitedBy: decision.limitedBy,
      detail: {
        ...detail,
        period: plan.state.period,
        ...(decision.desired !== undefined && { desired: decision.desired }),
        ...(decision.valuePerClick !== undefined && { valuePerClick: decision.valuePerClick }),
      },
    });
  };

  const campaigns = new Map(entities.campaigns.map((campaign) => [campaign.id, campaign]));
  const adGroups = new Map(entities.adGroups.map((adGroup) => [adGroup.id, adGroup]));
  for (const target of entities.targets) {
    const campaign = campaigns.get(target.campaignId);
    if (!campaign) continue;
    counts.targets! += 1;
    if (entities.manualPending.has(target.id)) {
      count('manualPending');
      continue;
    }
    const adGroup = target.adGroupId === null ? undefined : adGroups.get(target.adGroupId);
    const goal = goalAcos(adGroup?.productGroupIds ?? []);
    const basis = entities.bases.get(`${target.id}:bid`);
    const decision = decideTarget({
      target: { state: state(target.state), bid: target.bid, metrics: sums(target.metrics) },
      // Targets ohne Ad Group (SB): keine Ebene dazwischen, kein Standardgebot.
      adGroup: adGroup
        ? {
            state: state(adGroup.state),
            defaultBid: adGroup.defaultBid,
            metrics: adGroup.metrics && sums(adGroup.metrics),
          }
        : { state: ACTIVE, defaultBid: null, metrics: null },
      campaign: {
        state: state(campaign.state),
        costType: campaign.costType,
        metrics: campaign.metrics && sums(campaign.metrics),
      },
      goalAcos: goal,
      guardrails,
      limit: limit(target.adProduct, 'bid', campaign.costType),
      ...(basis && { base: basis.base, windowStart: basis.windowStart }),
      rules: plan.rules,
      clientId: profile.clientId,
      impressions: target.metrics.impressions,
      orders: target.metrics.orders,
      eurRate,
      protectedTerm: target.protectedTerm,
    });
    take(
      decision,
      {
        entityType: 'target',
        entityId: target.id,
        campaignId: target.campaignId,
        adGroupId: target.adGroupId,
      },
      { ...target.metrics, goalAcos: goal, hasOwnBid: target.bid !== null },
    );
  }

  const budgetOf = (campaign: AutomationRunEntities['campaigns'][number]) =>
    entities.bases.get(`${campaign.id}:budget`)?.base ?? campaign.budget;
  const capped = new Set<string>();
  const capActions = new Map<string, { action: CapAction; cap: (typeof plan.caps)[number] }>();
  for (const cap of plan.caps) {
    if (!cap.pacing.forecastOver) continue;
    const actions = enforceCap({
      month: cap.month,
      cap: cap.amount,
      maxBudgetDecreasePercent: plan.guardrails.maxBudgetDecreasePercent,
      // Alle Kampagnen im Umfang zählen fürs Ist; senken lässt sich nur, was der Lauf kennt.
      campaigns: cap.campaigns.flatMap(({ id, input }) => {
        if (input === null) return [];
        const campaign = campaigns.get(id);
        if (!campaign) return [{ ...input, id, active: false, limit: null }];
        capped.add(id);
        return [
          {
            ...input,
            id,
            dailyBudget: budgetOf(campaign),
            limit: limit(campaign.adProduct, 'budget', campaign.costType),
          },
        ];
      }),
    });
    for (const action of actions) {
      const other = capActions.get(action.id)?.action;
      const stricter =
        other === undefined ||
        (other.field === 'budget' &&
          (action.field === 'state' || parseDecimal(action.after).lt(parseDecimal(other.after))));
      if (stricter) capActions.set(action.id, { action, cap });
    }
  }

  for (const campaign of entities.campaigns) {
    // Ohne Kennzahlen im Datenstand (fehlt in der neuesten Datei) gibt es nichts zu prüfen.
    if (campaign.metrics === null) continue;
    counts.campaigns! += 1;
    if (entities.manualPending.has(campaign.id)) {
      count('manualPending');
      continue;
    }
    if (capped.has(campaign.id)) {
      const hit = capActions.get(campaign.id);
      if (!hit) {
        count('budgetCap');
        continue;
      }
      const { action, cap } = hit;
      proposals.push({
        entityType: 'campaign',
        entityId: campaign.id,
        campaignId: campaign.id,
        adGroupId: null,
        source: 'budget_cap',
        ruleId: null,
        ...(action.field === 'state'
          ? { field: 'state', before: ACTIVE, after: 'PAUSED', limitedBy: [] }
          : {
              field: 'budget',
              before: action.before,
              after: action.after,
              limitedBy: action.limitedBy,
            }),
        detail: {
          ...campaign.metrics,
          period: plan.state.period,
          capId: cap.id,
          capAmount: cap.amount,
          capCurrencyCode: profile.currencyCode,
          month: cap.month,
          actual: cap.pacing.actual.value,
          actualLow: cap.pacing.actual.low,
          forecast: cap.pacing.forecast.value,
          dataThrough: cap.pacing.dataThrough,
          ...(action.field === 'budget' && { desired: action.desired }),
        },
      });
      continue;
    }
    // Kampagnen tragen Produkte mehrerer Gruppen: Es gilt das Ziel von Profil bzw. Client.
    const goal = goalAcos([]);
    const decision = decideCampaign({
      state: state(campaign.state),
      budget: budgetOf(campaign),
      metrics: campaign.metrics,
      goalAcos: goal,
      maxBudgetDecreasePercent: plan.guardrails.maxBudgetDecreasePercent,
      limit: limit(campaign.adProduct, 'budget', campaign.costType),
      rules: plan.rules,
      clientId: profile.clientId,
      eurRate,
    });
    take(
      decision,
      { entityType: 'campaign', entityId: campaign.id, campaignId: campaign.id, adGroupId: null },
      { ...campaign.metrics, goalAcos: goal },
    );
  }
  return { proposals, counts };
}

export interface AutomationRunDeps {
  db: Db;
  now: () => Date;
}

/**
 * Ein Lauf für ein Profil. `null`, wenn keiner fällig ist (Modus „aus“, keine Kennzahlen, kein Kurs, oder seit dem
 * letzten Lauf nichts Neues): dann entsteht auch kein `job_runs`-Eintrag.
 */
export async function runAutomation(
  runJob: RunJob,
  deps: AutomationRunDeps,
  job: AutomationRunJobData,
): Promise<JobRunResult | null> {
  const scope = { organizationId: job.organizationId, scope: job.profileId };
  let plan: Awaited<ReturnType<typeof planAutomationRun>>;
  try {
    plan = await planAutomationRun(deps.db, job, deps.now());
  } catch (error) {
    // Auch ein Fehler vor dem Lauf gehört in `job_runs`, sonst bliebe er unsichtbar.
    return runJob('automation-run', scope, () => Promise.reject(error));
  }
  if (plan.skip !== null) return null;
  return runJob('automation-run', scope, async ({ runId }) => {
    const entities = await loadAutomationRunEntities(deps.db, job, plan, deps.now());
    const { proposals, counts } = computeAutomationProposals(plan, entities);
    const saved = await saveAutomationRun(deps.db, {
      ...job,
      plan,
      jobRunId: runId,
      counts,
      proposals,
    });
    return {
      counters: {
        targets: counts.targets!,
        campaigns: counts.campaigns!,
        proposals: saved.proposals,
        staged: saved.staged,
      },
    };
  });
}

/** Täglicher Auslöser: plant für jedes Profil mit Kennzahlen einen Lauf ein (der prüft selbst, ob er fällig ist). */
export async function dispatchAutomationRuns(deps: {
  db: Db;
  enqueue(job: AutomationRunJobData): Promise<boolean>;
}): Promise<JobOutcome> {
  const profiles = await listAutomationRunProfiles(deps.db);
  let queued = 0;
  for (const profile of profiles) {
    if (await deps.enqueue(profile)) queued += 1;
  }
  return { counters: { profiles: profiles.length, queued } };
}
