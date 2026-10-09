import { comparableSearchTerm } from '@profitbash/engine';
import type { CampaignSetupItemEntity, CampaignSetupItemPayload } from '@profitbash/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { visibleProfilesScope } from './access';
import { loadAdChangeSubmissionSummaries, type AdChangeSubmissionSummary } from './ad-changes';
import { recordAuditEvent, type DbOrTx } from './audit';
import type { Db } from './client';
import {
  adChangeSubmissions,
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsProductAds,
  amazonAdsProfiles,
  amazonAdsTargets,
  campaignSetupDrafts,
  campaignSetupItems,
  searchTermHarvestMarks,
} from './schema';

/**
 * Ablauf einer Setup-Übermittlung (`docs/tasks/phase-4.md` 4.4): Zeilen für Bulk-Datei und Job lesen, Ergebnisse
 * festhalten und die Anlagen nach dem nächsten Bulk-Import zuordnen. Den Status der Übermittlung setzt wie bei
 * Änderungen `closeAdChangeSubmission` (zählt offene Anlagen mit).
 */

export interface CampaignSetupItemRow {
  id: string;
  submissionId: string;
  position: number;
  entityType: CampaignSetupItemEntity;
  campaignRef: string;
  adGroupRef: string | null;
  payload: CampaignSetupItemPayload;
  status: string;
  amazonEntityId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

const i = campaignSetupItems;
const itemColumns = {
  id: i.id,
  submissionId: i.submissionId,
  position: i.position,
  entityType: i.entityType,
  campaignRef: i.campaignRef,
  adGroupRef: i.adGroupRef,
  payload: i.payload,
  status: i.status,
  amazonEntityId: i.amazonEntityId,
  errorCode: i.errorCode,
  errorMessage: i.errorMessage,
};
const asRows = (rows: (Omit<CampaignSetupItemRow, 'entityType'> & { entityType: string })[]) =>
  rows as CampaignSetupItemRow[];

/** Zeilen einer Übermittlung in der Reihenfolge der Anlage (Job, Bulk-Datei). */
export async function loadCampaignSetupItems(
  db: DbOrTx,
  submissionId: string,
): Promise<CampaignSetupItemRow[]> {
  return asRows(
    await db
      .select(itemColumns)
      .from(i)
      .where(eq(i.submissionId, submissionId))
      .orderBy(i.position),
  );
}

/**
 * Eine sichtbare Setup-Übermittlung mit Profil und Zeilen; `null`, wenn der Nutzer sie nicht sehen darf, sie nicht
 * existiert oder keine Setup-Übermittlung ist.
 */
export async function getCampaignSetupSubmissionItems(
  db: Db,
  input: { userId: string; orgId: string; submissionId: string },
): Promise<{
  submission: AdChangeSubmissionSummary;
  profile: { countryCode: string; timezone: string; accountType: string };
  items: CampaignSetupItemRow[];
} | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const [submission] = await loadAdChangeSubmissionSummaries(
    db,
    and(
      eq(adChangeSubmissions.id, input.submissionId),
      eq(adChangeSubmissions.kind, 'setup'),
      inArray(adChangeSubmissions.profileId, scope.ids),
    ),
  );
  if (!submission) return null;
  const [profile] = await db
    .select({
      countryCode: amazonAdsProfiles.countryCode,
      timezone: amazonAdsProfiles.timezone,
      accountType: amazonAdsProfiles.accountType,
    })
    .from(amazonAdsProfiles)
    .where(eq(amazonAdsProfiles.id, submission.profileId));
  return { submission, profile: profile!, items: await loadCampaignSetupItems(db, submission.id) };
}

/**
 * Zeilen und Profil einer Setup-Übermittlung für den Job (Systemzugriff, an die Organisation gebunden); `null`, wenn
 * es keine Setup-Übermittlung der Organisation ist.
 */
