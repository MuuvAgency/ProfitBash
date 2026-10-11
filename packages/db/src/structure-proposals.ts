import {
  comparableSearchTerm,
  effectiveGoal,
  graduationProposals,
  presetSwitchProposals,
  Dec,
  type GoalSetting,
} from '@profitbash/engine';
import {
  DEFAULT_SEARCH_TERM_RULES,
  effectivePreset,
  resolveSearchTermRules,
  type StructureCatalog,
} from '@profitbash/shared';
import { and, asc, count, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import { visibleProfilesScope } from './access';
import { chunks } from './ad-change-entities';
import { recordAuditEvent, type DbOrTx } from './audit';
import { loadCampaignBlocks } from './campaign-blocks';
import type { Db } from './client';
import { listLatestEntityPeriodMetrics, type ProfileMetricsState } from './entity-period-metrics';
import { ProductGroupError, updateProductGroup } from './product-groups';
import {
  amazonAdsCampaigns,
  amazonAdsProductAds,
  amazonAdsProfiles,
  amazonAdsSearchTermPeriodMetrics,
  amazonAdsTargets,
  automationStructureProposals,
  clientPresets,
  productGroupItems,
  productGroups,
  searchTermRuleOverrides,
  searchTermRules,
} from './schema';
import { listMarkedHarvestTermKeys, markSearchTermsForHarvest } from './search-term-harvest';
import { loadStructureCatalog } from './structure-catalog';

/**
 * Graduation- und Preset-Vorschläge (`docs/tasks/phase-5.md` 5.11b). Der Lauf der Automatik rechnet sie aus den
 * Kanten und Preset-Wechseln des Struktur-Katalogs (Systemzugriff: `planStructure`, `loadStructureProposals`,
 * `syncStructureProposals`); lesen, annehmen und verwerfen laufen über `visibleProfilesScope()` (ADR 002). Annehmen
 * heißt: Begriff auf die Merkliste (wie 4.6) bzw. Preset der Produktgruppe ändern, nie automatisch. Das Recht
 * (`view` bzw. `write` im Feature `automations`) prüft die API.
 */

const s = automationStructureProposals;

export type StructureProposalKind = 'graduation' | 'presetSwitch';

export interface StructureProposalInput {
  kind: StructureProposalKind;
  subject: string;
  key: string;
  detail: Record<string, unknown>;
}

interface StructureScope {
  organizationId: string;
  profileId: string;
}

/** Was der Lauf vom Katalog braucht; steht im Plan und (ohne die Bausteine) im `fingerprint`. */
export interface StructurePlan {
  catalog: StructureCatalog;
  /** Harvest-Regel des Profils (Suchbegriff-Einstufung), `maxAcos` als Bruch. */
  harvest: { minOrders: number; maxAcos: string };
  /** Baustein je Amazon-Kampagnen-ID. */
  campaignBlocks: Map<string, string>;
  /** Produktgruppen des Profils mit ihrem wirksamen Preset. */
  groups: { id: string; name: string; presetKey: string }[];
}

export async function planStructure(
  db: Db,
  scope: StructureScope,
  clientId: string | null,
): Promise<StructurePlan> {
  const { catalog } = await loadStructureCatalog(db, scope.organizationId);
  const [organization] = await db
    .select()
    .from(searchTermRules)
    .where(eq(searchTermRules.organizationId, scope.organizationId));
  const [overrides] = await db
    .select()
    .from(searchTermRuleOverrides)
    .where(eq(searchTermRuleOverrides.profileId, scope.profileId));
  const rules = resolveSearchTermRules(
    organization ?? DEFAULT_SEARCH_TERM_RULES,
    overrides ?? null,
  );
  const [clientPreset] = clientId
    ? await db
        .select({ presetKey: clientPresets.presetKey })
        .from(clientPresets)
        .where(eq(clientPresets.clientId, clientId))
    : [];
  const groups = await db
    .select({ id: productGroups.id, name: productGroups.name, presetKey: productGroups.presetKey })
    .from(productGroups)
    .where(
      and(
        eq(productGroups.profileId, scope.profileId),
        eq(productGroups.organizationId, scope.organizationId),
      ),
    )
    .orderBy(asc(productGroups.id));
  return {
    catalog,
    harvest: { minOrders: rules.harvestMinPurchases, maxAcos: rules.harvestMaxAcos },
    campaignBlocks: await loadCampaignBlocks(db, scope.organizationId, scope.profileId),
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      presetKey: effectivePreset(catalog, {
        productGroup: group.presetKey,
        client: clientPreset?.presetKey,
      }).key,
    })),
  };
}

