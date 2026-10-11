import {
  computePacing,
  monthInTimeZone,
  type Pacing,
  type PacingCampaign,
} from '@profitbash/engine';
import {
  compareDecimal,
  MAX_BUDGET_CAPS_PER_PROFILE,
  type BudgetCapInput as CapValues,
  type BudgetCapScopeType,
} from '@profitbash/shared';
import { and, asc, count, eq, gte, inArray, isNull, max, sql, sum } from 'drizzle-orm';
import { canSeeProfile, listVisibleClientsAndProfiles, visibleProfilesScope } from './access';
import { recordAuditEvent, type DbOrTx } from './audit';
import type { Db } from './client';
import { findProfileMetricsState, listLatestEntityPeriodMetrics } from './entity-period-metrics';
import {
  amazonAdsCampaignDailyMetrics,
  amazonAdsCampaigns,
  amazonAdsPortfolios,
  budgetCaps,
  tagAssignments,
  tags,
} from './schema';

/**
 * Budget-Caps und Pacing (`docs/tasks/phase-5.md` 5.9a, F5). Caps hängen am Profil: sehen, anlegen, ändern und
 * löschen nur an sichtbaren Profilen (`visibleProfilesScope()`, ADR 002). Das Recht (`view` bzw. `write` im Feature
 * `budgets`) prüft die API, die Eingaben `budgetCapInputSchema`. Das Pacing rechnet `computePacing` aus dem
 * Datenstand je Kampagne (`listLatestEntityPeriodMetrics`), im laufenden Monat der Zeitzone des Profils.
 */

export type BudgetCapErrorCode = 'NOT_FOUND' | 'INVALID_SCOPE' | 'LIMIT_REACHED';

export class BudgetCapError extends Error {
  constructor(
    public readonly code: BudgetCapErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BudgetCapError';
  }
}

const notFound = () => new BudgetCapError('NOT_FOUND', 'Cap oder Profil nicht gefunden.');

export interface BudgetCapAccessInput {
  userId: string;
  orgId: string;
}

/** Geprüfte Eingabe (`budgetCapInputSchema`), mit `id` eine Änderung. */
export type BudgetCapInput = CapValues & { id?: string };

const MAX_CAP_CAMPAIGNS = 50;

type CapRow = typeof budgetCaps.$inferSelect;

export interface BudgetCapRecord {
  id: string;
  profileId: string;
  scope: { type: BudgetCapScopeType; ids: string[] };
  scopeLabels: string[];
  amount: string;
  monthAmounts: Record<string, string>;
  effectiveAmount: string;
  warnPercents: number[];
  pacing: Pacing;
  campaignCount: number;
  campaigns: {
    id: string;
    name: string | null;
    state: string | null;
    dailyBudget: string | null;
    actual: string;
    exact: boolean;
  }[];
  updatedAt: Date;
}

export interface BudgetsOverviewRecord {
  profiles: {
    id: string;
    accountName: string;
    countryCode: string;
    currencyCode: string;
    month: string;
    /** Zeitraum der letzten Datei mit Kennzahlen, sonst die Tageswerte des Monats. */
    dataState: { periodStart: string; periodEnd: string } | null;
    portfolios: { id: string; name: string }[];
    caps: BudgetCapRecord[];
  }[];
  tags: { id: string; name: string }[];
}

/** Was das Audit-Event von einem Cap festhält. */
const snapshot = (row: CapRow) => ({
  scope: { type: row.scopeType, ids: row.scopeIds },
  amount: row.amount,
  monthAmounts: row.monthAmounts,
  warnPercents: row.warnPercents,
});

interface DailyMonth {
  /** Letzter Tag des Monats mit Tageswerten. */
  lastDay: string | null;
  /** Ausgaben im Monat je Kampagne (interne ID). */
  costs: ReadonlyMap<string, string>;
}

