import { createHash } from 'node:crypto';
import { createProtectedTermMatcher, type GoalSetting } from '@profitbash/engine';
import {
  guardrailOverridesSchema,
  type AutomationMode,
  type AutomationRule,
  type Guardrails,
} from '@profitbash/shared';
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { visibleProfilesScope } from './access';
import { chunks, valueColumns } from './ad-change-entities';
import { recordAuditEvent } from './audit';
import { loadGuardrailDefaults } from './automation';
import { loadAutomationRules } from './automation-rules';
import { loadProfileCapPacing, type ProfileCapPacing } from './budget-caps';
import type { Db } from './client';
import {
  findProfileMetricsState,
  listLatestEntityPeriodMetrics,
  type ProfileMetricsState,
} from './entity-period-metrics';
import { fxRatesOnOrBefore, latestFxRateDate } from './fx-rates';
import { createNotification } from './notifications';
import {
  adChanges,
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsEntityPeriodMetrics,
  amazonAdsProductAds,
  amazonAdsProfiles,
  amazonAdsTargets,
  automationProposals,
  automationRuns,
  clientAutomationSettings,
  clients,
  goals,
  members,
  productGroupItems,
  productGroups,
} from './schema';

/**
 * Läufe der Automatik (`docs/tasks/phase-5.md` 5.7), Systemzugriff für den Job `automation-run` (ohne Nutzer, an
 * Organisation und Profil gebunden): Plan (Modus, Leitplanken, Regeln, Ziele, Datenstand), Entities mit Kennzahlen
 * und das Speichern von Lauf und Vorschlägen. Gerechnet wird im Worker (`@profitbash/engine`, Grenzen von Amazon).
 */

const p = automationProposals;

export interface AutomationRunScope {
  organizationId: string;
  profileId: string;
}

export type AutomationRunSkip = 'profileGone' | 'off' | 'noMetrics' | 'noFxRate' | 'unchanged';

export interface AutomationRunPlan {
  profile: { id: string; clientId: string | null; currencyCode: string; countryCode: string };
  /** Wirksamer Modus: `cart` nur mit einem zuständigen Nutzer, der Schreibrecht hat. */
  mode: Exclude<AutomationMode, 'off'>;
  responsibleUserId: string | null;
  /** Der Client steht auf `cart`, der zuständige Nutzer fehlt aber oder darf nicht mehr schreiben. */
  responsibleMissing: boolean;
  /** `{ ...Organisation, ...Client }`, Beträge in EUR. */
  guardrails: Guardrails;
  /** Ein Euro in der Währung des Profils (letzter EZB-Kurs). */
  eurRate: string;
  rules: AutomationRule[];
  /** Ziele von Client, Profil und den Produktgruppen des Profils (für `effectiveGoal`). */
  goals: GoalSetting[];
  protectedTerms: string[];
  state: ProfileMetricsState;
  /** Budget-Caps des Profils mit Pacing im laufenden Monat (5.9b). */
  caps: ProfileCapPacing[];
  fingerprint: string;
  /** `olderPeriod`: Der Zeitraum endet vor dem des vorigen Laufs (ältere Datei nachträglich hochgeladen). */
  warnings: string[];
}

const WRITE_ROLES = ['admin', 'editor'];

/**
 * Plan eines Laufs oder der Grund, warum es keinen gibt. `unchanged`: Seit dem letzten Lauf des Profils sind weder
 * neue Kennzahlen gekommen noch Regeln, Ziele oder Einstellungen geändert worden (Vergleich über `fingerprint`).
 */
