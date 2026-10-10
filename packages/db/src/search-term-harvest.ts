import { comparableSearchTerm, Dec } from '@profitbash/engine';
import type { HarvestMarkSource } from '@profitbash/engine/plan';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { visibleProfilesScope } from './access';
import { chunks } from './ad-change-entities';
import { recordAuditEvent, type DbOrTx } from './audit';
import type { Db } from './client';
import {
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsProfiles,
  amazonAdsSearchTermPeriodMetrics,
  amazonAdsTargets,
  searchTermHarvestMarks,
  users,
} from './schema';

/**
 * Harvest-Merkliste (`docs/tasks/phase-3.md` 3.8, F9): Suchbegriffe je Profil vormerken, ansehen und entfernen. Keine
 * Änderung bei Amazon; Phase 4 (Kampagnen-Setup) liest die Liste. Alle Zugriffe über `visibleProfilesScope()`
 * (ADR 002). Quelle und Kennzahlen liest der Server aus den Zeilen des Datei-Zeitraums, nie aus der Anfrage. Das
 * Recht (`write` bzw. `view` im Feature `sp-explorer`) prüft die API.
 */

export interface HarvestAccessInput {
  userId: string;
  orgId: string;
}

export interface MarkSearchTermsForHarvestInput extends HarvestAccessInput {
  profileId: string;
  /** Genau ein Datei-Zeitraum (`YYYY-MM-DD`, beide Tage eingeschlossen). */
  periodStart: string;
  periodEnd: string;
  searchTerms: readonly string[];
}

export type MarkHarvestResult =
  | { outcome: 'added'; id: string }
  /** Der Begriff steht für das Profil schon auf der Merkliste (die Kennzahlen von damals bleiben). */
  | { outcome: 'alreadyMarked' }
  /** Im Datei-Zeitraum gibt es keine Zeile mit dem Begriff. */
  | { outcome: 'notFound' };

export interface MarkSearchTermsForHarvestResult {
  /** Je Eingabe ein Ergebnis, in derselben Reihenfolge. */
  results: MarkHarvestResult[];
  counts: { added: number; alreadyMarked: number; notFound: number };
}

const h = searchTermHarvestMarks;
const p = amazonAdsProfiles;

async function visibleProfile(db: Db, input: HarvestAccessInput & { profileId: string }) {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const [profile] = await db
    .select({ id: p.id, organizationId: p.organizationId, currencyCode: p.currencyCode })
    .from(p)
    .where(and(eq(p.id, input.profileId), inArray(p.id, scope.ids)))
    .limit(1);
  return profile ?? null;
}

/**
 * Setzt Suchbegriffe eines Datei-Zeitraums auf die Merkliste des Profils. Kennzahlen sind die Summen über alle
 * Zeilen des Begriffs im Zeitraum (Vergleichsform), Quelle ist die Zeile mit dem höchsten Spend. Je Profil und
 * Begriff ein Eintrag; ein Audit-Event `search_term_harvest.add` je Anfrage, wenn etwas dazukam. `null`, wenn der
 * Nutzer das Profil nicht sehen darf.
 */