/** Tageswerte eines Profils im Monat (Profile mit API-Reports); Datei-Profile haben keine. */
async function loadDailyMonth(db: DbOrTx, profileId: string, month: string): Promise<DailyMonth> {
  const d = amazonAdsCampaignDailyMetrics;
  const monthStart = `${month}-01`;
  const rows = await db
    .select({ campaignId: d.campaignId, cost: sum(d.cost), lastDay: max(d.date) })
    .from(d)
    .where(
      and(
        eq(d.profileId, profileId),
        gte(d.date, monthStart),
        sql`${d.date} < ${monthStart}::date + interval '1 month'`,
      ),
    )
    .groupBy(d.campaignId);
  return {
    lastDay: rows.reduce<string | null>(
      (last, row) => (row.lastDay && (last === null || row.lastDay > last) ? row.lastDay : last),
      null,
    ),
    costs: new Map(rows.map((row) => [row.campaignId, row.cost ?? '0'])),
  };
}

/**
 * Caps eines Profils mit Pacing im Monat `month`. Tageswerte des Monats zählen exakt und gehen vor. Jede Kampagne zählt mit dem Zeitraum ihres eigenen Datenstands;
 * Kampagnen ohne Kennzahlen stehen im Umfang, tragen aber nichts bei.
 */
async function withPacing(
  db: DbOrTx,
  profile: { id: string; organizationId: string },
  month: string,
  rows: readonly CapRow[],
  labels: ReadonlyMap<string, string>,
  daily: DailyMonth,
): Promise<BudgetCapRecord[]> {
  if (rows.length === 0) return [];
  const c = amazonAdsCampaigns;
  const campaigns = await db
    .select({
      id: c.id,
      amazonCampaignId: c.amazonCampaignId,
      name: c.name,
      state: c.state,
      budgetAmount: c.budgetAmount,
      budgetType: c.budgetType,
      portfolioId: c.portfolioId,
      removedAt: c.removedAt,
    })
    .from(c)
    .where(eq(c.profileId, profile.id));
  const metrics = new Map<string, { cost: string; periodStart: string; periodEnd: string }>();
  for (const row of await listLatestEntityPeriodMetrics(db, {
    organizationId: profile.organizationId,
    profileId: profile.id,
    level: 'campaign',
  })) {
    // shortcut: Kampagnen über die Amazon-ID zugeordnet, ohne Ad-Typ (wie der Lauf, 5.7).
    if (!metrics.has(row.amazonCampaignId)) metrics.set(row.amazonCampaignId, row);
  }
  const tagIds = rows.flatMap((row) => (row.scopeType === 'tags' ? row.scopeIds : []));
  const tagged =
    tagIds.length === 0
      ? []
      : await db
          .select({ tagId: tagAssignments.tagId, campaignId: tagAssignments.entityId })
          .from(tagAssignments)
          .where(
            and(
              eq(tagAssignments.profileId, profile.id),
              eq(tagAssignments.entityType, 'campaign'),
              inArray(tagAssignments.tagId, tagIds),
            ),
          );

  const entries = campaigns.map((campaign) => {
    const dailyCost = daily.lastDay === null ? undefined : daily.costs.get(campaign.id);
    const sums =
      dailyCost === undefined
        ? metrics.get(campaign.amazonCampaignId)
        : { cost: dailyCost, periodStart: `${month}-01`, periodEnd: daily.lastDay! };
    const dailyBudget = campaign.budgetType === 'DAILY' ? campaign.budgetAmount : null;
    const input: PacingCampaign | null = sums
      ? {
          cost: sums.cost,
          periodStart: sums.periodStart,
          periodEnd: sums.periodEnd,
          active: campaign.state === 'ENABLED' && campaign.removedAt === null,
          dailyBudget,
        }
      : null;
    const own = computePacing({
      month,
      cap: '1',
      warnPercents: [],
      campaigns: input ? [input] : [],
    });
    return { campaign, dailyBudget, input, actual: own.actual.value, exact: own.exact };
  });

  return rows.map((row) => {
    const ids = new Set(row.scopeIds);
    const taggedIds = new Set(tagged.filter((t) => ids.has(t.tagId)).map((t) => t.campaignId));
    const inScope = entries.filter(({ campaign }) =>
      row.scopeType === 'profile'
        ? true
        : row.scopeType === 'portfolios'
          ? campaign.portfolioId !== null && ids.has(campaign.portfolioId)
          : taggedIds.has(campaign.id),
    );
    const effectiveAmount = row.monthAmounts[month] ?? row.amount;
    return {
      id: row.id,
      profileId: row.profileId,
      scope: { type: row.scopeType as BudgetCapScopeType, ids: row.scopeIds },
      scopeLabels: row.scopeIds.flatMap((id) => labels.get(id) ?? []),
      amount: row.amount,
      monthAmounts: row.monthAmounts,
      effectiveAmount,
      warnPercents: row.warnPercents,
      pacing: computePacing({
        month,
        cap: effectiveAmount,
        warnPercents: row.warnPercents,
        campaigns: inScope.flatMap((entry) => entry.input ?? []),
      }),
      campaignCount: inScope.length,
      campaigns: inScope
        .toSorted((a, b) => compareDecimal(b.actual, a.actual))
        .slice(0, MAX_CAP_CAMPAIGNS)
        .map(({ campaign, dailyBudget, actual, exact }) => ({
          id: campaign.id,
          name: campaign.name,
          state: campaign.state,
          dailyBudget,
          actual,
          exact,
        })),
      updatedAt: row.updatedAt,
    };
  });
}