export async function planAutomationRun(
  db: Db,
  scope: AutomationRunScope,
  now = new Date(),
): Promise<{ skip: AutomationRunSkip } | ({ skip: null } & AutomationRunPlan)> {
  const [profile] = await db
    .select({
      id: amazonAdsProfiles.id,
      clientId: amazonAdsProfiles.clientId,
      currencyCode: amazonAdsProfiles.currencyCode,
      countryCode: amazonAdsProfiles.countryCode,
    })
    .from(amazonAdsProfiles)
    .where(
      and(
        eq(amazonAdsProfiles.id, scope.profileId),
        eq(amazonAdsProfiles.organizationId, scope.organizationId),
        isNull(amazonAdsProfiles.removedAt),
        eq(amazonAdsProfiles.isHidden, false),
      ),
    );
  if (!profile) return { skip: 'profileGone' };

  // Profile ohne Client: Leitplanken der Organisation, Schattenmodus.
  const [settings] = profile.clientId
    ? await db
        .select({
          mode: clientAutomationSettings.mode,
          responsibleUserId: clientAutomationSettings.responsibleUserId,
          overrides: clientAutomationSettings.overrides,
          protectedTerms: clients.protectedTerms,
        })
        .from(clients)
        .leftJoin(clientAutomationSettings, eq(clientAutomationSettings.clientId, clients.id))
        .where(eq(clients.id, profile.clientId))
    : [];
  const wanted = (settings?.mode ?? 'shadow') as AutomationMode;
  if (wanted === 'off') return { skip: 'off' };
  const state = await findProfileMetricsState(db, scope);
  if (state === null) return { skip: 'noMetrics' };
  const rateDate = await latestFxRateDate(db);
  // Ohne Kurstabelle kennt `fxRatesOnOrBefore` nur EUR (Kurs 1); der Tag ist dann gleichgültig.
  const eurRate = (
    await fxRatesOnOrBefore(db, rateDate ?? '1970-01-01', [profile.currencyCode])
  ).get(profile.currencyCode)?.rate;
  if (eurRate === undefined) return { skip: 'noFxRate' };

  let responsibleUserId: string | null = null;
  if (wanted === 'cart' && settings?.responsibleUserId) {
    const [member] = await db
      .select({ role: members.role })
      .from(members)
      .where(
        and(
          eq(members.userId, settings.responsibleUserId),
          eq(members.organizationId, scope.organizationId),
        ),
      );
    if (member && WRITE_ROLES.includes(member.role)) responsibleUserId = settings.responsibleUserId;
  }
  const mode = responsibleUserId === null ? 'shadow' : 'cart';

  const overrides = guardrailOverridesSchema.safeParse(settings?.overrides);
  const guardrails: Guardrails = {
    ...(await loadGuardrailDefaults(db, scope.organizationId)),
    ...(overrides.success ? overrides.data : {}),
  };
  const { rules } = await loadAutomationRules(db, scope.organizationId);
  const goalRows = await db
    .select({
      clientId: goals.clientId,
      profileId: goals.profileId,
      productGroupId: goals.productGroupId,
      metric: goals.metric,
      value: goals.value,
    })
    .from(goals)
    .leftJoin(productGroups, eq(productGroups.id, goals.productGroupId))
    .where(
      and(
        eq(goals.organizationId, scope.organizationId),
        or(
          eq(goals.profileId, profile.id),
          eq(productGroups.profileId, profile.id),
          ...(profile.clientId ? [eq(goals.clientId, profile.clientId)] : []),
        ),
      ),
    );
  const goalSettings = goalRows
    .map((row): GoalSetting => {
      const metric = row.metric as GoalSetting['metric'];
      if (row.clientId) return { scope: 'client', scopeId: row.clientId, metric, value: row.value };
      if (row.profileId)
        return { scope: 'profile', scopeId: row.profileId, metric, value: row.value };
      return { scope: 'productGroup', scopeId: row.productGroupId!, metric, value: row.value };
    })
    .sort((a, b) => a.scopeId.localeCompare(b.scopeId));

  const caps = await loadProfileCapPacing(db, scope, now);
  // Der Tageskurs gehört nicht dazu: Er ändert sich täglich und löste sonst jeden Tag einen Lauf aus.
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        importedAt: state.importedAt.toISOString(),
        period: state.period,
        rules,
        goals: goalSettings,
        guardrails,
        mode,
        responsibleUserId,
        // Betrag, Schwellen, Monat und Umfang; ohne Caps bleibt der Hash der alte.
        ...(caps.length > 0 && {
          caps: caps.map((cap) => ({
            id: cap.id,
            month: cap.month,
            amount: cap.amount,
            warnPercents: cap.warnPercents,
            campaigns: cap.campaigns.map((campaign) => campaign.id).sort(),
          })),
        }),
      }),
    )
    .digest('hex');
  const [previous] = await db
    .select({ fingerprint: automationRuns.fingerprint, periodEnd: automationRuns.periodEnd })
    .from(automationRuns)
    .where(eq(automationRuns.profileId, profile.id))
    .orderBy(desc(automationRuns.createdAt))
    .limit(1);
  if (previous?.fingerprint === fingerprint) return { skip: 'unchanged' };

  return {
    skip: null,
    profile,
    mode,
    responsibleUserId,
    responsibleMissing: wanted === 'cart' && mode === 'shadow',
    guardrails,
    eurRate,
    rules,
    goals: goalSettings,
    protectedTerms: settings?.protectedTerms ?? [],
    state,
    caps,
    fingerprint,
    warnings: previous && state.period.endDate < previous.periodEnd ? ['olderPeriod'] : [],
  };
}

/** Summen einer Entity im Datenstand des Profils. */
export interface AutomationPeriodSums {
  impressions: number;
  clicks: number;
  orders: number;
  spend: string;
  sales: string;
}

