import {
  automationRulesSchema,
  DEFAULT_AUTOMATION_RULES,
  type AutomationRule,
} from '@profitbash/shared';
import { effectiveGoal, firstMatchingRule, type GoalSetting } from '@profitbash/engine';
import { and, eq, inArray } from 'drizzle-orm';
import { getOrgRole, visibleProfilesScope } from './access';
import { recordAuditEvent } from './audit';
import { AutomationError, type AutomationAccessInput } from './automation';
import type { Db } from './client';
import { listLatestEntityPeriodMetrics } from './entity-period-metrics';
import { fxRatesOnOrBefore, latestFxRateDate } from './fx-rates';
import {
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsProfiles,
  amazonAdsTargets,
  automationRules,
  clients,
  goals,
} from './schema';
import { isUniqueViolation } from './structure-catalog';

/**
 * Regeln der Automatik (`docs/tasks/phase-5.md` 5.6a): eine geordnete Liste je Organisation, lesbar für alle
 * Mitglieder. Das Recht `write` im Feature `automations` prüft die API; die Liste ist schon mit
 * `automationRulesSchema` geprüft.
 */

export interface StoredAutomationRules {
  rules: AutomationRule[];
  version: number;
  updatedAt: Date | null;
}

const conflict = () =>
  new AutomationError(
    'VERSION_CONFLICT',
    'Die Regeln wurden inzwischen geändert. Bitte neu laden.',
  );

/**
 * Regeln der Organisation ohne Rechteprüfung (für den Lauf). Ohne Zeile die Startregeln (Version 0); eine Liste, die
 * nicht mehr zum Schema passt, fällt mit ihrer Version auf die Startregeln zurück. Regeln eines inzwischen gelöschten
 * Clients bleiben stehen und greifen nie.
 */
export async function loadAutomationRules(
  db: Pick<Db, 'select'>,
  orgId: string,
): Promise<StoredAutomationRules> {
  const [row] = await db
    .select()
    .from(automationRules)
    .where(eq(automationRules.organizationId, orgId));
  if (!row) return { rules: DEFAULT_AUTOMATION_RULES, version: 0, updatedAt: null };
  const parsed = automationRulesSchema.safeParse(row.rules);
  return {
    rules: parsed.success ? parsed.data : DEFAULT_AUTOMATION_RULES,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

/** `null` für Nicht-Mitglieder. */
export async function getAutomationRules(
  db: Db,
  access: AutomationAccessInput,
): Promise<StoredAutomationRules | null> {
  if ((await getOrgRole(db, access.userId, access.orgId)) === null) return null;
  return loadAutomationRules(db, access.orgId);
}

/**
 * Speichert die ganze Liste. `version` muss der gelesenen entsprechen (`VERSION_CONFLICT`), danach zählt sie hoch;
 * `UNKNOWN_CLIENT` für Regeln mit einem Client außerhalb der Organisation. Audit `automation_rules.update` mit
 * vorher und nachher. `null` für Nicht-Mitglieder.
 */
export async function saveAutomationRules(
  db: Db,
  input: AutomationAccessInput & { rules: AutomationRule[]; version: number },
): Promise<StoredAutomationRules | null> {
  if ((await getOrgRole(db, input.userId, input.orgId)) === null) return null;
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ version: automationRules.version })
        .from(automationRules)
        .where(eq(automationRules.organizationId, input.orgId))
        .for('update');
      if ((current?.version ?? 0) !== input.version) throw conflict();
      const clientIds = [...new Set(input.rules.flatMap((r) => (r.clientId ? [r.clientId] : [])))];
      if (clientIds.length > 0) {
        const known = await tx
          .select({ id: clients.id })
          .from(clients)
          .where(and(eq(clients.organizationId, input.orgId), inArray(clients.id, clientIds)));
        if (known.length !== clientIds.length) {
          throw new AutomationError('UNKNOWN_CLIENT', 'Eine Regel nennt einen unbekannten Client.');
        }
      }
      const before = await loadAutomationRules(tx, input.orgId);
      const version = input.version + 1;
      const updatedAt = new Date();
      const values = { rules: input.rules, version, updatedBy: input.userId, updatedAt };
      if (current) {
        await tx
          .update(automationRules)
          .set(values)
          .where(eq(automationRules.organizationId, input.orgId));
      } else {
        // Gleichzeitiges erstes Speichern: Die zweite Anfrage scheitert am Primärschlüssel (siehe unten).
        await tx.insert(automationRules).values({ organizationId: input.orgId, ...values });
      }
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'automation_rules.update',
        target: {
          type: 'automation_rules',
          id: input.orgId,
          version,
          before: { version: before.version, rules: before.rules },
          after: input.rules,
        },
      });
      return { rules: input.rules, version, updatedAt };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'automation_rules_pkey')) throw conflict();
    throw error;
  }
}

export interface RulePreviewRecord {
  /** Je Regel (in der Reihenfolge der Liste) die Entities, für die sie als erste greift. */
  counts: { ruleId: string; entities: number }[];
  /** Aktive Targets bzw. Kampagnen mit Kennzahlen, gegen die geprüft wurde. */
  targets: number;
  campaigns: number;
}