export async function loadCampaignSetupJob(
  db: DbOrTx,
  input: { organizationId: string; submissionId: string },
): Promise<{
  profile: { countryCode: string; timezone: string; accountType: string };
  items: CampaignSetupItemRow[];
} | null> {
  const [found] = await db
    .select({
      countryCode: amazonAdsProfiles.countryCode,
      timezone: amazonAdsProfiles.timezone,
      accountType: amazonAdsProfiles.accountType,
    })
    .from(adChangeSubmissions)
    .innerJoin(amazonAdsProfiles, eq(amazonAdsProfiles.id, adChangeSubmissions.profileId))
    .where(
      and(
        eq(adChangeSubmissions.id, input.submissionId),
        eq(adChangeSubmissions.organizationId, input.organizationId),
        eq(adChangeSubmissions.kind, 'setup'),
      ),
    );
  if (!found) return null;
  return { profile: found, items: await loadCampaignSetupItems(db, input.submissionId) };
}

export type CampaignSetupResult = { itemId: string } & (
  | { outcome: 'applied'; amazonEntityId: string | null }
  | { outcome: 'failed'; code: string; message: string }
);

/**
 * Ergebnis je Zeile (Job über die API, übersprungene Zeilen der Bulk-Datei). Nur Zeilen der Übermittlung, die noch
 * offen sind; die Organisation bindet den Systemzugriff.
 */
export async function recordCampaignSetupResults(
  db: DbOrTx,
  input: {
    organizationId: string;
    submissionId: string;
    now: Date;
    results: readonly CampaignSetupResult[];
  },
): Promise<void> {
  if (input.results.length === 0) return;
  // In einer Transaktion: Kampagne und ihre Gebotsanpassungen haben immer dasselbe Ergebnis.
  await db.transaction(async (tx) => {
    for (const result of input.results) {
      await tx
        .update(i)
        .set(
          result.outcome === 'applied'
            ? { status: 'applied', amazonEntityId: result.amazonEntityId, resolvedAt: input.now }
            : {
                status: 'failed',
                errorCode: result.code,
                errorMessage: result.message,
                resolvedAt: input.now,
              },
        )
        .where(
          and(
            eq(i.id, result.itemId),
            eq(i.submissionId, input.submissionId),
            eq(i.organizationId, input.organizationId),
            eq(i.status, 'submitted'),
          ),
        );
    }
  });
}

// ---------------------------------------------------------------------------
// Bestätigung durch den Bulk-Import
// ---------------------------------------------------------------------------

const lower = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();
const PLACEMENTS: Record<string, string> = {
  PLACEMENT_TOP: 'PLACEMENT_TOP',
  PLACEMENT_PRODUCT_PAGE: 'PLACEMENT_PRODUCT_PAGE',
  PLACEMENT_REST_OF_SEARCH: 'PLACEMENT_REST_OF_SEARCH',
};

/**
 * Ordnet offene Anlagen von Setup-Übermittlungen per Bulk-Datei den Entities zu, die der Import inzwischen kennt
 * (in dessen Transaktion): Kampagne über den Namen im Profil (ohne Groß/Klein, nicht entfernt), Ad Group über den
 * Namen in der Kampagne, darunter Anzeige (SKU bzw. ASIN), Keyword (Text und Match-Typ), Produkt-Target (ASIN bzw.
 * „ähnlich wie“), Kategorie und Negatives (Text bzw. ASIN). Gebotsanpassungen gelten als angelegt, wenn die Kampagne
 * den Prozentsatz zeigt. Bestätigte Zeilen tragen danach die echte Amazon-ID; der Rest bleibt offen. Liefert die
 * Zahl der bestätigten Zeilen und die betroffenen Übermittlungen.
 */