export interface AutomationRunEntities {
  campaigns: {
    id: string;
    adProduct: string;
    state: string | null;
    costType: string | null;
    /** Tagesbudget; `null` bei anderen Budgetarten. */
    budget: string | null;
    metrics: AutomationPeriodSums | null;
  }[];
  adGroups: {
    id: string;
    state: string | null;
    defaultBid: string | null;
    metrics: AutomationPeriodSums | null;
    /** Produktgruppen des Profils, die ein beworbenes Produkt der Ad Group enthalten. */
    productGroupIds: string[];
  }[];
  /** Nur Targets mit Kennzahlen im Datenstand des Profils. */
  targets: {
    id: string;
    campaignId: string;
    adGroupId: string | null;
    adProduct: string;
    state: string | null;
    bid: string | null;
    protectedTerm: boolean;
    metrics: AutomationPeriodSums;
  }[];
  /** Entities mit einer von Hand gelegten offenen Änderung: Für sie gibt es keinen Vorschlag. */
  manualPending: Set<string>;
  /**
   * Je `entityId:field` (`bid`, `budget`): Ausgangswert aus übermittelten bzw. in den letzten 7 Tagen angewendeten
   * Änderungen und der Wert zu Beginn der 7 Tage. Fehlt der Eintrag, gilt der Wert der Entity.
   */
  bases: Map<string, { base: string; windowStart: string }>;
}

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Herkunft der Warenkorb-Zeilen, die der Lauf selbst legt und ersetzt. */
const OWN_ORIGINS = ['automation', 'budget_cap'];
const originOf = (source: string) => (source === 'budget_cap' ? 'budget_cap' : 'automation');