const ACTIVE = 'ENABLED';

/**
 * Vorschau „würde heute für N Entities greifen“ für eine (auch ungespeicherte) Liste: alle aktiven Targets und
 * Kampagnen der sichtbaren Profile mit ihrem Datenstand (`listLatestEntityPeriodMetrics`). `null` für Nicht-Mitglieder.
 *
 * shortcut: Ziel nur von Profil bzw. Client (ohne Produktgruppen) und ohne die Leitplanken; der Lauf (5.7) rechnet
 * mit dem wirksamen Ziel je Target. Profile ohne EZB-Kurs für ihre Währung zählen nicht.
 */
export async function previewAutomationRules(
  db: Db,
  input: AutomationAccessInput & { rules: readonly AutomationRule[] },
): Promise<RulePreviewRecord | null> {
  const visible = await visibleProfilesScope(db, input);
  if (visible === null) return null;
  const profiles = await db
    .select({
      id: amazonAdsProfiles.id,
      clientId: amazonAdsProfiles.clientId,
      currencyCode: amazonAdsProfiles.currencyCode,
    })
    .from(amazonAdsProfiles)
    .where(inArray(amazonAdsProfiles.id, visible.ids));
  const rateDate = await latestFxRateDate(db);
  const currencies = profiles.map((profile) => profile.currencyCode);
  // Ohne Kurstabelle kennt `fxRatesOnOrBefore` nur EUR (Kurs 1); der Tag ist dann gleichgültig.
  const rates = await fxRatesOnOrBefore(db, rateDate ?? '1970-01-01', currencies);
  const goalRows = await db.select().from(goals).where(eq(goals.organizationId, input.orgId));
  const goalSettings = goalRows.flatMap((row): GoalSetting[] => {
    const metric = row.metric as GoalSetting['metric'];
    if (row.clientId) return [{ scope: 'client', scopeId: row.clientId, metric, value: row.value }];
    if (row.profileId)
      return [{ scope: 'profile', scopeId: row.profileId, metric, value: row.value }];
    return [];
  });

  const counts = new Map(input.rules.map((rule) => [rule.id, 0]));
  const checked = { target: 0, campaign: 0 };
  for (const profile of profiles) {
    const eurRate = rates.get(profile.currencyCode)?.rate;
    if (eurRate === undefined) continue;
    const scope = { organizationId: input.orgId, profileId: profile.id };
    const goalAcos =
      effectiveGoal(goalSettings, {
        clientId: profile.clientId,
        profileId: profile.id,
        productGroupIds: [],
      })?.acos ?? null;
    const campaigns = await db
      .select({
        id: amazonAdsCampaigns.id,
        amazonId: amazonAdsCampaigns.amazonCampaignId,
        state: amazonAdsCampaigns.state,
      })
      .from(amazonAdsCampaigns)
      .where(eq(amazonAdsCampaigns.profileId, profile.id));
    const activeCampaigns = new Set(campaigns.filter((c) => c.state === ACTIVE).map((c) => c.id));
    const adGroups = await db
      .select({ id: amazonAdsAdGroups.id, state: amazonAdsAdGroups.state })
      .from(amazonAdsAdGroups)
      .where(eq(amazonAdsAdGroups.profileId, profile.id));
    const activeAdGroups = new Set(adGroups.filter((g) => g.state === ACTIVE).map((g) => g.id));
    const targets = await db
      .select({
        amazonId: amazonAdsTargets.amazonTargetId,
        state: amazonAdsTargets.state,
        campaignId: amazonAdsTargets.campaignId,
        adGroupId: amazonAdsTargets.adGroupId,
      })
      .from(amazonAdsTargets)
      .where(eq(amazonAdsTargets.profileId, profile.id));
    const active = {
      campaign: new Set(campaigns.filter((c) => activeCampaigns.has(c.id)).map((c) => c.amazonId)),
      target: new Set(
        targets
          .filter(
            (t) =>
              t.state === ACTIVE &&
              activeCampaigns.has(t.campaignId) &&
              (t.adGroupId === null || activeAdGroups.has(t.adGroupId)),
          )
          .map((t) => t.amazonId),
      ),
    };
    for (const level of ['target', 'campaign'] as const) {
      for (const row of await listLatestEntityPeriodMetrics(db, { ...scope, level })) {
        if (!active[level].has(row.amazonEntityId)) continue;
        checked[level] += 1;
        const rule = firstMatchingRule(input.rules, {
          level,
          clientId: profile.clientId,
          metrics: {
            impressions: row.impressions,
            clicks: row.clicks,
            orders: row.purchases,
            spend: row.cost,
            sales: row.sales,
          },
          goalAcos,
          eurRate,
        });
        if (rule) counts.set(rule.id, counts.get(rule.id)! + 1);
      }
    }
  }
  return {
    counts: input.rules.map((rule) => ({ ruleId: rule.id, entities: counts.get(rule.id)! })),
    targets: checked.target,
    campaigns: checked.campaign,
  };
}