export async function markSearchTermsForHarvest(
  db: Db,
  input: MarkSearchTermsForHarvestInput,
): Promise<MarkSearchTermsForHarvestResult | null> {
  const profile = await visibleProfile(db, input);
  if (!profile) return null;

  const wanted = new Set(input.searchTerms.map(comparableSearchTerm));
  const m = amazonAdsSearchTermPeriodMetrics;
  // Alle Zeilen des Zeitraums (wie die Analyse): Die Vergleichsform lässt sich in SQL nicht nachbilden.
  const rows = await db
    .select({
      adProduct: m.adProduct,
      searchTerm: m.searchTerm,
      amazonCampaignId: m.amazonCampaignId,
      amazonAdGroupId: m.amazonAdGroupId,
      amazonTargetId: m.amazonTargetId,
      impressions: m.impressions,
      clicks: m.clicks,
      cost: m.cost,
      sales: m.sales,
      purchases: m.purchases,
      units: m.units,
    })
    .from(m)
    .where(
      and(
        eq(m.profileId, profile.id),
        eq(m.periodStart, input.periodStart),
        eq(m.periodEnd, input.periodEnd),
      ),
    )
    .orderBy(desc(m.cost), asc(m.searchTerm), asc(m.id));

  interface Sum {
    source: (typeof rows)[number];
    sourceRows: number;
    impressions: number;
    clicks: number;
    purchases: number;
    units: number;
    cost: Dec;
    sales: Dec;
  }
  const sums = new Map<string, Sum>();
  for (const row of rows) {
    const key = comparableSearchTerm(row.searchTerm);
    if (!wanted.has(key)) continue;
    // Die erste Zeile je Begriff hat den höchsten Spend (Sortierung der Abfrage).
    const sum = sums.get(key) ?? {
      source: row,
      sourceRows: 0,
      impressions: 0,
      clicks: 0,
      purchases: 0,
      units: 0,
      cost: new Dec(0),
      sales: new Dec(0),
    };
    sum.sourceRows += 1;
    sum.impressions += row.impressions;
    sum.clicks += row.clicks;
    sum.purchases += row.purchases;
    sum.units += row.units;
    sum.cost = sum.cost.plus(row.cost);
    sum.sales = sum.sales.plus(row.sales);
    sums.set(key, sum);
  }

  return db.transaction(async (tx) => {
    const values = [...sums].map(([termKey, sum]) => ({
      organizationId: profile.organizationId,
      profileId: profile.id,
      searchTerm: sum.source.searchTerm,
      termKey,
      adProduct: sum.source.adProduct,
      amazonCampaignId: sum.source.amazonCampaignId,
      amazonAdGroupId: sum.source.amazonAdGroupId,
      amazonTargetId: sum.source.amazonTargetId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      sourceRows: sum.sourceRows,
      currencyCode: profile.currencyCode,
      impressions: sum.impressions,
      clicks: sum.clicks,
      cost: sum.cost.toFixed(),
      sales: sum.sales.toFixed(),
      purchases: sum.purchases,
      units: sum.units,
      createdBy: input.userId,
    }));
    const added = new Map<string, string>();
    for (const part of chunks(values, 500)) {
      const inserted = await tx
        .insert(h)
        .values(part)
        .onConflictDoNothing({ target: [h.profileId, h.termKey] })
        .returning({ id: h.id, termKey: h.termKey });
      for (const row of inserted) added.set(row.termKey, row.id);
    }

    const counts = { added: 0, alreadyMarked: 0, notFound: 0 };
    const reported = new Set<string>();
    const results = input.searchTerms.map((searchTerm): MarkHarvestResult => {
      const key = comparableSearchTerm(searchTerm);
      const id = added.get(key);
      let result: MarkHarvestResult;
      if (!sums.has(key)) result = { outcome: 'notFound' };
      // Derselbe Begriff zweimal in einer Anfrage: nur die erste Angabe hat ihn vorgemerkt.
      else if (id === undefined || reported.has(key)) result = { outcome: 'alreadyMarked' };
      else result = { outcome: 'added', id };
      reported.add(key);
      counts[result.outcome] += 1;
      return result;
    });
    if (counts.added > 0) {
      await recordAuditEvent(tx, {
        // Die Daten gehören der Organisation des Profils (ADR 002).
        organizationId: profile.organizationId,
        actorUserId: input.userId,
        action: 'search_term_harvest.add',
        target: {
          type: 'search_term_harvest',
          id: profile.id,
          profileId: profile.id,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          added: counts.added,
        },
      });
    }
    return { results, counts };
  });
}

export interface HarvestMark {
  id: string;
  profileId: string;
  accountName: string;
  countryCode: string;
  searchTerm: string;
  adProduct: string;
  amazonCampaignId: string;
  amazonAdGroupId: string;
  amazonTargetId: string;
  /** Interne IDs und Namen der Quelle; `null`, wenn die Entity im Profil fehlt. */
  campaignId: string | null;
  campaignName: string | null;
  adGroupId: string | null;
  adGroupName: string | null;
  targetId: string | null;
  keywordText: string | null;
  matchType: string | null;
  expression: unknown;
  periodStart: string;
  periodEnd: string;
  sourceRows: number;
  /** Zähler und Beträge als Decimal-Strings, Stand beim Vormerken. */
  currencyCode: string;
  impressions: string;
  clicks: string;
  cost: string;
  sales: string;
  purchases: string;
  units: string;
  createdByName: string | null;
  createdAt: Date;
}

export const HARVEST_MARK_LIST_LIMIT = 5000;

/**
 * Merkliste der sichtbaren Profile (optional eines Profils), neueste zuerst, höchstens `HARVEST_MARK_LIST_LIMIT`.
 * `null` für Nicht-Mitglieder; ein nicht sichtbares Profil ergibt eine leere Liste.
 */