export async function confirmCampaignSetupItems(
  tx: DbOrTx,
  input: { organizationId: string; profileId: string; now: Date },
): Promise<number> {
  // Offene Setups per Bulk-Datei und solche mit angelegten Zeilen ohne ID (von Hand als hochgeladen abgeschlossen).
  const s = adChangeSubmissions;
  const unresolved = and(
    eq(i.status, 'applied'),
    isNull(i.amazonEntityId),
    sql`${i.entityType} <> 'placement'`,
  );
  const submissions = await tx
    .select({ id: s.id })
    .from(s)
    .where(
      and(
        eq(s.organizationId, input.organizationId),
        eq(s.profileId, input.profileId),
        eq(s.kind, 'setup'),
        eq(s.channel, 'bulk_file'),
        sql`(${s.status} in ('pending', 'running') or exists (select 1 from ${i} where ${i.submissionId} = ${s.id} and ${i.profileId} = ${input.profileId} and ${unresolved}))`,
      ),
    );
  if (submissions.length === 0) return 0;
  const rows = asRows(
    await tx
      .select(itemColumns)
      .from(i)
      .where(
        and(
          inArray(
            i.submissionId,
            submissions.map((submission) => submission.id),
          ),
          inArray(i.status, ['submitted', 'applied']),
        ),
      )
      .orderBy(i.submissionId, i.position)
      .for('update'),
  );
  /** Zeile ohne Ergebnis bzw. angelegt, aber noch ohne echte ID. */
  const pending = (row: CampaignSetupItemRow) =>
    row.status === 'submitted' ||
    (row.status === 'applied' && row.amazonEntityId === null && row.entityType !== 'placement');
  if (!rows.some(pending)) return 0;

  const profile = eq(amazonAdsCampaigns.profileId, input.profileId);
  const campaigns = await tx
    .select({
      id: amazonAdsCampaigns.id,
      amazonId: amazonAdsCampaigns.amazonCampaignId,
      name: amazonAdsCampaigns.name,
      extra: amazonAdsCampaigns.extra,
    })
    .from(amazonAdsCampaigns)
    .where(and(profile, isNull(amazonAdsCampaigns.removedAt)));
  const campaignByName = new Map(campaigns.map((campaign) => [lower(campaign.name), campaign]));
  const campaignByAmazonId = new Map(campaigns.map((campaign) => [campaign.amazonId, campaign]));

  let confirmed = 0;
  const apply = async (row: CampaignSetupItemRow, amazonEntityId: string | null) => {
    row.status = 'applied';
    row.amazonEntityId = amazonEntityId;
    confirmed += 1;
    await tx
      .update(i)
      .set({ status: 'applied', amazonEntityId, resolvedAt: input.now })
      .where(eq(i.id, row.id));
  };

  // Je Übermittlung: Kampagnen und Ad Groups zuerst (die Zeilen sind nach Position sortiert, Eltern vorn).
  const campaignOf = new Map<string, (typeof campaigns)[number]>();
  const adGroupOf = new Map<string, { id: string; amazonId: string }>();
  const key = (row: CampaignSetupItemRow, ref: string | null) =>
    `${row.submissionId}:${lower(row.campaignRef)}:${lower(ref)}`;
  for (const row of rows) {
    const campaignKey = key(row, null);
    const payload = row.payload;
    if (payload.entity === 'source_negative') {
      // Negativ in der Quelle (4.6): bestehende Ad Group über ihre echte ID.
      if (!pending(row)) continue;
      const [adGroup] = await tx
        .select({ id: amazonAdsAdGroups.id })
        .from(amazonAdsAdGroups)
        .where(
          and(
            eq(amazonAdsAdGroups.profileId, input.profileId),
            eq(amazonAdsAdGroups.amazonAdGroupId, payload.amazonAdGroupId),
            isNull(amazonAdsAdGroups.removedAt),
          ),
        )
        .limit(1);
      if (!adGroup) continue;
      const negative = payload.negative;
      const found = await findChild(
        tx,
        adGroup.id,
        negative.type === 'keyword'
          ? { entity: 'negative_keyword', text: negative.text, matchType: negative.matchType }
          : { entity: 'negative_product_target', asin: negative.asin },
      );
      if (found !== null) await apply(row, found);
      continue;
    }
    if (payload.entity === 'campaign') {
      const campaign =
        row.status === 'applied' && row.amazonEntityId !== null
          ? campaignByAmazonId.get(row.amazonEntityId)
          : campaignByName.get(lower(payload.name));
      if (!campaign) continue;
      campaignOf.set(campaignKey, campaign);
      if (pending(row)) await apply(row, campaign.amazonId);
      continue;
    }
    const campaign = campaignOf.get(campaignKey);
    // Angelegte Ad Groups braucht die Zuordnung ihrer Kinder; andere erledigte Zeilen bleiben, wie sie sind.
    if (!campaign || (!pending(row) && payload.entity !== 'ad_group')) continue;

    if (payload.entity === 'placement') {
      const adjustments = (campaign.extra as { placementBidAdjustments?: unknown })
        .placementBidAdjustments;
      const shown = Array.isArray(adjustments)
        ? adjustments.some(
            (entry: { placement?: unknown; percentage?: unknown }) =>
              entry.placement === PLACEMENTS[payload.placement] &&
              Number(entry.percentage) === payload.percentage,
          )
        : false;
      if (shown) await apply(row, null);
      continue;
    }
    if (payload.entity === 'ad_group') {
      const [adGroup] = await tx
        .select({ id: amazonAdsAdGroups.id, amazonId: amazonAdsAdGroups.amazonAdGroupId })
        .from(amazonAdsAdGroups)
        .where(
          and(
            eq(amazonAdsAdGroups.campaignId, campaign.id),
            row.status === 'applied' && row.amazonEntityId !== null
              ? eq(amazonAdsAdGroups.amazonAdGroupId, row.amazonEntityId)
              : sql`lower(${amazonAdsAdGroups.name}) = ${lower(payload.name)}`,
            isNull(amazonAdsAdGroups.removedAt),
          ),
        )
        .limit(1);
      if (!adGroup) continue;
      adGroupOf.set(key(row, row.adGroupRef), adGroup);
      if (pending(row)) await apply(row, adGroup.amazonId);
      continue;
    }

    const adGroup = adGroupOf.get(key(row, row.adGroupRef));
    if (!adGroup) continue;
    const found = await findChild(tx, adGroup.id, payload);
    if (found !== null) await apply(row, found);
  }
  return confirmed;
}