/**
 * Sichtbare Profile mit ihren Caps und dem Pacing im laufenden Monat (Zeitzone des Profils), dazu Portfolios und
 * Tags für den Umfang. `null` für Nicht-Mitglieder.
 */
export async function getBudgetsOverview(
  db: Db,
  input: BudgetCapAccessInput & { now: Date },
): Promise<BudgetsOverviewRecord | null> {
  if ((await visibleProfilesScope(db, input)) === null) return null;
  const { profiles } = await listVisibleClientsAndProfiles(db, input);
  const profileIds = profiles.map((p) => p.id);
  const orgTags = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(eq(tags.organizationId, input.orgId))
    .orderBy(asc(sql`lower(${tags.name})`), asc(tags.id));
  if (profileIds.length === 0) return { profiles: [], tags: orgTags };

  const pf = amazonAdsPortfolios;
  const portfolios = await db
    .select({
      id: pf.id,
      profileId: pf.profileId,
      name: pf.name,
      amazonPortfolioId: pf.amazonPortfolioId,
    })
    .from(pf)
    .where(and(inArray(pf.profileId, profileIds), isNull(pf.removedAt)))
    .orderBy(asc(sql`lower(${pf.name})`), asc(pf.amazonPortfolioId));
  const caps = await db
    .select()
    .from(budgetCaps)
    .where(inArray(budgetCaps.profileId, profileIds))
    .orderBy(asc(budgetCaps.createdAt), asc(budgetCaps.id));
  const labels = new Map([
    ...orgTags.map((tag) => [tag.id, tag.name] as const),
    ...portfolios.map((p) => [p.id, p.name ?? p.amazonPortfolioId] as const),
  ]);

  // shortcut: bis zu fünf Abfragen je Profil; bei sehr vielen Profilen je Tabelle eine Abfrage über alle.
  const result: BudgetsOverviewRecord['profiles'] = [];
  for (const profile of profiles) {
    const scope = { organizationId: input.orgId, profileId: profile.id };
    const state = await findProfileMetricsState(db, scope);
    const month = monthInTimeZone(input.now, profile.timezone);
    const daily = await loadDailyMonth(db, profile.id, month);
    result.push({
      id: profile.id,
      accountName: profile.accountName,
      countryCode: profile.countryCode,
      currencyCode: profile.currencyCode,
      month,
      dataState: state
        ? { periodStart: state.period.startDate, periodEnd: state.period.endDate }
        : daily.lastDay === null
          ? null
          : { periodStart: `${month}-01`, periodEnd: daily.lastDay },
      portfolios: portfolios
        .filter((p) => p.profileId === profile.id)
        .map((p) => ({ id: p.id, name: p.name ?? p.amazonPortfolioId })),
      caps: await withPacing(
        db,
        { id: profile.id, organizationId: input.orgId },
        month,
        caps.filter((cap) => cap.profileId === profile.id),
        labels,
        daily,
      ),
    });
  }
  return { profiles: result, tags: orgTags };
}

