import { tokenizeSearchTerm } from '@profitbash/engine';
import { DEFAULT_SEARCH_TERM_RULES, type SearchTermRulesInput } from '@profitbash/shared';
import { and, asc, desc, eq, inArray, isNull, max, or, sql } from 'drizzle-orm';
import { getOrgRole, visibleProfilesScope } from './access';
import { recordAuditEvent } from './audit';
import type { Db } from './client';
import {
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsProfiles,
  amazonAdsSearchTermPeriodMetrics,
  amazonAdsTargets,
  clients,
  searchTermRules,
} from './schema';

/**
 * Suchbegriff-Analyse (`phase-2b.md` 2b.2): Lesezugriffe von Nutzern auf die Zeitraumsummen der Suchbegriff-Blätter
 * (`amazon_ads_search_term_period_metrics`), nur über `visibleProfilesScope()` (ADR 002). Gelesen wird je Profil und
 * **einem** Datei-Zeitraum: Zeiträume verschiedener Dateien überlappen sich und werden nie addiert. Dazu die Regeln
 * der Einstufung je Organisation (Organisationsdaten wie gespeicherte Ansichten, für alle Mitglieder lesbar).
 */

export interface SearchTermAccessInput {
  userId: string;
  orgId: string;
}

export interface SearchTermPeriodSummary {
  profileId: string;
  accountName: string;
  countryCode: string;
  currencyCode: string;
  clientId: string | null;
  periodStart: string;
  periodEnd: string;
  adProducts: string[];
  /** Zeilen (Suchbegriff je Target) über alle Ad-Typen. */
  rows: number;
  /** Letzter Import in diesen Zeitraum. */
  importedAt: Date;
}

/** Datei-Zeiträume mit Suchbegriffen je sichtbarem Profil: Profile nach Name, je Profil der neueste Zeitraum zuerst. */
export async function listSearchTermPeriods(
  db: Db,
  input: SearchTermAccessInput,
): Promise<SearchTermPeriodSummary[]> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return [];
  const m = amazonAdsSearchTermPeriodMetrics;
  const p = amazonAdsProfiles;
  const rows = await db
    .select({
      profileId: p.id,
      accountName: p.accountName,
      countryCode: p.countryCode,
      currencyCode: p.currencyCode,
      clientId: p.clientId,
      periodStart: m.periodStart,
      periodEnd: m.periodEnd,
      adProducts: sql<string[]>`array_agg(distinct ${m.adProduct} order by ${m.adProduct})`,
      rows: sql<number>`count(*)::int`,
      importedAt: max(m.importedAt),
    })
    .from(m)
    .innerJoin(p, eq(p.id, m.profileId))
    .where(inArray(m.profileId, scope.ids))
    .groupBy(p.id, m.periodStart, m.periodEnd)
    .orderBy(asc(p.accountName), asc(p.id), desc(m.periodEnd), desc(m.periodStart));
  return rows.map((row) => ({ ...row, importedAt: row.importedAt! }));
}

export interface SearchTermPeriodQuery extends SearchTermAccessInput {
  profileId: string;
  /** Genau ein Datei-Zeitraum (`YYYY-MM-DD`, beide Tage eingeschlossen). */
  periodStart: string;
  periodEnd: string;
  adProducts?: readonly string[];
}

export interface SearchTermPeriodRow {
  id: string;
  adProduct: string;
  searchTerm: string;
  amazonCampaignId: string;
  amazonAdGroupId: string;
  amazonTargetId: string;
  /** Interne IDs und Namen; `null`, wenn die Entity im Profil fehlt (die Datei kann eine Teilmenge sein). */
  campaignId: string | null;
  campaignName: string | null;
  adGroupId: string | null;
  adGroupName: string | null;
  targetId: string | null;
  keywordText: string | null;
  matchType: string | null;
  expression: unknown;
  /** Zähler und Beträge als Decimal-Strings, Beträge in der Währung des Profils. */
  impressions: string;
  clicks: string;
  cost: string;
  sales: string;
  purchases: string;
  units: string;
  /** Im Profil gibt es ein exaktes Keyword bzw. Produkt-Target mit diesem Begriff (nicht archiviert, nicht entfernt). */
  alreadyTargeted: boolean;
}