/**
 * Nimmt die Harvest-Begriffe eines Setups von der Merkliste, sobald seine Übermittlung abgeschlossen ist (4.6, F7):
 * Einträge, die der Entwurf von der Merkliste übernommen hat und deren Keyword bzw. Produkt-Ziel angelegt wurde
 * (in der Transaktion des Abschlusses). Nicht angelegte Begriffe bleiben vorgemerkt. Audit
 * `search_term_harvest.remove` ohne Nutzer (Abschluss der Übermittlung). Liefert die Zahl der entfernten Einträge.
 */
export async function releaseHarvestMarks(
  tx: DbOrTx,
  input: { submissionId: string },
): Promise<number> {
  const d = campaignSetupDrafts;
  const [draft] = await tx
    .select({ organizationId: d.organizationId, profileId: d.profileId, inputs: d.inputs })
    .from(d)
    .where(eq(d.submissionId, input.submissionId));
  const markIds = [...new Set((draft?.inputs.harvest ?? []).map((entry) => entry.markId))];
  if (!draft || markIds.length === 0) return 0;
  const applied = await tx
    .select({ payload: i.payload })
    .from(i)
    .where(
      and(
        eq(i.submissionId, input.submissionId),
        eq(i.status, 'applied'),
        inArray(i.entityType, ['keyword', 'product_target']),
      ),
    );
  const terms = new Set<string>();
  for (const { payload } of applied) {
    if (payload.entity === 'keyword') terms.add(comparableSearchTerm(payload.text));
    if (payload.entity === 'product_target' && payload.expression.type !== 'category')
      terms.add(payload.expression.value.toLowerCase());
  }
  if (terms.size === 0) return 0;
  const h = searchTermHarvestMarks;
  const removed = await tx
    .delete(h)
    .where(
      and(inArray(h.id, markIds), eq(h.profileId, draft.profileId), inArray(h.termKey, [...terms])),
    )
    .returning({ id: h.id });
  if (removed.length > 0) {
    await recordAuditEvent(tx, {
      organizationId: draft.organizationId,
      actorUserId: null,
      action: 'search_term_harvest.remove',
      target: {
        type: 'search_term_harvest',
        id: draft.profileId,
        profileId: draft.profileId,
        removed: removed.length,
        submissionId: input.submissionId,
      },
    });
  }
  return removed.length;
}