/**
 * Legt einen Cap an oder ändert ihn (`id`; das Profil eines Caps bleibt). Portfolios müssen zum Profil gehören,
 * Tags zur Organisation (`INVALID_SCOPE`). Audit `budget_cap.create` bzw. `budget_cap.update` (nur bei einer
 * Änderung). `null` für Nicht-Mitglieder, `NOT_FOUND` für unsichtbare Profile und fremde Caps.
 */
export async function saveBudgetCap(
  db: Db,
  input: BudgetCapAccessInput & BudgetCapInput,
): Promise<{ id: string } | null> {
  if ((await visibleProfilesScope(db, input)) === null) return null;
  if (!(await canSeeProfile(db, input))) throw notFound();
  return db.transaction(async (tx) => {
    const { ids } = input.scope;
    if (input.scope.type !== 'profile') {
      const [found] =
        input.scope.type === 'portfolios'
          ? await tx
              .select({ n: count() })
              .from(amazonAdsPortfolios)
              .where(
                and(
                  eq(amazonAdsPortfolios.profileId, input.profileId),
                  inArray(amazonAdsPortfolios.id, ids),
                ),
              )
          : await tx
              .select({ n: count() })
              .from(tags)
              .where(and(eq(tags.organizationId, input.orgId), inArray(tags.id, ids)));
      if (found!.n !== ids.length) {
        throw new BudgetCapError('INVALID_SCOPE', 'Portfolio oder Tag nicht gefunden.');
      }
    }
    const values = {
      scopeType: input.scope.type,
      scopeIds: ids,
      amount: input.amount,
      monthAmounts: input.monthAmounts,
      warnPercents: input.warnPercents.toSorted((a, b) => a - b),
      updatedBy: input.userId,
    };
    const ofProfile = and(
      eq(budgetCaps.profileId, input.profileId),
      eq(budgetCaps.organizationId, input.orgId),
    );
    let before: CapRow | undefined;
    let after: CapRow | undefined;
    if (input.id === undefined) {
      const [existing] = await tx.select({ n: count() }).from(budgetCaps).where(ofProfile);
      if (existing!.n >= MAX_BUDGET_CAPS_PER_PROFILE) {
        throw new BudgetCapError('LIMIT_REACHED', 'Höchstens 20 Caps je Profil.');
      }
      [after] = await tx
        .insert(budgetCaps)
        .values({
          ...values,
          organizationId: input.orgId,
          profileId: input.profileId,
          createdBy: input.userId,
        })
        .returning();
    } else {
      const own = and(eq(budgetCaps.id, input.id), ofProfile);
      [before] = await tx.select().from(budgetCaps).where(own);
      if (!before) throw notFound();
      [after] = await tx.update(budgetCaps).set(values).where(own).returning();
    }
    const change = { before: before ? snapshot(before) : null, after: snapshot(after!) };
    if (JSON.stringify(change.before) !== JSON.stringify(change.after)) {
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: before ? 'budget_cap.update' : 'budget_cap.create',
        target: { type: 'budget_cap', id: after!.id, profileId: input.profileId, ...change },
      });
    }
    return { id: after!.id };
  });
}

/** Löscht einen Cap (Audit `budget_cap.delete`). `null` für Nicht-Mitglieder, `NOT_FOUND` für fremde und unsichtbare. */
export async function deleteBudgetCap(
  db: Db,
  input: BudgetCapAccessInput & { id: string },
): Promise<true | null> {
  if ((await visibleProfilesScope(db, input)) === null) return null;
  const [row] = await db
    .select()
    .from(budgetCaps)
    .where(and(eq(budgetCaps.id, input.id), eq(budgetCaps.organizationId, input.orgId)));
  if (!row || !(await canSeeProfile(db, { ...input, profileId: row.profileId }))) throw notFound();
  return db.transaction(async (tx) => {
    await tx.delete(budgetCaps).where(eq(budgetCaps.id, row.id));
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'budget_cap.delete',
      target: {
        type: 'budget_cap',
        id: row.id,
        profileId: row.profileId,
        before: snapshot(row),
      },
    });
    return true as const;
  });
}