export async function loadAutomationRunEntities(
  db: Db,
  scope: AutomationRunScope,
  plan: Pick<AutomationRunPlan, 'state' | 'protectedTerms'>,
  now: Date,
): Promise<AutomationRunEntities> {
  // Datenstand je Entity; älter als die neueste Datei des Profils zählt nicht (Entity fehlt dort: archiviert,
  // herausgefiltert), ein Teil-Export mit demselben Zeitraumende schon.
  const sums = async (level: 'campaign' | 'adGroup' | 'target') => {
    const byAmazonId = new Map<string, AutomationPeriodSums>();
    for (const row of await listLatestEntityPeriodMetrics(db, { ...scope, level })) {
      if (row.periodEnd < plan.state.period.endDate) continue;
      // Bei SD der Umsatz aus Klicks (`sales`), nicht „Views & Clicks“.
      byAmazonId.set(row.amazonEntityId, {
        impressions: Number(row.impressions),
        clicks: Number(row.clicks),
        orders: Number(row.purchases),
        spend: row.cost,
        sales: row.sales,
      });
    }
    return byAmazonId;
  };
  const [campaignSums, adGroupSums, targetSums] = [
    await sums('campaign'),
    await sums('adGroup'),
    await sums('target'),
  ];
  const campaigns = await db
    .select({
      id: amazonAdsCampaigns.id,
      amazonId: amazonAdsCampaigns.amazonCampaignId,
      adProduct: amazonAdsCampaigns.adProduct,
      state: amazonAdsCampaigns.state,
      extra: amazonAdsCampaigns.extra,
      budgetAmount: amazonAdsCampaigns.budgetAmount,
      budgetType: amazonAdsCampaigns.budgetType,
    })
    .from(amazonAdsCampaigns)
    .where(
      and(eq(amazonAdsCampaigns.profileId, scope.profileId), isNull(amazonAdsCampaigns.removedAt)),
    );
  const adGroups = await db
    .select({
      id: amazonAdsAdGroups.id,
      amazonId: amazonAdsAdGroups.amazonAdGroupId,
      state: amazonAdsAdGroups.state,
      defaultBid: amazonAdsAdGroups.defaultBid,
    })
    .from(amazonAdsAdGroups)
    .where(
      and(eq(amazonAdsAdGroups.profileId, scope.profileId), isNull(amazonAdsAdGroups.removedAt)),
    );
  const targets = await db
    .select({
      id: amazonAdsTargets.id,
      amazonId: amazonAdsTargets.amazonTargetId,
      campaignId: amazonAdsTargets.campaignId,
      adGroupId: amazonAdsTargets.adGroupId,
      adProduct: amazonAdsTargets.adProduct,
      state: amazonAdsTargets.state,
      bid: amazonAdsTargets.bid,
      keywordText: amazonAdsTargets.keywordText,
    })
    .from(amazonAdsTargets)
    .where(
      and(eq(amazonAdsTargets.profileId, scope.profileId), isNull(amazonAdsTargets.removedAt)),
    );

  const groupRows = await db
    .selectDistinct({
      adGroupId: amazonAdsProductAds.adGroupId,
      productGroupId: productGroups.id,
    })
    .from(amazonAdsProductAds)
    .innerJoin(productGroupItems, eq(productGroupItems.asin, amazonAdsProductAds.asin))
    .innerJoin(
      productGroups,
      and(
        eq(productGroups.id, productGroupItems.productGroupId),
        eq(productGroups.profileId, scope.profileId),
      ),
    )
    .where(
      and(
        eq(amazonAdsProductAds.profileId, scope.profileId),
        isNull(amazonAdsProductAds.removedAt),
      ),
    );
  const productGroupIds = new Map<string, string[]>();
  for (const row of groupRows) {
    productGroupIds.set(row.adGroupId, [
      ...(productGroupIds.get(row.adGroupId) ?? []),
      row.productGroupId,
    ]);
  }

  // Änderungen über ProfitBash: offene von Hand sperren die Entity; übermittelte und frisch angewendete liefern
  // das Ausgangsgebot, die älteste im Fenster den Wert zu Beginn der 7 Tage (`phase-5.md` „Basis für Leitplanken“).
  const windowStart = new Date(now.getTime() - WINDOW_MS);
  const changes = await db
    .select({
      entityId: adChanges.entityId,
      field: adChanges.field,
      status: adChanges.status,
      origin: adChanges.origin,
      oldAmount: adChanges.oldAmount,
      newAmount: adChanges.newAmount,
      createdAt: adChanges.createdAt,
    })
    .from(adChanges)
    .where(
      and(
        eq(adChanges.profileId, scope.profileId),
        eq(adChanges.operation, 'update'),
        inArray(adChanges.entityType, ['target', 'campaign']),
        or(
          inArray(adChanges.status, ['pending', 'submitted']),
          and(eq(adChanges.status, 'applied'), gte(adChanges.createdAt, windowStart)),
        ),
      ),
    )
    .orderBy(adChanges.createdAt);
  const manualPending = new Set<string>();
  const bases: AutomationRunEntities['bases'] = new Map();
  const firstInWindow = new Map<string, string>();
  for (const change of changes) {
    if (change.status === 'pending') {
      // Die eigenen offenen Zeilen ersetzt der Lauf.
      if (!OWN_ORIGINS.includes(change.origin)) manualPending.add(change.entityId!);
      continue;
    }
    if (change.newAmount === null || (change.field !== 'bid' && change.field !== 'budget')) {
      continue;
    }
    const key = `${change.entityId}:${change.field}`;
    // Aufsteigend sortiert: Die letzte Änderung ist die neueste, die erste im Fenster die älteste.
    const first = firstInWindow.get(key);
    if (first === undefined && change.createdAt >= windowStart && change.oldAmount !== null) {
      firstInWindow.set(key, change.oldAmount);
    }
    bases.set(key, { base: change.newAmount, windowStart: change.newAmount });
  }
  for (const [key, entry] of bases) entry.windowStart = firstInWindow.get(key) ?? entry.base;

  const isProtected = createProtectedTermMatcher(plan.protectedTerms);
  const costType = (extra: unknown) => {
    const value = (extra as { costType?: unknown } | null)?.costType;
    return typeof value === 'string' ? value : null;
  };
  return {
    campaigns: campaigns.map((c) => ({
      id: c.id,
      adProduct: c.adProduct,
      state: c.state,
      costType: costType(c.extra),
      budget: c.budgetType === 'DAILY' ? c.budgetAmount : null,
      metrics: campaignSums.get(c.amazonId) ?? null,
    })),
    adGroups: adGroups.map((g) => ({
      id: g.id,
      state: g.state,
      defaultBid: g.defaultBid,
      metrics: adGroupSums.get(g.amazonId) ?? null,
      productGroupIds: productGroupIds.get(g.id) ?? [],
    })),
    targets: targets.flatMap((t) => {
      const metrics = targetSums.get(t.amazonId);
      if (!metrics) return [];
      return [
        {
          id: t.id,
          campaignId: t.campaignId,
          adGroupId: t.adGroupId,
          adProduct: t.adProduct,
          state: t.state,
          bid: t.bid,
          protectedTerm: t.keywordText !== null && isProtected(t.keywordText),
          metrics,
        },
      ];
    }),
    manualPending,
    bases,
  };
}

export interface AutomationProposalInput {
  entityType: 'target' | 'campaign';
  entityId: string;
  campaignId: string;
  adGroupId: string | null;
  field: 'bid' | 'budget' | 'state';
  before: string;
  after: string;
  /** `budget_cap`: Vorschlag des Enforcers (5.9b). */
  source: 'rule' | 'optimizer' | 'budget_cap';
  ruleId: string | null;
  limitedBy: string[];
  /** Begründung fürs Protokoll (Kennzahlen, Ziel, gewünschter Wert). */
  detail: Record<string, unknown>;
}

