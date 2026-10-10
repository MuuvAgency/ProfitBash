import {
  AD_CHANGE_PLACEMENTS,
  isAdChangePlacementField,
  type AdChangeEntityType,
  type AdChangeField,
  type AdChangeNegative,
  type AdChangeSubmissionStatus,
  type AdChangeSubmissionKind,
} from '@profitbash/shared';
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import {
  chunks,
  currentValue,
  existingNegativeKey,
  isArchived,
  loadEntities,
  negativeKey,
  sameValue,
  valueColumns,
  type EntitySnapshot,
  type ProfileScope,
} from './ad-change-entities';
import type { DbOrTx } from './audit';
import type { Db } from './client';
import {
  adChangeSubmissions,
  adChanges,
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsPortfolios,
  amazonAdsProductAds,
  amazonAdsProfiles,
  amazonAdsTargets,
  connections,
  campaignSetupItems,
} from './schema';
import { confirmCampaignSetupItems, releaseHarvestMarks } from './campaign-setup-processing';
import { createNotification } from './notifications';

/**
 * Verarbeitung der Übermittlungen (`docs/tasks/phase-3.md` 3.3). Systemzugriff des Jobs `ad-changes-submit` und
 * des Datei-Imports, ohne Nutzerkontext und ohne `audit_events` (nachvollziehbar über `job_runs`), an Organisation
 * und Connection bzw. Profil gebunden. Die Sichtbarkeit für Nutzer regelt weiterhin `ad-changes.ts`.
 *
 * Die Lease der Connection serialisiert die Läufe des Jobs: Findet ein Lauf eine Übermittlung im Status
 * `running`, stammt sie von einem unterbrochenen Lauf.
 */

const OPEN_SUBMISSION_STATUSES = ['pending', 'running'] as const;

/** Ausgang unklar (unterbrochener Lauf, 5xx, Netzwerkfehler): nicht blind wiederholen, erst den Stand prüfen. */
export const AD_CHANGE_UNKNOWN_OUTCOME = 'UNKNOWN_OUTCOME';
/** Nicht an Amazon gesendet (Abbruch, anhaltende Drosselung). */
export const AD_CHANGE_NOT_SENT = 'NOT_SENT';

const INTERRUPTED_MESSAGE =
  'Der Lauf wurde unterbrochen. Ob Amazon die Änderung angewendet hat, ist unklar; nach dem nächsten Sync prüfen.';

/**
 * Sperre je Profil für alles, was offene Übermittlungen per Bulk-Datei **und** Entities desselben Profils in
 * einer Transaktion anfasst (Import mit Bestätigung, Abschließen von Hand). Am Anfang der Transaktion nehmen:
 * Sonst sperrt der Import erst Entities und dann die Übermittlung, das Abschließen umgekehrt (Deadlock).
 */