/** Der Teil des Plans, der einen Lauf fällig macht, wenn er sich ändert. */
export const structureFingerprint = (plan: StructurePlan) => ({
  edges: plan.catalog.edges,
  presetSwitches: plan.catalog.presetSwitches,
  harvest: plan.harvest,
  campaignBlocks: [...plan.campaignBlocks].sort(([a], [b]) => a.localeCompare(b)),
  groups: plan.groups.map(({ id, presetKey }) => [id, presetKey]),
});

/**
 * Rechnet die Vorschläge eines Profils auf seinem Datenstand: Suchbegriffe des Datei-Zeitraums gegen die Kanten,
 * Kennzahlen der Produkte je Gruppe (Ebene `productAd`, 5.1) gegen die Preset-Wechsel.
 */
export async function loadStructureProposals(
  db: Db,
  scope: StructureScope,
  plan: {
    profile: { id: string; clientId: string | null };
    state: ProfileMetricsState;
    goals: GoalSetting[];
    eurRate: string;
    structure: StructurePlan;
  },
): Promise<StructureProposalInput[]> {
  const { structure, state } = plan;
  const goalOf = (productGroupIds: string[]) =>
    effectiveGoal(plan.goals, {
      clientId: plan.profile.clientId,
      profileId: plan.profile.id,
      productGroupIds,
    })?.acos ?? null;
  const results: StructureProposalInput[] = [];

  if (structure.campaignBlocks.size > 0 && structure.catalog.edges.length > 0) {
    const m = amazonAdsSearchTermPeriodMetrics;
    const rows = await db
      .select({
        searchTerm: m.searchTerm,
        amazonCampaignId: m.amazonCampaignId,
        clicks: m.clicks,
        orders: m.purchases,
        spend: m.cost,
        sales: m.sales,
      })
      .from(m)
      .where(
        and(
          eq(m.profileId, scope.profileId),
          eq(m.periodStart, state.period.startDate),
          eq(m.periodEnd, state.period.endDate),
          // Nur Kampagnen mit Baustein können graduieren.
          inArray(m.amazonCampaignId, [...structure.campaignBlocks.keys()]),
        ),
      )
      .orderBy(sql`${m.cost} desc`, asc(m.searchTerm), asc(m.id));
    const t = amazonAdsTargets;
    // Schon exakt gebucht (wie `exactTargetTerms` der Analyse), hier mit dem Baustein der Kampagne.
    const exact = await db
      .select({
        keywordText: t.keywordText,
        asin: sql<string | null>`${t.expression}->>'asin'`,
        amazonCampaignId: amazonAdsCampaigns.amazonCampaignId,
      })
      .from(t)
      .innerJoin(amazonAdsCampaigns, eq(amazonAdsCampaigns.id, t.campaignId))
      .where(
        and(
          eq(t.profileId, scope.profileId),
          isNull(t.removedAt),
          sql`upper(coalesce(${t.state}, '')) <> 'ARCHIVED'`,
          or(eq(t.matchType, 'EXACT'), eq(t.matchType, 'PRODUCT_EXACT')),
        ),
      );
    const exactIn = new Map<string, (string | null)[]>();
    for (const target of exact) {
      const term = target.keywordText ?? target.asin;
      if (!term) continue;
      const key = comparableSearchTerm(term);
      exactIn.set(key, [
        ...(exactIn.get(key) ?? []),
        structure.campaignBlocks.get(target.amazonCampaignId) ?? null,
      ]);
    }
    const proposals = graduationProposals({
      blocks: structure.catalog.blocks,
      edges: structure.catalog.edges,
      campaignBlocks: structure.campaignBlocks,
      rows,
      harvest: structure.harvest,
      // Suchbegriffe hängen an keiner Produktgruppe: Es gilt das Ziel von Profil bzw. Client.
      goalAcos: goalOf([]),
      marked: await listMarkedHarvestTermKeys(db, scope.profileId),
      exactIn,
    });
    for (const { termKey, ...detail } of proposals) {
      results.push({
        kind: 'graduation',
        subject: termKey,
        key: detail.fromBlock,
        detail: { ...detail, periodStart: state.period.startDate, periodEnd: state.period.endDate },
      });
    }
  }

  if (structure.groups.length > 0 && structure.catalog.presetSwitches.length > 0) {
    const ads = await db
      .select({
        amazonAdId: amazonAdsProductAds.amazonAdId,
        groupId: productGroupItems.productGroupId,
      })
      .from(amazonAdsProductAds)
      .innerJoin(productGroupItems, eq(productGroupItems.asin, amazonAdsProductAds.asin))
      .where(
        and(
          eq(amazonAdsProductAds.profileId, scope.profileId),
          inArray(
            productGroupItems.productGroupId,
            structure.groups.map((group) => group.id),
          ),
        ),
      );
    const groupsOfAd = new Map<string, Set<string>>();
    for (const ad of ads) {
      groupsOfAd.set(ad.amazonAdId, (groupsOfAd.get(ad.amazonAdId) ?? new Set()).add(ad.groupId));
    }
    const sums = new Map<string, { orders: number; spend: Dec; sales: Dec }>();
    for (const row of await listLatestEntityPeriodMetrics(db, { ...scope, level: 'productAd' })) {
      if (row.periodEnd < state.period.endDate) continue;
      for (const groupId of groupsOfAd.get(row.amazonEntityId) ?? []) {
        const sum = sums.get(groupId) ?? { orders: 0, spend: new Dec(0), sales: new Dec(0) };
        sum.orders += Number(row.purchases);
        sum.spend = sum.spend.plus(row.cost);
        sum.sales = sum.sales.plus(row.sales);
        sums.set(groupId, sum);
      }
    }
    const names = new Map(structure.groups.map((group) => [group.id, group.name]));
    const proposals = presetSwitchProposals({
      switches: structure.catalog.presetSwitches,
      eurRate: plan.eurRate,
      // Gruppen ohne Kennzahlen im Datenstand bekommen keinen Vorschlag.
      groups: structure.groups.flatMap((group) => {
        const sum = sums.get(group.id);
        if (!sum) return [];
        return [
          {
            id: group.id,
            presetKey: group.presetKey,
            orders: sum.orders,
            spend: sum.spend.toFixed(2),
            sales: sum.sales.toFixed(2),
            goalAcos: goalOf([group.id]),
          },
        ];
      }),
    });
    for (const proposal of proposals) {
      results.push({
        kind: 'presetSwitch',
        subject: proposal.productGroupId,
        key: proposal.to,
        detail: { ...proposal, productGroupName: names.get(proposal.productGroupId) ?? '' },
      });
    }
  }
  return results;
}