export interface SaveAutomationRunInput extends AutomationRunScope {
  plan: AutomationRunPlan;
  jobRunId: string | null;
  /** Zähler des Laufs (geprüfte Entities, Gründe ohne Vorschlag). */
  counts: Record<string, number>;
  proposals: readonly AutomationProposalInput[];
}

export interface SaveAutomationRunResult {
  runId: string;
  proposals: number;
  /** Vorschläge, die als Änderung im Warenkorb des zuständigen Nutzers liegen (Modus `cart`). */
  staged: number;
  /** Ausgelassen, weil in diesem Datenstand schon verworfen. */
  dismissed: number;
}

const INSERT_CHUNK = 500;

/**
 * Speichert Lauf und Vorschläge in einer Transaktion und löst die offenen Vorschläge früherer Läufe ab. Im Modus
 * `cart` ersetzt der Lauf seine eigenen offenen Zeilen im Warenkorb (Herkunft `automation`), nie von Hand gelegte.
 * Was in diesem Datenstand verworfen wurde (auch im Warenkorb), kommt erst mit neuen Kennzahlen wieder. Dazu
 * Audit `automation_run.create` und die Benachrichtigungen (neue Vorschläge an den Zuständigen; fehlender
 * Zuständiger an die Admins).
 */
export async function saveAutomationRun(
  db: Db,
  input: SaveAutomationRunInput,
): Promise<SaveAutomationRunResult> {
  const { plan } = input;
  return db.transaction(async (tx) => {
    // Läufe eines Profils nacheinander (die Queue plant schon nur einen je Profil).
    await tx
      .select({ id: amazonAdsProfiles.id })
      .from(amazonAdsProfiles)
      .where(eq(amazonAdsProfiles.id, input.profileId))
      .for('update');

    // Aus dem Warenkorb geworfen (die Änderung ist gelöscht) heißt verworfen.
    await tx
      .update(p)
      .set({ status: 'dismissed' })
      .where(and(eq(p.profileId, input.profileId), eq(p.status, 'staged'), isNull(p.adChangeId)));
    const dismissedRows = await tx
      .select({ entityId: p.entityId, field: p.field })
      .from(p)
      .innerJoin(automationRuns, eq(automationRuns.id, p.runId))
      .where(
        and(
          eq(p.profileId, input.profileId),
          eq(p.status, 'dismissed'),
          eq(automationRuns.metricsImportedAt, plan.state.importedAt),
        ),
      );
    const dismissed = new Set(dismissedRows.map((row) => `${row.entityId}:${row.field}`));
    const proposals = input.proposals.filter((x) => !dismissed.has(`${x.entityId}:${x.field}`));

    // Eigene offene Zeilen ersetzen; der Fremdschlüssel leert `ad_change_id` der alten Vorschläge.
    await tx
      .delete(adChanges)
      .where(
        and(
          eq(adChanges.profileId, input.profileId),
          eq(adChanges.status, 'pending'),
          inArray(adChanges.origin, OWN_ORIGINS),
        ),
      );
    // Übernommene Vorschläge, deren Änderung schon übermittelt ist, bleiben `staged` (Verlauf).
    await tx
      .update(p)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(p.profileId, input.profileId),
          or(eq(p.status, 'open'), and(eq(p.status, 'staged'), isNull(p.adChangeId))),
        ),
      );

    const staged = new Map<string, string>();
    if (plan.mode === 'cart') {
      for (const part of chunks(proposals, INSERT_CHUNK)) {
        const inserted = await tx
          .insert(adChanges)
          .values(
            part.map((x) => ({
              organizationId: input.organizationId,
              profileId: input.profileId,
              origin: originOf(x.source),
              operation: 'update',
              entityType: x.entityType,
              entityId: x.entityId,
              campaignId: x.campaignId,
              adGroupId: x.adGroupId,
              field: x.field,
              ...valueColumns(x.field, x.before, x.after),
              currencyCode: x.field === 'state' ? null : plan.profile.currencyCode,
              createdBy: plan.responsibleUserId,
            })),
          )
          // Legt der Nutzer im selben Moment dieselbe Stelle von Hand, bleibt der Vorschlag im Protokoll.
          .onConflictDoNothing()
          .returning({ id: adChanges.id, entityId: adChanges.entityId, field: adChanges.field });
        for (const row of inserted) staged.set(`${row.entityId}:${row.field}`, row.id);
      }
    }

    const ruleNames = new Map(plan.rules.map((rule) => [rule.id, rule.name]));
    const counts = {
      ...input.counts,
      proposals: proposals.length,
      staged: staged.size,
      dismissed: input.proposals.length - proposals.length,
    };
    const [run] = await tx
      .insert(automationRuns)
      .values({
        organizationId: input.organizationId,
        profileId: input.profileId,
        jobRunId: input.jobRunId,
        mode: plan.mode,
        responsibleUserId: plan.responsibleUserId,
        periodStart: plan.state.period.startDate,
        periodEnd: plan.state.period.endDate,
        metricsImportedAt: plan.state.importedAt,
        fingerprint: plan.fingerprint,
        counts,
        warnings: [...plan.warnings, ...(plan.responsibleMissing ? ['responsibleMissing'] : [])],
      })
      .returning({ id: automationRuns.id });
    const runId = run!.id;
    for (const part of chunks(proposals, INSERT_CHUNK)) {
      await tx.insert(p).values(
        part.map((x) => {
          const adChangeId = staged.get(`${x.entityId}:${x.field}`) ?? null;
          return {
            organizationId: input.organizationId,
            profileId: input.profileId,
            runId,
            entityType: x.entityType,
            entityId: x.entityId,
            campaignId: x.campaignId,
            adGroupId: x.adGroupId,
            field: x.field,
            ...valueColumns(x.field, x.before, x.after),
            currencyCode: x.field === 'state' ? null : plan.profile.currencyCode,
            source: x.source,
            ruleId: x.ruleId,
            ruleName: x.ruleId ? (ruleNames.get(x.ruleId) ?? null) : null,
            limitedBy: x.limitedBy,
            detail: x.detail,
            status: adChangeId ? 'staged' : 'open',
            adChangeId,
          };
        }),
      );
    }

    await recordAuditEvent(tx, {
      organizationId: input.organizationId,
      actorUserId: null,
      action: 'automation_run.create',
      target: {
        type: 'automation_run',
        id: runId,
        profileId: input.profileId,
        mode: plan.mode,
        responsibleUserId: plan.responsibleUserId,
        proposals: proposals.length,
        staged: staged.size,
      },
    });
    if (staged.size > 0) {
      await createNotification(tx, {
        organizationId: input.organizationId,
        profileId: input.profileId,
        audience: 'recipient',
        recipientUserId: plan.responsibleUserId,
        kind: 'automation_proposals',
        severity: 'info',
        params: { count: staged.size },
        link: '/ads/changes',
        dedupeKey: `automation_proposals:${runId}`,
      });
    }
    // Caps (5.9b): je Cap, Monat und Schwelle eine Meldung an alle, die das Profil sehen.
    for (const cap of plan.caps) {
      const base = {
        organizationId: input.organizationId,
        profileId: input.profileId,
        audience: 'members' as const,
        link: '/ads/budgets',
      };
      const amounts = { amount: cap.amount, currencyCode: plan.profile.currencyCode };
      if (cap.pacing.warnLevel !== null) {
        await createNotification(tx, {
          ...base,
          kind: 'budget_cap_threshold',
          severity: cap.pacing.warnLevel >= 100 ? 'error' : 'warning',
          params: { ...amounts, percent: cap.pacing.warnLevel, actual: cap.pacing.actual.value },
          dedupeKey: `budget_cap_threshold:${cap.id}:${cap.month}:${cap.pacing.warnLevel}`,
        });
      }
      if (cap.pacing.forecastOver) {
        await createNotification(tx, {
          ...base,
          kind: 'budget_cap_forecast',
          severity: 'warning',
          params: { ...amounts, forecast: cap.pacing.forecast.value },
          dedupeKey: `budget_cap_forecast:${cap.id}:${cap.month}`,
        });
      }
    }
    if (plan.responsibleMissing) {
      await createNotification(tx, {
        organizationId: input.organizationId,
        profileId: input.profileId,
        audience: 'admins',
        kind: 'automation_responsible_missing',
        severity: 'warning',
        link: '/ads/automations',
        dedupeKey: `automation_responsible_missing:${runId}`,
      });
    }
    return {
      runId,
      proposals: proposals.length,
      staged: staged.size,
      dismissed: counts.dismissed,
    };
  });
}