export interface SearchTermPeriodResult {
  profile: {
    id: string;
    accountName: string;
    countryCode: string;
    currencyCode: string;
    clientId: string | null;
  };
  /** Geschützte Begriffe des Clients (leer ohne Client). */
  protectedTerms: string[];
  /** Letzter Import in diesen Zeitraum; `null` ohne Zeilen. */
  importedAt: Date | null;
  /** Alle Zeilen des Zeitraums nach Spend absteigend (Kürzen ist Sache des Aufrufers: N-Gramme brauchen alle). */
  rows: SearchTermPeriodRow[];
}

/**
 * Suchbegriffe eines Profils für genau einen Datei-Zeitraum, über die Amazon-IDs mit Kampagne, Ad Group und Target
 * verbunden (fehlende Entities bleiben `null`). `null`, wenn der Nutzer das Profil nicht sehen darf.
 */
export async function querySearchTermPeriod(
  db: Db,
  input: SearchTermPeriodQuery,
): Promise<SearchTermPeriodResult | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const [profile] = await db
    .select({
      id: amazonAdsProfiles.id,
      accountName: amazonAdsProfiles.accountName,
      countryCode: amazonAdsProfiles.countryCode,
      currencyCode: amazonAdsProfiles.currencyCode,
      clientId: amazonAdsProfiles.clientId,
      protectedTerms: clients.protectedTerms,
    })
    .from(amazonAdsProfiles)
    .leftJoin(clients, eq(clients.id, amazonAdsProfiles.clientId))
    .where(and(eq(amazonAdsProfiles.id, input.profileId), inArray(amazonAdsProfiles.id, scope.ids)))
    .limit(1);
  if (!profile) return null;

  const m = amazonAdsSearchTermPeriodMetrics;
  const c = amazonAdsCampaigns;
  const g = amazonAdsAdGroups;
  const t = amazonAdsTargets;
  const rows = await db
    .select({
      id: m.id,
      adProduct: m.adProduct,
      searchTerm: m.searchTerm,
      amazonCampaignId: m.amazonCampaignId,
      amazonAdGroupId: m.amazonAdGroupId,
      amazonTargetId: m.amazonTargetId,
      campaignId: c.id,
      campaignName: c.name,
      adGroupId: g.id,
      adGroupName: g.name,
      targetId: t.id,
      keywordText: t.keywordText,
      matchType: t.matchType,
      expression: t.expression,
      impressions: sql<string>`${m.impressions}::text`,
      clicks: sql<string>`${m.clicks}::text`,
      cost: m.cost,
      sales: m.sales,
      purchases: sql<string>`${m.purchases}::text`,
      units: sql<string>`${m.units}::text`,
      importedAt: m.importedAt,
    })
    .from(m)
    .leftJoin(c, and(eq(c.profileId, m.profileId), eq(c.amazonCampaignId, m.amazonCampaignId)))
    .leftJoin(g, and(eq(g.profileId, m.profileId), eq(g.amazonAdGroupId, m.amazonAdGroupId)))
    .leftJoin(t, and(eq(t.profileId, m.profileId), eq(t.amazonTargetId, m.amazonTargetId)))
    .where(
      and(
        eq(m.profileId, profile.id),
        inArray(m.profileId, scope.ids),
        eq(m.periodStart, input.periodStart),
        eq(m.periodEnd, input.periodEnd),
        input.adProducts ? inArray(m.adProduct, [...input.adProducts]) : undefined,
      ),
    )
    .orderBy(desc(m.cost), asc(m.searchTerm), asc(m.id));

  const exact = rows.length > 0 ? await exactTargetTerms(db, profile.id) : new Set<string>();
  let importedAt: Date | null = null;
  for (const row of rows) {
    if (importedAt === null || row.importedAt > importedAt) importedAt = row.importedAt;
  }
  const { protectedTerms, ...profileInfo } = profile;
  return {
    profile: profileInfo,
    protectedTerms: protectedTerms ?? [],
    importedAt,
    rows: rows.map(({ importedAt: _importedAt, ...row }) => ({
      ...row,
      expression: row.expression ?? null,
      alreadyTargeted: exact.has(comparableTerm(row.searchTerm)),
    })),
  };
}