export async function listHarvestMarks(
  db: Db,
  input: HarvestAccessInput & { profileId?: string },
): Promise<HarvestMark[] | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const c = amazonAdsCampaigns;
  const g = amazonAdsAdGroups;
  const t = amazonAdsTargets;
  const rows = await db
    .select({
      id: h.id,
      profileId: h.profileId,
      accountName: p.accountName,
      countryCode: p.countryCode,
      searchTerm: h.searchTerm,
      adProduct: h.adProduct,
      amazonCampaignId: h.amazonCampaignId,
      amazonAdGroupId: h.amazonAdGroupId,
      amazonTargetId: h.amazonTargetId,
      campaignId: c.id,
      campaignName: c.name,
      adGroupId: g.id,
      adGroupName: g.name,
      targetId: t.id,
      keywordText: t.keywordText,
      matchType: t.matchType,
      expression: t.expression,
      periodStart: h.periodStart,
      periodEnd: h.periodEnd,
      sourceRows: h.sourceRows,
      currencyCode: h.currencyCode,
      impressions: sql<string>`${h.impressions}::text`,
      clicks: sql<string>`${h.clicks}::text`,
      cost: h.cost,
      sales: h.sales,
      purchases: sql<string>`${h.purchases}::text`,
      units: sql<string>`${h.units}::text`,
      createdByName: users.name,
      createdAt: h.createdAt,
    })
    .from(h)
    .innerJoin(p, eq(p.id, h.profileId))
    .leftJoin(c, and(eq(c.profileId, h.profileId), eq(c.amazonCampaignId, h.amazonCampaignId)))
    .leftJoin(g, and(eq(g.profileId, h.profileId), eq(g.amazonAdGroupId, h.amazonAdGroupId)))
    .leftJoin(t, and(eq(t.profileId, h.profileId), eq(t.amazonTargetId, h.amazonTargetId)))
    .leftJoin(users, eq(users.id, h.createdBy))
    .where(
      and(
        inArray(h.profileId, scope.ids),
        input.profileId ? eq(h.profileId, input.profileId) : undefined,
      ),
    )
    .orderBy(desc(h.createdAt), asc(h.termKey))
    .limit(HARVEST_MARK_LIST_LIMIT);
  return rows.map((row) => ({ ...row, expression: row.expression ?? null }));
}

/**
 * Vorgemerkte Begriffe eines Profils in Vergleichsform (für die Kennzeichnung in der Analyse). Das Profil hat der
 * Aufrufer über den Access-Layer geprüft.
 */
export async function listMarkedHarvestTermKeys(
  db: DbOrTx,
  profileId: string,
): Promise<Set<string>> {
  const rows = await db.select({ termKey: h.termKey }).from(h).where(eq(h.profileId, profileId));
  return new Set(rows.map((row) => row.termKey));
}

/**
 * Entfernt genannte Einträge sichtbarer Profile von der Merkliste; Audit `search_term_harvest.remove`, wenn etwas
 * entfernt wurde. Liefert die Zahl der entfernten Einträge, `null` für Nicht-Mitglieder.
 */
export async function removeHarvestMarks(
  db: Db,
  input: HarvestAccessInput & { ids: readonly string[] },
): Promise<number | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  return db.transaction(async (tx) => {
    const removed: { profileId: string; organizationId: string }[] = [];
    for (const part of chunks([...new Set(input.ids)])) {
      removed.push(
        ...(await tx
          .delete(h)
          .where(and(inArray(h.id, part), inArray(h.profileId, scope.ids)))
          .returning({ profileId: h.profileId, organizationId: h.organizationId })),
      );
    }
    if (removed.length > 0) {
      await recordAuditEvent(tx, {
        organizationId: removed[0]!.organizationId,
        actorUserId: input.userId,
        action: 'search_term_harvest.remove',
        target: {
          type: 'search_term_harvest',
          id: input.orgId,
          removed: removed.length,
          profileIds: [...new Set(removed.map((row) => row.profileId))].sort(),
        },
      });
    }
    return removed.length;
  });
}

/**
 * Einträge der Merkliste eines Profils als Eingang des Kampagnen-Setups (`docs/tasks/phase-4.md` 4.6), optional nur
 * die genannten: Quelle mit Namen (`null`, wenn Kampagne bzw. Ad Group im Profil fehlen), Keyword-Target der Quelle,
 * Klicks und Kosten zum Zeitpunkt des Vormerkens und ob der Begriff in der Ad Group der Quelle schon negativ exakt
 * ist. Systemzugriff: Das Profil hat der Aufrufer über den Access-Layer geprüft.
 */