const keyOf = (x: { kind: string; subject: string; key: string }) =>
  `${x.kind}\n${x.subject}\n${x.key}`;

/**
 * Gleicht die Vorschläge eines Profils mit dem Ergebnis eines Laufs ab (wie `syncAutomationFindings`): Bestehende
 * behalten ID, erstes Auftreten und „verworfen“, neue kommen dazu, alle übrigen werden gelöscht.
 */
export async function syncStructureProposals(
  db: DbOrTx,
  input: StructureScope & { proposals: readonly StructureProposalInput[]; now: Date },
): Promise<{ total: number; added: number }> {
  const ofProfile = and(
    eq(s.profileId, input.profileId),
    eq(s.organizationId, input.organizationId),
  );
  const existing = await db
    .select({ id: s.id, kind: s.kind, subject: s.subject, key: s.key })
    .from(s)
    .where(ofProfile);
  const known = new Map(existing.map((row) => [keyOf(row), row.id]));
  const kept: string[] = [];
  const added: StructureProposalInput[] = [];
  for (const proposal of input.proposals) {
    const id = known.get(keyOf(proposal));
    if (id === undefined) {
      added.push(proposal);
      continue;
    }
    kept.push(id);
    await db.update(s).set({ detail: proposal.detail, lastSeenAt: input.now }).where(eq(s.id, id));
  }
  await db.delete(s).where(and(ofProfile, kept.length > 0 ? notInArray(s.id, kept) : undefined));
  for (const part of chunks(added)) {
    await db.insert(s).values(
      part.map((proposal) => ({
        ...proposal,
        organizationId: input.organizationId,
        profileId: input.profileId,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
      })),
    );
  }
  return { total: input.proposals.length, added: added.length };
}