export async function lockProfileAdChanges(tx: DbOrTx, profileId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`ad_changes_profile:${profileId}`}, 0))`,
  );
}

const INTERRUPTED_CREATE_MESSAGE =
  'Der Lauf wurde unterbrochen. Ob Amazon das Negative angelegt hat, ist unklar; nach dem nächsten Sync prüfen.';

const INTERRUPTED_SETUP_MESSAGE =
  'Der Lauf wurde unterbrochen. Ob Amazon die Entity angelegt hat, ist unklar; nach dem nächsten Sync prüfen.';

// ---------------------------------------------------------------------------
// Abholen
// ---------------------------------------------------------------------------

export interface ClaimedAdChangeSubmission {
  id: string;
  profileId: string;
  amazonProfileId: string;
  /** `changes` | `setup` (Anlagen eines Setup-Entwurfs, 4.4). */
  kind: AdChangeSubmissionKind;
  /** Versuche einschließlich dieses Laufs. */
  attempts: number;
}

/**
 * Holt die älteste offene Übermittlung über die API für ein Profil der Connection ab und setzt sie auf `running`.
 * Eine vom vorigen Lauf unterbrochene Übermittlung wird wieder aufgenommen: Updates und Archivieren gehen erneut
 * raus (gleicher Zielwert), Anlagen ohne Ergebnis scheitern als unklar (sonst entstünden doppelte Negatives).
 */
export async function claimNextAdChangeSubmission(
  db: Db,
  input: {
    organizationId: string;
    connectionId: string;
    jobRunId: string | null;
    now: Date;
    /** In diesem Lauf schon bearbeitet (z. B. gedrosselt zurückgestellt). */
    excludeIds?: readonly string[];
  },
): Promise<ClaimedAdChangeSubmission | null> {
  const s = adChangeSubmissions;
  const p = amazonAdsProfiles;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: s.id,
        profileId: s.profileId,
        status: s.status,
        kind: s.kind,
        attempts: s.attempts,
        amazonProfileId: p.amazonProfileId,
      })
      .from(s)
      .innerJoin(p, and(eq(p.id, s.profileId), eq(p.organizationId, s.organizationId)))
      .where(
        and(
          eq(s.organizationId, input.organizationId),
          eq(p.connectionId, input.connectionId),
          eq(s.channel, 'api'),
          inArray(s.status, [...OPEN_SUBMISSION_STATUSES]),
          input.excludeIds?.length ? notInArray(s.id, [...input.excludeIds]) : undefined,
        ),
      )
      .orderBy(asc(s.createdAt), asc(s.id))
      .limit(1)
      .for('update', { of: s });
    if (!row) return null;
    if (row.amazonProfileId === null) {
      throw new Error('Profil einer Connection ohne Amazon-Profil-ID (verletzt den CHECK).');
    }
    if (row.status === 'running') {
      await tx
        .update(adChanges)
        .set({
          status: 'failed',
          errorCode: AD_CHANGE_UNKNOWN_OUTCOME,
          errorMessage: INTERRUPTED_CREATE_MESSAGE,
          resolvedAt: input.now,
        })
        .where(
          and(
            eq(adChanges.submissionId, row.id),
            eq(adChanges.status, 'submitted'),
            eq(adChanges.operation, 'create'),
          ),
        );
      // Anlagen eines Setups ebenso (ohne Ergebnis ist unklar, ob Amazon sie angelegt hat).
      await tx
        .update(campaignSetupItems)
        .set({
          status: 'failed',
          errorCode: AD_CHANGE_UNKNOWN_OUTCOME,
          errorMessage: INTERRUPTED_SETUP_MESSAGE,
          resolvedAt: input.now,
        })
        .where(
          and(
            eq(campaignSetupItems.submissionId, row.id),
            eq(campaignSetupItems.status, 'submitted'),
          ),
        );
    }
    const attempts = row.attempts + 1;
    await tx
      .update(s)
      .set({
        status: 'running',
        attempts,
        jobRunId: input.jobRunId,
        startedAt: input.now,
        error: null,
      })
      .where(eq(s.id, row.id));
    return {
      id: row.id,
      profileId: row.profileId,
      amazonProfileId: row.amazonProfileId,
      kind: row.kind as AdChangeSubmissionKind,
      attempts,
    };
  });
}

/** Connections mit offenen Übermittlungen über die API (Auslöser nach Absturz oder Deploy). */
export async function listConnectionsWithOpenAdChangeSubmissions(
  db: DbOrTx,
): Promise<Array<{ id: string; organizationId: string }>> {
  return db
    .selectDistinct({ id: connections.id, organizationId: connections.organizationId })
    .from(adChangeSubmissions)
    .innerJoin(
      amazonAdsProfiles,
      and(
        eq(amazonAdsProfiles.id, adChangeSubmissions.profileId),
        eq(amazonAdsProfiles.organizationId, adChangeSubmissions.organizationId),
      ),
    )
    .innerJoin(
      connections,
      and(
        eq(connections.id, amazonAdsProfiles.connectionId),
        eq(connections.organizationId, amazonAdsProfiles.organizationId),
      ),
    )
    .where(
      and(
        eq(adChangeSubmissions.channel, 'api'),
        inArray(adChangeSubmissions.status, [...OPEN_SUBMISSION_STATUSES]),
      ),
    )
    .orderBy(connections.id);
}

// ---------------------------------------------------------------------------
// Änderungen einer Übermittlung für den Job
// ---------------------------------------------------------------------------

/** Eine noch nicht entschiedene Änderung mit dem, was der Schreib-Client braucht. */
export interface AdChangeJobRow {
  id: string;
  operation: 'update' | 'create';
  entityType: AdChangeEntityType;
  entityId: string | null;
  field: AdChangeField | null;
  /** Neuer Wert (Text bzw. Decimal-String); leer beim Anlegen. */
  after: string | null;
  negative: AdChangeNegative | null;
  /** Ad-Typ der Kampagne. */
  adProduct: string;
  amazonCampaignId: string;
  amazonAdGroupId: string | null;
  /** Amazon-ID der geänderten Entity; `null`, wenn sie unbekannt ist, und beim Anlegen. */
  amazonEntityId: string | null;
  targetType: string | null;
  negativeLevel: 'campaign' | 'ad_group' | null;
  entityRemoved: boolean;
  campaignBiddingStrategy: string | null;
  /** `extra.placementBidAdjustments` der Kampagne, ungeprüft. */
  campaignPlacements: unknown;
  /** Für die Kampagnenzeile der Bulk-Datei (3.2b): Zustand, Enddatum (`YYYY-MM-DD`) und Portfolio. */
  campaignState: string | null;
  campaignEndDate: string | null;
  campaignAmazonPortfolioId: string | null;
  /**
   * Sponsored Brands: ob die Kampagne im Blatt „SB Multi Ad Group Campaigns“ der Bulk-Datei steht
   * (`extra.multiAdGroups`, das nur der Bulk-Import an SB-Kampagnen setzt); `null`, wenn die Angabe fehlt.
   */
  campaignMultiAdGroups: boolean | null;
}

interface EntityIdentity {
  amazonId: string;
  removedAt: Date | null;
  targetType?: string | null;
  level?: string;
}

async function loadIdentities(
  tx: DbOrTx,
  profileId: string,
  entityType: AdChangeEntityType,
  ids: readonly string[],
): Promise<Map<string, EntityIdentity>> {
  const found = new Map<string, EntityIdentity>();
  for (const part of chunks([...new Set(ids)])) {
    let rows: Array<EntityIdentity & { id: string }>;
    if (entityType === 'campaign') {
      const c = amazonAdsCampaigns;
      rows = await tx
        .select({ id: c.id, amazonId: c.amazonCampaignId, removedAt: c.removedAt })
        .from(c)
        .where(and(inArray(c.id, part), eq(c.profileId, profileId)));
    } else if (entityType === 'ad_group') {
      const g = amazonAdsAdGroups;
      rows = await tx
        .select({ id: g.id, amazonId: g.amazonAdGroupId, removedAt: g.removedAt })
        .from(g)
        .where(and(inArray(g.id, part), eq(g.profileId, profileId)));
    } else if (entityType === 'target') {
      const t = amazonAdsTargets;
      rows = await tx
        .select({
          id: t.id,
          amazonId: t.amazonTargetId,
          removedAt: t.removedAt,
          targetType: t.targetType,
        })
        .from(t)
        .where(and(inArray(t.id, part), eq(t.profileId, profileId)));
    } else if (entityType === 'product_ad') {
      const a = amazonAdsProductAds;
      rows = await tx
        .select({ id: a.id, amazonId: a.amazonAdId, removedAt: a.removedAt })
        .from(a)
        .where(and(inArray(a.id, part), eq(a.profileId, profileId)));
    } else {
      const n = amazonAdsNegativeTargets;
      rows = await tx
        .select({
          id: n.id,
          amazonId: n.amazonTargetId,
          removedAt: n.removedAt,
          targetType: n.targetType,
          level: n.level,
        })
        .from(n)
        .where(and(inArray(n.id, part), eq(n.profileId, profileId)));
    }
    for (const { id, ...identity } of rows) found.set(id, identity);
  }
  return found;
}

/**
 * Liest die noch offenen Änderungen einer Übermittlung für den Schreib-Client und setzt dabei „vorher“ endgültig
 * auf den Stand der Entity (eine frühere Übermittlung kann ihn seit dem Übermitteln geändert haben; Grundlage
 * für den Revert). Leer für Übermittlungen anderer Organisationen.
 */
export async function prepareAdChangeSubmission(
  db: Db,
  input: { organizationId: string; submissionId: string },
): Promise<AdChangeJobRow[]> {
  return db.transaction(async (tx) => {
    const changes = await tx
      .select()
      .from(adChanges)
      .where(
        and(
          eq(adChanges.submissionId, input.submissionId),
          eq(adChanges.organizationId, input.organizationId),
          eq(adChanges.status, 'submitted'),
        ),
      )
      .orderBy(asc(adChanges.createdAt), asc(adChanges.id))
      .for('update');
    return loadAdChangeJobRows(tx, changes, { finalizeBefore: true });
  });
}

/**
 * Änderungen einer Übermittlung (ein Profil) mit Amazon-IDs und Kampagnenstand. `finalizeBefore` setzt dabei
 * „vorher“ auf den Stand der Entity (nur der Job, unmittelbar vor dem Senden).
 */
export async function loadAdChangeJobRows(
  tx: DbOrTx,
  changes: readonly ChangeRow[],
  options: { finalizeBefore: boolean },
): Promise<AdChangeJobRow[]> {
  {
    if (changes.length === 0) return [];
    const profileId = changes[0]!.profileId;
    const scope: ProfileScope = { ids: [profileId] };

    const idsByType = new Map<AdChangeEntityType, string[]>();
    for (const change of changes) {
      if (change.entityId === null) continue;
      const entityType = change.entityType as AdChangeEntityType;
      const list = idsByType.get(entityType) ?? [];
      list.push(change.entityId);
      idsByType.set(entityType, list);
    }
    const identities = new Map<string, EntityIdentity>();
    const snapshots = new Map<string, EntitySnapshot>();
    for (const [entityType, ids] of idsByType) {
      for (const [id, identity] of await loadIdentities(tx, profileId, entityType, ids)) {
        identities.set(`${entityType}:${id}`, identity);
      }
      for (const [id, snapshot] of await loadEntities(tx, scope, entityType, ids)) {
        snapshots.set(`${entityType}:${id}`, snapshot);
      }
    }

    const campaigns = new Map<
      string,
      {
        amazonCampaignId: string;
        adProduct: string;
        biddingStrategy: string | null;
        extra: Record<string, unknown>;
        state: string | null;
        endDate: string | null;
        amazonPortfolioId: string | null;
      }
    >();
    for (const part of chunks([...new Set(changes.map((change) => change.campaignId))])) {
      const c = amazonAdsCampaigns;
      const rows = await tx
        .select({
          id: c.id,
          amazonCampaignId: c.amazonCampaignId,
          adProduct: c.adProduct,
          biddingStrategy: c.biddingStrategy,
          extra: c.extra,
          state: c.state,
          endDate: c.endDate,
          amazonPortfolioId: amazonAdsPortfolios.amazonPortfolioId,
        })
        .from(c)
        .leftJoin(amazonAdsPortfolios, eq(amazonAdsPortfolios.id, c.portfolioId))
        .where(and(inArray(c.id, part), eq(c.profileId, profileId)));
      for (const { id, ...campaign } of rows) campaigns.set(id, campaign);
    }
    const adGroups = new Map<string, string>();
    const adGroupIds = [...new Set(changes.flatMap((c) => (c.adGroupId ? [c.adGroupId] : [])))];
    for (const part of chunks(adGroupIds)) {
      const g = amazonAdsAdGroups;
      const rows = await tx
        .select({ id: g.id, amazonAdGroupId: g.amazonAdGroupId })
        .from(g)
        .where(and(inArray(g.id, part), eq(g.profileId, profileId)));
      for (const row of rows) adGroups.set(row.id, row.amazonAdGroupId);
    }

    const rows: AdChangeJobRow[] = [];
    for (const change of changes) {
      const entityType = change.entityType as AdChangeEntityType;
      const field = change.field as AdChangeField | null;
      const after = change.newValue ?? change.newAmount;
      const key = `${entityType}:${change.entityId}`;
      const identity = change.entityId === null ? undefined : identities.get(key);
      // Der FK bindet die Kampagne an das Profil der Änderung.
      const campaign = campaigns.get(change.campaignId)!;

      if (
        options.finalizeBefore &&
        change.operation === 'update' &&
        field !== null &&
        after !== null
      ) {
        const current = currentValue(snapshots.get(key), field);
        const before = change.oldValue ?? change.oldAmount;
        if (
          typeof current !== 'string' &&
          // Steht der Stand schon auf dem neuen Wert (ein unterbrochener Lauf hat gewirkt und der Sync lief
          // dazwischen), bleibt das bisherige „vorher“: Sonst ginge der Wert davor für den Revert verloren.
          !sameValue(field, current.value, after) &&
          (before !== current.value || change.currencyCode !== current.currencyCode)
        ) {
          await tx
            .update(adChanges)
            .set({
              ...valueColumns(field, current.value, after),
              currencyCode: current.currencyCode,
            })
            .where(eq(adChanges.id, change.id));
        }
      }

      rows.push({
        id: change.id,
        operation: change.operation as AdChangeJobRow['operation'],
        entityType,
        entityId: change.entityId,
        field,
        after,
        negative: change.payload,
        adProduct: campaign.adProduct,
        amazonCampaignId: campaign.amazonCampaignId,
        amazonAdGroupId:
          change.adGroupId === null ? null : (adGroups.get(change.adGroupId) ?? null),
        amazonEntityId: identity?.amazonId ?? null,
        targetType: identity?.targetType ?? null,
        negativeLevel:
          identity?.level === 'campaign' || identity?.level === 'ad_group' ? identity.level : null,
        entityRemoved: identity ? identity.removedAt !== null : false,
        campaignBiddingStrategy: campaign.biddingStrategy,
        campaignPlacements: campaign.extra.placementBidAdjustments ?? null,
        campaignState: campaign.state,
        campaignEndDate: campaign.endDate,
        campaignAmazonPortfolioId: campaign.amazonPortfolioId,
        campaignMultiAdGroups:
          typeof campaign.extra.multiAdGroups === 'boolean' ? campaign.extra.multiAdGroups : null,
      });
    }
    return rows;
  }
}

// ---------------------------------------------------------------------------
// Ergebnisse festhalten, Entities nachziehen
// ---------------------------------------------------------------------------

export type AdChangeResultInput =
  /** `amazonEntityId`: die von Amazon vergebene ID einer Anlage. */
  | { changeId: string; outcome: 'applied'; amazonEntityId: string | null }
  | { changeId: string; outcome: 'failed'; code: string; message: string };

type ChangeRow = typeof adChanges.$inferSelect;

/**
 * Zieht eine angewendete Änderung in den Entity-Tabellen nach, damit Explorer, Warenkorb („vorher“) und Revert den
 * neuen Stand sehen, bevor der nächste Sync ihn liefert. Kinder einer archivierten Entity bleiben unberührt (der
 * nächste Sync bzw. Import liefert sie).
 */
export async function applyAdChangeToEntity(
  tx: DbOrTx,
  change: ChangeRow,
  amazonEntityId: string | null,
): Promise<void> {
  const { profileId } = change;
  if (change.operation === 'create') {
    const negative = change.payload;
    if (negative === null || amazonEntityId === null) return;
    const [campaign] = await tx
      .select({ adProduct: amazonAdsCampaigns.adProduct })
      .from(amazonAdsCampaigns)
      .where(
        and(
          eq(amazonAdsCampaigns.id, change.campaignId),
          eq(amazonAdsCampaigns.profileId, profileId),
        ),
      );
    if (!campaign) return;
    await tx
      .insert(amazonAdsNegativeTargets)
      .values({
        organizationId: change.organizationId,
        profileId,
        level: change.adGroupId === null ? 'campaign' : 'ad_group',
        campaignId: change.campaignId,
        adGroupId: change.adGroupId,
        amazonTargetId: amazonEntityId,
        adProduct: campaign.adProduct,
        state: 'ENABLED',
        ...(negative.type === 'keyword'
          ? {
              targetType: 'keyword',
              keywordText: negative.keywordText,
              matchType: negative.matchType,
              expression: { matchType: negative.matchType, keyword: negative.keywordText },
            }
          : {
              targetType: 'product',
              matchType: 'PRODUCT_EXACT',
              expression: { matchType: 'PRODUCT_EXACT', asin: negative.asin },
            }),
      })
      .onConflictDoNothing();
    return;
  }

  const field = change.field as AdChangeField | null;
  const entityId = change.entityId;
  if (field === null || entityId === null) return;
  const entityType = change.entityType as AdChangeEntityType;

  if (field === 'state') {
    const table = {
      campaign: amazonAdsCampaigns,
      ad_group: amazonAdsAdGroups,
      target: amazonAdsTargets,
      product_ad: amazonAdsProductAds,
      negative_target: amazonAdsNegativeTargets,
    }[entityType];
    await tx
      .update(table)
      .set({ state: change.newValue! })
      .where(and(eq(table.id, entityId), eq(table.profileId, profileId)));
    return;
  }
  if (field === 'bid') {
    const t = amazonAdsTargets;
    await tx
      .update(t)
      .set({
        bid: change.newAmount,
        bidCurrencyCode: sql`coalesce(${t.bidCurrencyCode}, ${change.currencyCode})`,
      })
      .where(and(eq(t.id, entityId), eq(t.profileId, profileId)));
    return;
  }
  if (field === 'default_bid') {
    const g = amazonAdsAdGroups;
    await tx
      .update(g)
      .set({
        defaultBid: change.newAmount,
        defaultBidCurrencyCode: sql`coalesce(${g.defaultBidCurrencyCode}, ${change.currencyCode})`,
      })
      .where(and(eq(g.id, entityId), eq(g.profileId, profileId)));
    return;
  }
  const c = amazonAdsCampaigns;
  const isCampaign = and(eq(c.id, entityId), eq(c.profileId, profileId));
  if (field === 'budget') {
    await tx
      .update(c)
      .set({
        budgetAmount: change.newAmount,
        budgetCurrencyCode: sql`coalesce(${c.budgetCurrencyCode}, ${change.currencyCode})`,
      })
      .where(isCampaign);
    return;
  }
  if (field === 'bidding_strategy') {
    await tx.update(c).set({ biddingStrategy: change.newValue }).where(isCampaign);
    return;
  }
  if (isAdChangePlacementField(field)) {
    const [campaign] = await tx.select({ extra: c.extra }).from(c).where(isCampaign).for('update');
    if (!campaign) return;
    const placement = AD_CHANGE_PLACEMENTS[field];
    const current: unknown = campaign.extra.placementBidAdjustments;
    const others = (Array.isArray(current) ? (current as unknown[]) : []).filter(
      (entry) =>
        typeof entry !== 'object' ||
        entry === null ||
        (entry as Record<string, unknown>).placement !== placement,
    );
    // Wie der Bulk-Import (1.11d): nach Platzierung sortiert, Prozentsatz als Decimal-String.
    const adjustments = [...others, { placement, percentage: change.newAmount! }].sort((a, b) =>
      String((a as Record<string, unknown>)?.placement ?? '').localeCompare(
        String((b as Record<string, unknown>)?.placement ?? ''),
      ),
    );
    await tx
      .update(c)
      .set({ extra: { ...campaign.extra, placementBidAdjustments: adjustments } })
      .where(isCampaign);
  }
}

/**
 * Hält das Ergebnis je Änderung fest (nur Änderungen dieser Übermittlung, die noch `submitted` sind) und zieht bei
 * Erfolg die Entity-Tabellen nach, alles in einer Transaktion.
 */
export async function recordAdChangeResults(
  db: Db,
  input: {
    organizationId: string;
    submissionId: string;
    now: Date;
    results: readonly AdChangeResultInput[];
  },
): Promise<{ applied: number; failed: number }> {
  const counts = { applied: 0, failed: 0 };
  if (input.results.length === 0) return counts;
  return db.transaction(async (tx) => {
    const rows = new Map<string, ChangeRow>();
    for (const part of chunks(input.results.map((result) => result.changeId))) {
      const found = await tx
        .select()
        .from(adChanges)
        .where(
          and(
            inArray(adChanges.id, part),
            eq(adChanges.submissionId, input.submissionId),
            eq(adChanges.organizationId, input.organizationId),
            eq(adChanges.status, 'submitted'),
          ),
        )
        .for('update');
      for (const row of found) rows.set(row.id, row);
    }
    for (const result of input.results) {
      const row = rows.get(result.changeId);
      if (!row) continue;
      // Jede Änderung höchstens einmal.
      rows.delete(result.changeId);
      if (result.outcome === 'failed') {
        await tx
          .update(adChanges)
          .set({
            status: 'failed',
            errorCode: result.code,
            errorMessage: result.message,
            resolvedAt: input.now,
          })
          .where(eq(adChanges.id, row.id));
        counts.failed += 1;
        continue;
      }
      await tx
        .update(adChanges)
        .set({
          status: 'applied',
          resolvedAt: input.now,
          errorCode: null,
          errorMessage: null,
          ...(row.operation === 'create' && { amazonEntityId: result.amazonEntityId }),
        })
        .where(eq(adChanges.id, row.id));
      await applyAdChangeToEntity(tx, row, result.amazonEntityId);
      counts.applied += 1;
    }
    return counts;
  });
}

// ---------------------------------------------------------------------------
// Abschließen
// ---------------------------------------------------------------------------

export interface AdChangeSubmissionClosed {
  status: AdChangeSubmissionStatus;
  /** Änderungen, die weiter auf ein Ergebnis warten. */
  open: number;
  /** Änderungen, die dieser Aufruf über `failRemaining` hat scheitern lassen. */
  failed: number;
}

/** Setzt den Status der Übermittlung nach dem Stand ihrer Änderungen (in der Transaktion des Aufrufers). */
export async function closeAdChangeSubmission(
  tx: DbOrTx,
  input: {
    submissionId: string;
    now: Date;
    error?: string | undefined;
    failRemaining?: { code: string; message: string } | undefined;
    /** Benachrichtigung beim Abschluss (5.2a); `false`, wenn der Nutzer selbst abschließt. Standard `true`. */
    notify?: boolean;
  },
): Promise<AdChangeSubmissionClosed> {
  const stillSubmitted = and(
    eq(adChanges.submissionId, input.submissionId),
    eq(adChanges.status, 'submitted'),
  );
  // Anlagen eines Setups (`phase-4.md` 4.4) zählen wie Änderungen.
  const setupStillSubmitted = and(
    eq(campaignSetupItems.submissionId, input.submissionId),
    eq(campaignSetupItems.status, 'submitted'),
  );
  let failed = 0;
  if (input.failRemaining) {
    const failure = {
      status: 'failed',
      errorCode: input.failRemaining.code,
      errorMessage: input.failRemaining.message,
      resolvedAt: input.now,
    };
    const rows = await tx
      .update(adChanges)
      .set(failure)
      .where(stillSubmitted)
      .returning({ id: adChanges.id });
    const items = await tx
      .update(campaignSetupItems)
      .set(failure)
      .where(setupStillSubmitted)
      .returning({ id: campaignSetupItems.id });
    failed = rows.length + items.length;
  }
  const [{ changes } = { changes: 0 }] = await tx
    .select({ changes: sql<number>`count(*)::int` })
    .from(adChanges)
    .where(stillSubmitted);
  const [{ items } = { items: 0 }] = await tx
    .select({ items: sql<number>`count(*)::int` })
    .from(campaignSetupItems)
    .where(setupStillSubmitted);
  const open = changes + items;
  const status: AdChangeSubmissionStatus =
    open > 0 ? 'pending' : input.failRemaining ? 'failed' : 'finished';
  await tx
    .update(adChangeSubmissions)
    .set({
      status,
      error: input.error ?? null,
      finishedAt: open > 0 ? null : input.now,
    })
    .where(eq(adChangeSubmissions.id, input.submissionId));
  // Setup abgeschlossen: angelegte Harvest-Begriffe verlassen die Merkliste (`phase-4.md` 4.6, F7).
  if (open === 0) await releaseHarvestMarks(tx, { submissionId: input.submissionId });
  if (open === 0 && input.notify !== false) {
    await notifySubmissionClosed(tx, input.submissionId, status);
  }
  return { status, open, failed };
}

/**
 * Benachrichtigung zum Abschluss (5.2a, Dominik 2026-10-10): Erfolg an den Auslöser, Fehler (gescheitert oder
 * einzelne Änderungen fehlerhaft) an ihn und die Org-Admins. Einmal je Übermittlung (Schlüssel).
 */
async function notifySubmissionClosed(
  tx: DbOrTx,
  submissionId: string,
  status: AdChangeSubmissionStatus,
): Promise<void> {
  const [submission] = await tx
    .select({
      organizationId: adChangeSubmissions.organizationId,
      profileId: adChangeSubmissions.profileId,
      channel: adChangeSubmissions.channel,
      createdBy: adChangeSubmissions.createdBy,
    })
    .from(adChangeSubmissions)
    .where(eq(adChangeSubmissions.id, submissionId));
  if (!submission) return;
  const counts = { applied: 0, failed: 0 };
  for (const table of [adChanges, campaignSetupItems]) {
    const rows = await tx
      .select({ status: table.status, count: sql<number>`count(*)::int` })
      .from(table)
      .where(eq(table.submissionId, submissionId))
      .groupBy(table.status);
    for (const row of rows) {
      if (row.status === 'applied' || row.status === 'failed') counts[row.status] += row.count;
    }
  }
  const failed = status === 'failed' || counts.failed > 0;
  await createNotification(tx, {
    organizationId: submission.organizationId,
    profileId: submission.profileId,
    audience: failed ? 'admins' : 'recipient',
    recipientUserId: submission.createdBy,
    kind: failed ? 'submission_failed' : 'submission_finished',
    severity: failed ? 'error' : 'success',
    params: { ...counts, channel: submission.channel },
    link: '/ads/changes',
    dedupeKey: `submission:${submissionId}`,
  });
}

/**
 * Schließt den Lauf einer Übermittlung ab: `finished`, wenn jede Änderung ein Ergebnis hat; sonst zurück auf
 * `pending` (ein späterer Lauf sendet den Rest, `error` nennt den Grund). Mit `failRemaining` scheitern die noch
 * offenen Änderungen und die Übermittlung als Ganzes (`failed`).
 */
export async function finishAdChangeSubmission(
  db: Db,
  input: {
    organizationId: string;
    submissionId: string;
    now: Date;
    error?: string;
    failRemaining?: { code: string; message: string };
  },
): Promise<AdChangeSubmissionClosed | null> {
  return db.transaction(async (tx) => {
    const [submission] = await tx
      .select({ id: adChangeSubmissions.id })
      .from(adChangeSubmissions)
      .where(
        and(
          eq(adChangeSubmissions.id, input.submissionId),
          eq(adChangeSubmissions.organizationId, input.organizationId),
        ),
      )
      .for('update');
    if (!submission) return null;
    return closeAdChangeSubmission(tx, input);
  });
}

/**
 * Lässt alle offenen Übermittlungen über die API für Profile der Connection scheitern (die Connection muss neu
 * verbunden werden): Sie gingen sonst erst Tage später und unerwartet raus. Liefert die Zahl der Übermittlungen.
 */
export async function failOpenAdChangeSubmissions(
  db: Db,
  input: {
    organizationId: string;
    connectionId: string;
    now: Date;
    error: string;
    code: string;
    message: string;
  },
): Promise<number> {
  const s = adChangeSubmissions;
  const p = amazonAdsProfiles;
  return db.transaction(async (tx) => {
    const open = await tx
      .select({ id: s.id, status: s.status })
      .from(s)
      .innerJoin(p, and(eq(p.id, s.profileId), eq(p.organizationId, s.organizationId)))
      .where(
        and(
          eq(s.organizationId, input.organizationId),
          eq(p.connectionId, input.connectionId),
          eq(s.channel, 'api'),
          inArray(s.status, [...OPEN_SUBMISSION_STATUSES]),
        ),
      )
      .for('update', { of: s });
    for (const submission of open) {
      await closeAdChangeSubmission(tx, {
        submissionId: submission.id,
        now: input.now,
        error: input.error,
        // Eine laufende Übermittlung stammt von einem unterbrochenen Lauf: Was davon schon bei Amazon ankam, ist
        // unklar (kein „nicht gesendet“, sonst legte ein erneuter Versuch ein Negative doppelt an).
        failRemaining:
          submission.status === 'running'
            ? { code: AD_CHANGE_UNKNOWN_OUTCOME, message: INTERRUPTED_MESSAGE }
            : { code: input.code, message: input.message },
      });
    }
    return open.length;
  });
}

// ---------------------------------------------------------------------------
// Bulk-Datei: Bestätigung durch den Import
// ---------------------------------------------------------------------------

/**
 * Bestätigt offene Übermittlungen per Bulk-Datei eines Profils gegen den Stand der Entities, nach einem Import
 * aufzurufen (in dessen Transaktion): Entspricht der Stand dem neuen Wert, gilt die Änderung als angewendet. Ein
 * Archivieren gilt auch als angewendet, wenn die Entity nicht mehr geliefert wird; ein neues Negative, wenn es an
 * der Stelle eines mit demselben Inhalt gibt (dessen Amazon-ID wird übernommen). Übrige Änderungen bleiben offen,
 * bis ein späterer Import sie bestätigt oder der Nutzer die Übermittlung von Hand abschließt.
 */
export async function confirmBulkFileAdChanges(
  db: DbOrTx,
  input: { organizationId: string; profileId: string; now: Date },
): Promise<{ confirmed: number; finished: number }> {
  return db.transaction(async (tx) => {
    const s = adChangeSubmissions;
    const submissions = await tx
      .select({ id: s.id })
      .from(s)
      .where(
        and(
          eq(s.organizationId, input.organizationId),
          eq(s.profileId, input.profileId),
          eq(s.channel, 'bulk_file'),
          inArray(s.status, [...OPEN_SUBMISSION_STATUSES]),
        ),
      )
      .for('update');
    const result = { confirmed: 0, finished: 0 };
    // Anlagen eines Setups, auch aus schon abgeschlossenen Übermittlungen (echte IDs nachtragen).
    result.confirmed += await confirmCampaignSetupItems(tx, input);
    if (submissions.length === 0) return result;

    const changes = await tx
      .select()
      .from(adChanges)
      .where(
        and(
          inArray(
            adChanges.submissionId,
            submissions.map((submission) => submission.id),
          ),
          eq(adChanges.status, 'submitted'),
        ),
      )
      .for('update');
    const scope: ProfileScope = { ids: [input.profileId] };
    const idsByType = new Map<AdChangeEntityType, string[]>();
    for (const change of changes) {
      if (change.entityId === null) continue;
      const entityType = change.entityType as AdChangeEntityType;
      const list = idsByType.get(entityType) ?? [];
      list.push(change.entityId);
      idsByType.set(entityType, list);
    }
    const entities = new Map<string, EntitySnapshot>();
    for (const [entityType, ids] of idsByType) {
      for (const [id, entity] of await loadEntities(tx, scope, entityType, ids)) {
        entities.set(`${entityType}:${id}`, entity);
      }
    }

    for (const change of changes) {
      let amazonEntityId: string | null = null;
      if (change.operation === 'create') {
        amazonEntityId = await findMatchingNegative(tx, change);
        if (amazonEntityId === null) continue;
      } else {
        const field = change.field as AdChangeField;
        const after = (change.newValue ?? change.newAmount)!;
        const entity = entities.get(`${change.entityType}:${change.entityId}`);
        if (!entity) continue;
        if (field === 'state' && after === 'ARCHIVED') {
          if (!isArchived(entity.state) && entity.removedAt === null) continue;
        } else {
          const current = currentValue(entity, field);
          if (typeof current === 'string' || !sameValue(field, current.value, after)) continue;
        }
      }
      await tx
        .update(adChanges)
        .set({
          status: 'applied',
          resolvedAt: input.now,
          ...(amazonEntityId !== null && { amazonEntityId }),
        })
        .where(eq(adChanges.id, change.id));
      result.confirmed += 1;
    }

    if (result.confirmed === 0) return result;
    for (const submission of submissions) {
      const closed = await closeAdChangeSubmission(tx, {
        submissionId: submission.id,
        now: input.now,
      });
      if (closed.status === 'finished') result.finished += 1;
    }
    return result;
  });
}

/** Amazon-ID eines vorhandenen, nicht archivierten Negatives mit demselben Inhalt an derselben Stelle. */
export async function findMatchingNegative(
  tx: DbOrTx,
  change: Pick<ChangeRow, 'campaignId' | 'adGroupId' | 'payload' | 'profileId'>,
): Promise<string | null> {
  if (change.payload === null) return null;
  const n = amazonAdsNegativeTargets;
  const existing = await tx
    .select({
      amazonTargetId: n.amazonTargetId,
      targetType: n.targetType,
      keywordText: n.keywordText,
      matchType: n.matchType,
      asin: sql<string | null>`${n.expression}->>'asin'`,
    })
    .from(n)
    .where(
      and(
        eq(n.profileId, change.profileId),
        eq(n.campaignId, change.campaignId),
        change.adGroupId === null ? isNull(n.adGroupId) : eq(n.adGroupId, change.adGroupId),
        eq(n.targetType, change.payload.type),
        isNull(n.removedAt),
        sql`upper(${n.state}) <> 'ARCHIVED'`,
      ),
    );
  const key = negativeKey(change.payload);
  return existing.find((row) => existingNegativeKey(row) === key)?.amazonTargetId ?? null;
}