export async function loadHarvestMarkSources(
  db: DbOrTx,
  input: { profileId: string; markIds?: readonly string[] },
): Promise<HarvestMarkSource[]> {
  if (input.markIds !== undefined && input.markIds.length === 0) return [];
  const c = amazonAdsCampaigns;
  const g = amazonAdsAdGroups;
  const t = amazonAdsTargets;
  const n = amazonAdsNegativeTargets;
  const rows = await db
    .select({
      id: h.id,
      searchTerm: h.searchTerm,
      termKey: h.termKey,
      adProduct: h.adProduct,
      amazonCampaignId: h.amazonCampaignId,
      amazonAdGroupId: h.amazonAdGroupId,
      campaignId: c.id,
      campaignName: c.name,
      adGroupId: g.id,
      adGroupName: g.name,
      keywordText: t.keywordText,
      matchType: t.matchType,
      clicks: h.clicks,
      cost: h.cost,
      currencyCode: h.currencyCode,
    })
    .from(h)
    .leftJoin(
      c,
      and(
        eq(c.profileId, h.profileId),
        eq(c.amazonCampaignId, h.amazonCampaignId),
        isNull(c.removedAt),
      ),
    )
    .leftJoin(
      g,
      and(
        eq(g.profileId, h.profileId),
        eq(g.amazonAdGroupId, h.amazonAdGroupId),
        eq(g.campaignId, c.id),
        isNull(g.removedAt),
      ),
    )
    .leftJoin(
      t,
      and(
        eq(t.profileId, h.profileId),
        eq(t.amazonTargetId, h.amazonTargetId),
        eq(t.adGroupId, g.id),
      ),
    )
    .where(
      and(
        eq(h.profileId, input.profileId),
        input.markIds ? inArray(h.id, [...input.markIds]) : undefined,
      ),
    )
    .orderBy(desc(h.createdAt), asc(h.termKey))
    .limit(HARVEST_MARK_LIST_LIMIT);

  // Negatives exakt der Quell-Ad-Groups und ihrer Kampagnen (Keywords in Vergleichsform, ASINs klein).
  const sources = rows.flatMap((row) =>
    row.adGroupId && row.campaignId
      ? [{ adGroupId: row.adGroupId, campaignId: row.campaignId }]
      : [],
  );
  const negated = new Set<string>();
  for (const part of chunks(sources)) {
    const negatives = await db
      .select({
        level: n.level,
        campaignId: n.campaignId,
        adGroupId: n.adGroupId,
        targetType: n.targetType,
        keywordText: n.keywordText,
        asin: sql<string | null>`upper(${n.expression}->>'asin')`,
      })
      .from(n)
      .where(
        and(
          or(
            and(
              eq(n.level, 'ad_group'),
              inArray(n.adGroupId, [...new Set(part.map((source) => source.adGroupId))]),
            ),
            and(
              eq(n.level, 'campaign'),
              inArray(n.campaignId, [...new Set(part.map((source) => source.campaignId))]),
            ),
          ),
          isNull(n.removedAt),
          sql`(${n.targetType} = 'product' or upper(${n.matchType}) = 'EXACT')`,
        ),
      );
    for (const negative of negatives) {
      const value =
        negative.targetType === 'keyword'
          ? comparableSearchTerm(negative.keywordText ?? '')
          : (negative.asin ?? '').toLowerCase();
      negated.add(
        negative.level === 'campaign'
          ? `c:${negative.campaignId}:${value}`
          : `g:${negative.adGroupId}:${value}`,
      );
    }
  }

  return rows.map((row) => ({
    id: row.id,
    searchTerm: row.searchTerm,
    adProduct: row.adProduct,
    amazonCampaignId: row.amazonCampaignId,
    amazonAdGroupId: row.amazonAdGroupId,
    campaignName: row.adGroupId ? row.campaignName : null,
    adGroupName: row.adGroupName,
    sourceKeyword:
      row.keywordText !== null && row.matchType !== null
        ? { text: row.keywordText, matchType: row.matchType }
        : null,
    clicks: row.clicks,
    cost: row.cost,
    currencyCode: row.currencyCode,
    alreadyNegative:
      row.adGroupId !== null &&
      (negated.has(`g:${row.adGroupId}:${row.termKey}`) ||
        negated.has(`c:${row.campaignId}:${row.termKey}`)),
  }));
}