/** Modus „aus“ (5.13): Offenes entfernen; Verworfenes bleibt, damit es nach dem Einschalten verworfen ist. */
export async function clearOpenStructureProposals(
  db: DbOrTx,
  scope: StructureScope,
): Promise<void> {
  await db
    .delete(s)
    .where(
      and(
        eq(s.profileId, scope.profileId),
        eq(s.organizationId, scope.organizationId),
        isNull(s.dismissedAt),
      ),
    );
}

export interface StructureProposalAccess {
  userId: string;
  orgId: string;
}

export interface StructureProposalRecord {
  id: string;
  profileId: string;
  accountName: string;
  currencyCode: string;
  kind: StructureProposalKind;
  subject: string;
  key: string;
  detail: Record<string, unknown>;
  firstSeenAt: Date;
  dismissedAt: Date | null;
}

export const STRUCTURE_PROPOSAL_LIST_LIMIT = 500;

/**
 * Offene bzw. verworfene Vorschläge der sichtbaren Profile, neueste zuerst (höchstens
 * `STRUCTURE_PROPOSAL_LIST_LIMIT`, `total` zählt alle). `null` für Nicht-Mitglieder.
 */
export async function listStructureProposals(
  db: Db,
  input: StructureProposalAccess & { status: 'open' | 'dismissed' },
): Promise<{ proposals: StructureProposalRecord[]; total: number } | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const where = and(
    inArray(s.profileId, scope.ids),
    input.status === 'open' ? isNull(s.dismissedAt) : isNotNull(s.dismissedAt),
  );
  const [counted] = await db.select({ total: count() }).from(s).where(where);
  const rows = await db
    .select({
      proposal: s,
      accountName: amazonAdsProfiles.accountName,
      currencyCode: amazonAdsProfiles.currencyCode,
    })
    .from(s)
    .innerJoin(amazonAdsProfiles, eq(amazonAdsProfiles.id, s.profileId))
    .where(where)
    .orderBy(sql`${s.firstSeenAt} desc`, asc(s.kind), asc(s.subject), asc(s.id))
    .limit(STRUCTURE_PROPOSAL_LIST_LIMIT);
  return {
    total: counted!.total,
    proposals: rows.map(({ proposal, ...profile }) => ({
      id: proposal.id,
      profileId: proposal.profileId,
      ...profile,
      kind: proposal.kind as StructureProposalKind,
      subject: proposal.subject,
      key: proposal.key,
      detail: proposal.detail,
      firstSeenAt: proposal.firstSeenAt,
      dismissedAt: proposal.dismissedAt,
    })),
  };
}

export interface StructureProposalActionResult {
  changed: number;
  /** Nicht (mehr) sichtbar, schon erledigt oder nicht mehr annehmbar. */
  skipped: number;
}