/** Profile mit Kennzahlen aus einer Datei: Für sie plant der tägliche Auslöser einen Lauf ein. */
export async function listAutomationRunProfiles(db: Db): Promise<AutomationRunScope[]> {
  const m = amazonAdsEntityPeriodMetrics;
  return db
    .selectDistinct({ organizationId: m.organizationId, profileId: m.profileId })
    .from(m)
    .innerJoin(amazonAdsProfiles, eq(amazonAdsProfiles.id, m.profileId))
    .where(and(isNull(amazonAdsProfiles.removedAt), eq(amazonAdsProfiles.isHidden, false)))
    .orderBy(m.organizationId, m.profileId);
}

// ---------------------------------------------------------------------------
// Läufe und Vorschläge für Nutzer (5.8)
// ---------------------------------------------------------------------------

export interface AutomationRunAccess {
  userId: string;
  orgId: string;
}

export interface AutomationRunRecord {
  id: string;
  profileId: string;
  accountName: string;
  mode: string;
  periodStart: string;
  periodEnd: string;
  metricsImportedAt: Date;
  counts: Record<string, number>;
  warnings: string[];
  createdAt: Date;
}

export const AUTOMATION_RUN_LIST_LIMIT = 100;

/** Die letzten Läufe der sichtbaren Profile, neueste zuerst. `null` für Nicht-Mitglieder. */
export async function listAutomationRuns(
  db: Db,
  access: AutomationRunAccess,
): Promise<AutomationRunRecord[] | null> {
  const scope = await visibleProfilesScope(db, access);
  if (scope === null) return null;
  const r = automationRuns;
  return db
    .select({
      id: r.id,
      profileId: r.profileId,
      accountName: amazonAdsProfiles.accountName,
      mode: r.mode,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      metricsImportedAt: r.metricsImportedAt,
      counts: r.counts,
      warnings: r.warnings,
      createdAt: r.createdAt,
    })
    .from(r)
    .innerJoin(amazonAdsProfiles, eq(amazonAdsProfiles.id, r.profileId))
    .where(inArray(r.profileId, scope.ids))
    .orderBy(desc(r.createdAt))
    .limit(AUTOMATION_RUN_LIST_LIMIT);
}