/** Vergleichsform eines Begriffs: klein, NFC, Leerraum zusammengefasst (wie die Wörter der N-Gramme). */
const comparableTerm = (term: string) => tokenizeSearchTerm(term).join(' ');

/**
 * Begriffe, die im Profil schon exakt gebucht sind (in Vergleichsform): exakte Keywords und ASINs exakter
 * Produkt-Targets, ohne archivierte und entfernte. Das Profil hat der Aufrufer über den Access-Layer geprüft.
 */
async function exactTargetTerms(db: Db, profileId: string): Promise<Set<string>> {
  const t = amazonAdsTargets;
  const targets = await db
    .select({
      keywordText: t.keywordText,
      asin: sql<string | null>`${t.expression}->>'asin'`,
    })
    .from(t)
    .where(
      and(
        eq(t.profileId, profileId),
        isNull(t.removedAt),
        sql`upper(coalesce(${t.state}, '')) <> 'ARCHIVED'`,
        or(eq(t.matchType, 'EXACT'), eq(t.matchType, 'PRODUCT_EXACT')),
      ),
    );
  const terms = new Set<string>();
  for (const target of targets) {
    const term = target.keywordText ?? target.asin;
    if (term) terms.add(comparableTerm(term));
  }
  return terms;
}

// ---------------------------------------------------------------------------
// Regeln der Einstufung je Organisation
// ---------------------------------------------------------------------------

export interface SearchTermRulesRecord {
  rules: SearchTermRulesInput;
  /** Noch nichts gespeichert: Es gelten die Startwerte. */
  isDefault: boolean;
  updatedAt: Date | null;
}

const ruleColumns = {
  harvestMinPurchases: searchTermRules.harvestMinPurchases,
  harvestMaxAcos: searchTermRules.harvestMaxAcos,
  negateMinClicks: searchTermRules.negateMinClicks,
  negateMinCost: searchTermRules.negateMinCost,
};

/** Regeln der Organisation oder die Startwerte; `null` für Nicht-Mitglieder. */
export async function getSearchTermRules(
  db: Db,
  input: SearchTermAccessInput,
): Promise<SearchTermRulesRecord | null> {
  if ((await getOrgRole(db, input.userId, input.orgId)) === null) return null;
  const [row] = await db
    .select({ ...ruleColumns, updatedAt: searchTermRules.updatedAt })
    .from(searchTermRules)
    .where(eq(searchTermRules.organizationId, input.orgId))
    .limit(1);
  if (!row) return { rules: DEFAULT_SEARCH_TERM_RULES, isDefault: true, updatedAt: null };
  const { updatedAt, ...rules } = row;
  return { rules, isDefault: false, updatedAt };
}

/**
 * Speichert die Regeln der Organisation (Audit `search_term_rules.update` in derselben Transaktion). Das Recht
 * (`write` im Feature `sp-explorer`) prüft die API; `null` für Nicht-Mitglieder.
 */
export async function saveSearchTermRules(
  db: Db,
  input: SearchTermAccessInput & { rules: SearchTermRulesInput },
): Promise<SearchTermRulesRecord | null> {
  if ((await getOrgRole(db, input.userId, input.orgId)) === null) return null;
  const { rules } = input;
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select(ruleColumns)
      .from(searchTermRules)
      .where(eq(searchTermRules.organizationId, input.orgId))
      .for('update');
    const updatedAt = new Date();
    const values = { ...rules, updatedBy: input.userId, updatedAt };
    await tx
      .insert(searchTermRules)
      .values({ organizationId: input.orgId, ...values })
      .onConflictDoUpdate({ target: searchTermRules.organizationId, set: values });
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'search_term_rules.update',
      target: {
        type: 'search_term_rules',
        id: input.orgId,
        before: before ?? null,
        after: rules,
      },
    });
    return { rules, isDefault: false, updatedAt };
  });
}