/**
 * Verwirft offene Vorschläge sichtbarer Profile (Audit `automation_structure_proposals.dismiss`). Verworfen bleibt
 * ein Vorschlag, solange er in jedem Lauf wieder auftritt (wie quittierte Befunde). `null` für Nicht-Mitglieder.
 */
export async function dismissStructureProposals(
  db: Db,
  input: StructureProposalAccess & { ids: readonly string[] },
): Promise<StructureProposalActionResult | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(s)
      .set({ dismissedBy: input.userId, dismissedAt: new Date() })
      .where(
        and(inArray(s.id, [...input.ids]), inArray(s.profileId, scope.ids), isNull(s.dismissedAt)),
      )
      .returning({ id: s.id });
    if (rows.length > 0) {
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'automation_structure_proposals.dismiss',
        target: { type: 'automation_structure_proposals', id: input.orgId, count: rows.length },
      });
    }
    return { changed: rows.length, skipped: input.ids.length - rows.length };
  });
}

/**
 * Nimmt offene Vorschläge sichtbarer Profile an: Graduation legt den Begriff mit den Kennzahlen des Datei-Zeitraums
 * auf die Merkliste (`markSearchTermsForHarvest`, das Setup verteilt ihn nach dem Preset der Produktgruppe und
 * schlägt das Negativ in der Quelle vor, 4.6); ein Preset-Wechsel setzt das Preset der Produktgruppe
 * (`updateProductGroup`, Audit dort). Angenommenes verlässt die Liste. Was sich nicht mehr annehmen lässt (Begriff
 * nicht mehr im Zeitraum, Preset oder Gruppe gelöscht), bleibt stehen und zählt als übersprungen. Audit
 * `automation_structure_proposals.accept`. `null` für Nicht-Mitglieder.
 */
export async function acceptStructureProposals(
  db: Db,
  input: StructureProposalAccess & { ids: readonly string[] },
): Promise<StructureProposalActionResult | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const rows = await db
    .select()
    .from(s)
    .where(
      and(inArray(s.id, [...input.ids]), inArray(s.profileId, scope.ids), isNull(s.dismissedAt)),
    );
  const done: string[] = [];

  // Graduation je Profil und Datei-Zeitraum in einem Aufruf (der liest alle Zeilen des Zeitraums).
  const batches = new Map<string, typeof rows>();
  for (const row of rows.filter((x) => x.kind === 'graduation')) {
    const key = `${row.profileId}\n${String(row.detail.periodStart)}\n${String(row.detail.periodEnd)}`;
    batches.set(key, [...(batches.get(key) ?? []), row]);
  }
  for (const batch of batches.values()) {
    const first = batch[0]!;
    const marked = await markSearchTermsForHarvest(db, {
      ...input,
      profileId: first.profileId,
      periodStart: String(first.detail.periodStart),
      periodEnd: String(first.detail.periodEnd),
      searchTerms: batch.map((row) => String(row.detail.searchTerm ?? row.subject)),
    });
    marked?.results.forEach((result, index) => {
      if (result.outcome !== 'notFound') done.push(batch[index]!.id);
    });
  }
  for (const row of rows.filter((x) => x.kind === 'presetSwitch')) {
    try {
      const updated = await updateProductGroup(db, {
        ...input,
        id: row.subject,
        presetKey: row.key,
      });
      if (updated !== null) done.push(row.id);
    } catch (error) {
      if (!(error instanceof ProductGroupError)) throw error;
    }
  }

  // shortcut: Merkliste bzw. Preset und das Löschen des Vorschlags laufen nicht in einer Transaktion; bricht es
  // dazwischen ab, räumt der nächste Lauf den Vorschlag weg (der Begriff steht dann auf der Merkliste).
  if (done.length > 0) {
    await db.transaction(async (tx) => {
      await tx.delete(s).where(inArray(s.id, done));
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'automation_structure_proposals.accept',
        target: { type: 'automation_structure_proposals', id: input.orgId, count: done.length },
      });
    });
  }
  return { changed: done.length, skipped: input.ids.length - done.length };
}