/** Filter der Vorschlagsliste; abgelöste Vorschläge (`superseded`) erscheinen nie. */
export type AutomationProposalFilter = 'open' | 'staged' | 'dismissed';

export interface AutomationProposalRecord {
  id: string;
  runId: string;
  profileId: string;
  accountName: string;
  entityType: string;
  entityId: string;
  campaignName: string | null;
  adGroupName: string | null;
  /** Angaben zur Anzeige eines Targets; `null` bei Kampagnen. */
  target: {
    targetType: string | null;
    keywordText: string | null;
    matchType: string | null;
    expression: unknown;
  } | null;
  field: string;
  before: string | null;
  after: string;
  currencyCode: string | null;
  source: string;
  ruleName: string | null;
  limitedBy: string[];
  detail: Record<string, unknown>;
  status: AutomationProposalFilter;
  createdAt: Date;
}

export const AUTOMATION_PROPOSAL_LIST_LIMIT = 500;

/** Ein Vorschlag, dessen Änderung im Warenkorb gelöscht wurde, gilt als verworfen. */
const STATUS_FILTER = {
  open: eq(p.status, 'open'),
  staged: and(eq(p.status, 'staged'), isNotNull(p.adChangeId)),
  dismissed: or(eq(p.status, 'dismissed'), and(eq(p.status, 'staged'), isNull(p.adChangeId))),
};

/**
 * Vorschläge der sichtbaren Profile in einem Status, neueste zuerst, höchstens `AUTOMATION_PROPOSAL_LIST_LIMIT`;
 * `total` zählt alle. `null` für Nicht-Mitglieder.
 */
export async function listAutomationProposals(
  db: Db,
  input: AutomationRunAccess & { status: AutomationProposalFilter },
): Promise<{ proposals: AutomationProposalRecord[]; total: number } | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const where = and(inArray(p.profileId, scope.ids), STATUS_FILTER[input.status]);
  const [counted] = await db.select({ total: count() }).from(p).where(where);
  const rows = await db
    .select({
      proposal: p,
      accountName: amazonAdsProfiles.accountName,
      campaignName: amazonAdsCampaigns.name,
      adGroupName: amazonAdsAdGroups.name,
      targetId: amazonAdsTargets.id,
      targetType: amazonAdsTargets.targetType,
      keywordText: amazonAdsTargets.keywordText,
      matchType: amazonAdsTargets.matchType,
      expression: amazonAdsTargets.expression,
    })
    .from(p)
    .innerJoin(amazonAdsProfiles, eq(amazonAdsProfiles.id, p.profileId))
    .leftJoin(amazonAdsCampaigns, eq(amazonAdsCampaigns.id, p.campaignId))
    .leftJoin(amazonAdsAdGroups, eq(amazonAdsAdGroups.id, p.adGroupId))
    .leftJoin(
      amazonAdsTargets,
      and(eq(p.entityType, 'target'), eq(amazonAdsTargets.id, p.entityId)),
    )
    .where(where)
    .orderBy(desc(p.createdAt), p.id)
    .limit(AUTOMATION_PROPOSAL_LIST_LIMIT);
  return {
    total: counted!.total,
    proposals: rows.map(({ proposal: x, ...row }) => ({
      id: x.id,
      runId: x.runId,
      profileId: x.profileId,
      accountName: row.accountName,
      entityType: x.entityType,
      entityId: x.entityId,
      campaignName: row.campaignName,
      adGroupName: row.adGroupName,
      target: row.targetId
        ? {
            targetType: row.targetType,
            keywordText: row.keywordText,
            matchType: row.matchType,
            expression: row.expression,
          }
        : null,
      field: x.field,
      before: x.oldValue ?? x.oldAmount,
      after: (x.newValue ?? x.newAmount)!,
      currencyCode: x.currencyCode,
      source: x.source,
      ruleName: x.ruleName,
      limitedBy: x.limitedBy,
      detail: x.detail,
      status: input.status,
      createdAt: x.createdAt,
    })),
  };
}