/** Amazon-ID der passenden Entity in der Ad Group, sonst `null`. */
async function findChild(
  tx: DbOrTx,
  adGroupId: string,
  payload: CampaignSetupItemPayload,
): Promise<string | null> {
  const t = amazonAdsTargets;
  const n = amazonAdsNegativeTargets;
  const first = async (query: Promise<{ id: string }[]>) => (await query)[0]?.id ?? null;
  switch (payload.entity) {
    case 'product_ad':
      return first(
        tx
          .select({ id: amazonAdsProductAds.amazonAdId })
          .from(amazonAdsProductAds)
          .where(
            and(
              eq(amazonAdsProductAds.adGroupId, adGroupId),
              payload.sku !== null
                ? eq(amazonAdsProductAds.sku, payload.sku)
                : eq(amazonAdsProductAds.asin, payload.asin),
              isNull(amazonAdsProductAds.removedAt),
            ),
          )
          .limit(1),
      );
    case 'keyword':
      return first(
        tx
          .select({ id: t.amazonTargetId })
          .from(t)
          .where(
            and(
              eq(t.adGroupId, adGroupId),
              eq(t.targetType, 'keyword'),
              sql`lower(${t.keywordText}) = ${lower(payload.text)}`,
              eq(t.matchType, payload.matchType.toUpperCase()),
              isNull(t.removedAt),
            ),
          )
          .limit(1),
      );
    case 'product_target': {
      const { type, value } = payload.expression;
      const match =
        type === 'category'
          ? and(eq(t.targetType, 'category'), sql`${t.expression}->>'productCategoryId' = ${value}`)
          : and(
              eq(t.targetType, 'product'),
              sql`upper(${t.expression}->>'asin') = ${value}`,
              sql`${t.expression}->>'matchType' = ${type === 'asin' ? 'PRODUCT_EXACT' : 'PRODUCT_SIMILAR'}`,
            );
      return first(
        tx
          .select({ id: t.amazonTargetId })
          .from(t)
          .where(and(eq(t.adGroupId, adGroupId), match, isNull(t.removedAt)))
          .limit(1),
      );
    }
    case 'negative_keyword':
      return first(
        tx
          .select({ id: n.amazonTargetId })
          .from(n)
          .where(
            and(
              eq(n.adGroupId, adGroupId),
              eq(n.targetType, 'keyword'),
              sql`lower(${n.keywordText}) = ${lower(payload.text)}`,
              eq(n.matchType, payload.matchType === 'negativeExact' ? 'EXACT' : 'PHRASE'),
              isNull(n.removedAt),
            ),
          )
          .limit(1),
      );
    case 'negative_product_target':
      return first(
        tx
          .select({ id: n.amazonTargetId })
          .from(n)
          .where(
            and(
              eq(n.adGroupId, adGroupId),
              eq(n.targetType, 'product'),
              sql`upper(${n.expression}->>'asin') = ${payload.asin}`,
              isNull(n.removedAt),
            ),
          )
          .limit(1),
      );
    default:
      return null;
  }
}