export interface AutomationProposalActionResult {
  changed: number;
  /** Nicht (mehr) offen, nicht sichtbar oder an der Stelle liegt schon eine eigene Änderung. */
  skipped: number;
}

/**
 * Legt offene Vorschläge als Änderungen (Herkunft `automation`) in den Warenkorb des Nutzers. Liegt dort schon
 * eine Änderung an derselben Stelle, bleibt der Vorschlag offen. Audit `automation_proposals.stage`. Das Recht
 * `write` prüft die API. `null` für Nicht-Mitglieder.
 */
export async function stageAutomationProposals(
  db: Db,
  input: AutomationRunAccess & { ids: readonly string[] },
): Promise<AutomationProposalActionResult | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  return db.transaction(async (tx) => {
    const open = await tx
      .select()
      .from(p)
      .where(
        and(inArray(p.id, [...input.ids]), inArray(p.profileId, scope.ids), eq(p.status, 'open')),
      )
      .for('update');
    let changed = 0;
    const now = new Date();
    for (const part of chunks(open, INSERT_CHUNK)) {
      const inserted = await tx
        .insert(adChanges)
        .values(
          part.map((x) => ({
            organizationId: x.organizationId,
            profileId: x.profileId,
            origin: originOf(x.source),
            operation: 'update',
            entityType: x.entityType,
            entityId: x.entityId,
            campaignId: x.campaignId,
            adGroupId: x.adGroupId,
            field: x.field,
            oldValue: x.oldValue,
            newValue: x.newValue,
            oldAmount: x.oldAmount,
            newAmount: x.newAmount,
            currencyCode: x.currencyCode,
            createdBy: input.userId,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: adChanges.id, entityId: adChanges.entityId, field: adChanges.field });
      const changeIds = new Map(inserted.map((row) => [`${row.entityId}:${row.field}`, row.id]));
      for (const x of part) {
        const adChangeId = changeIds.get(`${x.entityId}:${x.field}`);
        if (!adChangeId) continue;
        await tx
          .update(p)
          .set({ status: 'staged', adChangeId, resolvedBy: input.userId, resolvedAt: now })
          .where(eq(p.id, x.id));
        changed += 1;
      }
    }
    if (changed > 0) {
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'automation_proposals.stage',
        target: { type: 'automation_proposals', id: input.orgId, count: changed },
      });
    }
    return { changed, skipped: input.ids.length - changed };
  });
}

/**
 * Verwirft Vorschläge: offene und solche, deren Änderung noch im Warenkorb liegt (die Zeile wird gelöscht, auch im
 * Warenkorb eines anderen Nutzers). Schon übermittelte bleiben. Verworfenes kommt erst mit neuen Kennzahlen wieder.
 * Audit `automation_proposals.dismiss`. `null` für Nicht-Mitglieder.
 */
export async function dismissAutomationProposals(
  db: Db,
  input: AutomationRunAccess & { ids: readonly string[] },
): Promise<AutomationProposalActionResult | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: p.id, adChangeId: p.adChangeId, changeStatus: adChanges.status })
      .from(p)
      .leftJoin(adChanges, eq(adChanges.id, p.adChangeId))
      .where(
        and(
          inArray(p.id, [...input.ids]),
          inArray(p.profileId, scope.ids),
          inArray(p.status, ['open', 'staged']),
        ),
      )
      .for('update', { of: p });
    const dismissable = rows.filter(
      (row) => row.adChangeId === null || row.changeStatus === 'pending',
    );
    const changeIds = dismissable.flatMap((row) => (row.adChangeId ? [row.adChangeId] : []));
    for (const part of chunks(changeIds)) {
      await tx
        .delete(adChanges)
        .where(and(inArray(adChanges.id, part), eq(adChanges.status, 'pending')));
    }
    for (const part of chunks(dismissable.map((row) => row.id))) {
      await tx
        .update(p)
        .set({ status: 'dismissed', resolvedBy: input.userId, resolvedAt: new Date() })
        .where(inArray(p.id, part));
    }
    if (dismissable.length > 0) {
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'automation_proposals.dismiss',
        target: { type: 'automation_proposals', id: input.orgId, count: dismissable.length },
      });
    }
    return { changed: dismissable.length, skipped: input.ids.length - dismissable.length };
  });
}
