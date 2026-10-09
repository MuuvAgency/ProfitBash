import {
  type AdChangeChannel,
  type AdChangeEntityType,
  type AdChangeField,
  type AdChangeInput,
  type AdChangeNegative,
  type AdChangeOrigin,
  type AdChangeRejection,
  type AdChangeStatus,
  type AdChangeSubmissionStatus,
  type AdChangeUpdateInput,
} from '@profitbash/shared';
import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { visibleProfilesScope } from './access';
import {
  checkNegative,
  chunks,
  currentValue,
  loadComparisonBids,
  loadEntities,
  negativeKey,
  resolveAdjustments,
  sameValue,
  valueColumns,
  type EntitySnapshot,
  type ProfileScope,
} from './ad-change-entities';
import { recordAuditEvent, type DbOrTx } from './audit';
import type { Db } from './client';
import {
  adChangeSubmissions,
  adChanges,
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsProductAds,
  amazonAdsProfiles,
  amazonAdsTargets,
  users,
} from './schema';

/**
 * Schreibschicht für Änderungen an Amazon-Werbung (`docs/tasks/phase-3.md` 3.1): Warenkorb je Nutzer (F4),
 * Übermittlung je Profil, Verlauf. Alle Zugriffe laufen über `visibleProfilesScope()` (ADR 002); die Daten gehören
 * der Organisation des Profils. Das Recht (`write` bzw. `view` im Feature `changes`) prüft die API.
 *
 * Den Wert „vorher“ liest immer der Server aus der Entity: beim Vormerken und noch einmal beim Übermitteln.
 * Abholen und Ergebnis durch den Job, erneuter Versuch und Revert folgen mit 3.3.
 */

export interface AdChangeActor {
  userId: string;
  orgId: string;
}

export type AdChangeErrorCode =
  | 'PROFILE_HAS_NO_CONNECTION'
  /** Die Übermittlung ist keine offene Übermittlung per Bulk-Datei (3.3: von Hand abschließen). */
  | 'SUBMISSION_NOT_OPEN'
  /** Eine Bulk-Datei gibt es nur für den Weg `bulk_file`. */
  | 'SUBMISSION_NOT_BULK_FILE';

export class AdChangeError extends Error {
  constructor(
    public readonly code: AdChangeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdChangeError';
  }
}

const p = amazonAdsProfiles;

// ---------------------------------------------------------------------------
// Vormerken
// ---------------------------------------------------------------------------

export type StageAdChangeResult =
  | {
      outcome: 'created' | 'updated';
      changeId: string;
      /** Andere Nutzer mit einer offenen Änderung an derselben Stelle (F4). */
      otherUsers: number;
    }
  /** `removed`: Der Wert entspricht wieder dem Stand der Entity, die vorgemerkte Änderung entfällt. */
  | { outcome: 'removed' | 'unchanged' }
  | { outcome: 'rejected'; reason: AdChangeRejection };

export interface StageAdChangesResult {
  /** Je Eingabe ein Ergebnis, in derselben Reihenfolge. */
  results: StageAdChangeResult[];
  counts: {
    created: number;
    updated: number;
    removed: number;
    unchanged: number;
    rejected: number;
  };
}

export interface StageAdChangesInput extends AdChangeActor {
  origin: Extract<AdChangeOrigin, 'explorer' | 'search_terms'>;
  /** Mit `adChangeInputSchema` geprüft (Feld passt zur Entity, Wert im Wertebereich). */
  changes: readonly AdChangeInput[];
}

const pendingKey = (entityType: string, entityId: string, field: string) =>
  `${entityType}:${entityId}:${field}`;

/**
 * Legt Änderungen in den Warenkorb des Nutzers. Gültige werden übernommen, auch wenn andere derselben Anfrage
 * abgelehnt werden (ein Bulk-Dialog soll an drei archivierten Zeilen nicht scheitern). Je Nutzer, Entity und Feld
 * gibt es eine offene Änderung: Ein neuer Wert ersetzt den vorgemerkten, der Stand der Entity nimmt sie zurück.
 * Nennt eine Anfrage dieselbe Stelle mehrfach, gilt die letzte Angabe (die früheren: `unchanged`). Ein Audit-Event
 * `ad_changes.stage` je Anfrage, wenn sich der Warenkorb geändert hat. `null` für Nicht-Mitglieder.
 */
export async function stageAdChanges(
  db: Db,
  input: StageAdChangesInput,
): Promise<StageAdChangesResult | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;

  return db.transaction(async (tx) => {
    const results: StageAdChangeResult[] = input.changes.map(() => ({ outcome: 'unchanged' }));
    const profileIds = new Set<string>();
    // Anpassungen (±Prozent, ±Betrag) werden zu Feldänderungen mit dem errechneten Wert.
    const { changes, rejected } = await resolveAdjustments(tx, scope, input.changes);
    for (const [index, reason] of rejected) results[index] = { outcome: 'rejected', reason };

    // --- Feldänderungen: je Stelle die letzte Angabe -------------------------------------------
    const lastByKey = new Map<string, number>();
    const idsByType = new Map<AdChangeEntityType, string[]>();
    changes.forEach((change, index) => {
      if (change?.operation !== 'update') return;
      lastByKey.set(pendingKey(change.entityType, change.entityId, change.field), index);
      const list = idsByType.get(change.entityType) ?? [];
      list.push(change.entityId);
      idsByType.set(change.entityType, list);
    });
    const entities = new Map<string, EntitySnapshot>();
    const allEntityIds: string[] = [];
    for (const [entityType, entityIds] of idsByType) {
      for (const [id, entity] of await loadEntities(tx, scope, entityType, entityIds)) {
        entities.set(`${entityType}:${id}`, entity);
        allEntityIds.push(id);
      }
    }

    const ownPending = new Map<string, { id: string; after: string }>();
    const othersPending = new Map<string, number>();
    for (const part of chunks(allEntityIds)) {
      const pending = await tx
        .select({
          id: adChanges.id,
          createdBy: adChanges.createdBy,
          entityType: adChanges.entityType,
          entityId: adChanges.entityId,
          field: adChanges.field,
          newValue: adChanges.newValue,
          newAmount: adChanges.newAmount,
        })
        .from(adChanges)
        .where(
          and(
            eq(adChanges.status, 'pending'),
            eq(adChanges.operation, 'update'),
            inArray(adChanges.entityId, part),
          ),
        );
      for (const row of pending) {
        const key = pendingKey(row.entityType, row.entityId!, row.field!);
        if (row.createdBy === input.userId) {
          ownPending.set(key, { id: row.id, after: (row.newValue ?? row.newAmount)! });
        } else if (row.createdBy !== null) {
          othersPending.set(key, (othersPending.get(key) ?? 0) + 1);
        }
      }
    }

    const toDelete: { index: number; id: string; profileId: string }[] = [];
    const toUpsert: { index: number; key: string; values: typeof adChanges.$inferInsert }[] = [];
    for (const index of lastByKey.values()) {
      const change = changes[index] as AdChangeUpdateInput;
      const key = pendingKey(change.entityType, change.entityId, change.field);
      const entity = entities.get(`${change.entityType}:${change.entityId}`);
      const current = currentValue(entity, change.field);
      if (typeof current === 'string') {
        results[index] = { outcome: 'rejected', reason: current };
        continue;
      }
      const existing = ownPending.get(key);
      if (sameValue(change.field, current.value, change.value)) {
        if (existing) toDelete.push({ index, id: existing.id, profileId: entity!.profileId });
        continue;
      }
      if (existing && sameValue(change.field, existing.after, change.value)) continue;
      toUpsert.push({
        index,
        key,
        values: {
          organizationId: entity!.organizationId,
          profileId: entity!.profileId,
          origin: input.origin,
          operation: 'update',
          entityType: change.entityType,
          entityId: change.entityId,
          campaignId: entity!.campaignId,
          adGroupId: change.entityType === 'campaign' ? null : entity!.adGroupId,
          field: change.field,
          ...valueColumns(change.field, current.value, change.value),
          currencyCode: current.currencyCode,
          createdBy: input.userId,
        },
      });
    }

    // Nur, was noch offen ist: Eine gleichzeitige Übermittlung kann die Änderung inzwischen übernommen haben, und
    // übermittelte Änderungen sind Verlauf (nie löschen).
    for (const part of chunks(toDelete)) {
      const deleted = await tx
        .delete(adChanges)
        .where(
          and(
            inArray(
              adChanges.id,
              part.map((item) => item.id),
            ),
            eq(adChanges.status, 'pending'),
            eq(adChanges.createdBy, input.userId),
          ),
        )
        .returning({ id: adChanges.id });
      const deletedIds = new Set(deleted.map((row) => row.id));
      for (const item of part) {
        if (!deletedIds.has(item.id)) continue;
        results[item.index] = { outcome: 'removed' };
        profileIds.add(item.profileId);
      }
    }
    // 500 Zeilen je Anweisung: rund 15 Parameter je Zeile.
    for (const part of chunks(toUpsert, 500)) {
      const rows = await tx
        .insert(adChanges)
        .values(part.map((item) => item.values))
        .onConflictDoUpdate({
          target: [adChanges.createdBy, adChanges.entityType, adChanges.entityId, adChanges.field],
          targetWhere: sql`${adChanges.status} = 'pending' and ${adChanges.operation} = 'update'`,
          set: {
            origin: sql`excluded.origin`,
            oldValue: sql`excluded.old_value`,
            newValue: sql`excluded.new_value`,
            oldAmount: sql`excluded.old_amount`,
            newAmount: sql`excluded.new_amount`,
            currencyCode: sql`excluded.currency_code`,
            updatedAt: new Date(),
          },
        })
        .returning({
          id: adChanges.id,
          entityType: adChanges.entityType,
          entityId: adChanges.entityId,
          field: adChanges.field,
          // Neu eingefügt oder vorhandene offene Änderung ersetzt (verlässlich auch bei gleichzeitigen Anfragen).
          inserted: sql<boolean>`(xmax = 0)`,
        });
      const rowByKey = new Map(
        rows.map((row) => [pendingKey(row.entityType, row.entityId!, row.field!), row]),
      );
      for (const item of part) {
        const row = rowByKey.get(item.key)!;
        results[item.index] = {
          outcome: row.inserted ? 'created' : 'updated',
          changeId: row.id,
          otherUsers: othersPending.get(item.key) ?? 0,
        };
        profileIds.add(item.values.profileId);
      }
    }

    // --- Neue Negatives (wenige je Anfrage, deshalb einzeln) -----------------------------------
    for (const [index, change] of changes.entries()) {
      if (change?.operation !== 'create_negative') continue;
      const parent = await checkNegative(tx, scope, change);
      if (typeof parent === 'string') {
        results[index] = { outcome: 'rejected', reason: parent };
        continue;
      }
      // Prüfen und Anlegen je Nutzer und Kampagne nacheinander: Für Anlagen gibt es keinen Unique-Index, zwei
      // gleichzeitige Anfragen legten dasselbe Negative sonst doppelt in den Warenkorb.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ad_changes:${input.userId}:${change.campaignId}`}, 0))`,
      );
      const pending = await tx
        .select({ createdBy: adChanges.createdBy, payload: adChanges.payload })
        .from(adChanges)
        .where(
          and(
            eq(adChanges.status, 'pending'),
            eq(adChanges.operation, 'create'),
            eq(adChanges.campaignId, change.campaignId),
            change.adGroupId === null
              ? isNull(adChanges.adGroupId)
              : eq(adChanges.adGroupId, change.adGroupId),
          ),
        );
      const key = negativeKey(change.negative);
      const same = pending.filter((row) => row.payload && negativeKey(row.payload) === key);
      if (same.some((row) => row.createdBy === input.userId)) continue;
      const [row] = await tx
        .insert(adChanges)
        .values({
          organizationId: parent.organizationId,
          profileId: parent.profileId,
          origin: input.origin,
          operation: 'create',
          entityType: 'negative_target',
          campaignId: change.campaignId,
          adGroupId: change.adGroupId,
          payload: change.negative,
          createdBy: input.userId,
        })
        .returning({ id: adChanges.id });
      results[index] = {
        outcome: 'created',
        changeId: row!.id,
        otherUsers: new Set(same.flatMap((other) => (other.createdBy ? [other.createdBy] : [])))
          .size,
      };
      profileIds.add(parent.profileId);
    }

    const counts = { created: 0, updated: 0, removed: 0, unchanged: 0, rejected: 0 };
    for (const result of results) counts[result.outcome] += 1;
    if (counts.created + counts.updated + counts.removed > 0) {
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'ad_changes.stage',
        target: {
          type: 'ad_changes',
          id: input.orgId,
          origin: input.origin,
          created: counts.created,
          updated: counts.updated,
          removed: counts.removed,
          profileIds: [...profileIds].sort(),
        },
      });
    }
    return { results, counts };
  });
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

export interface AdChangeRecord {
  id: string;
  profileId: string;
  accountName: string;
  countryCode: string;
  /** Ad-Typ der Kampagne. */
  adProduct: string;
  status: AdChangeStatus;
  origin: AdChangeOrigin;
  originChangeId: string | null;
  operation: 'update' | 'create';
  entityType: AdChangeEntityType;
  /** Leer beim Anlegen. */
  entityId: string | null;
  campaignId: string;
  campaignName: string | null;
  adGroupId: string | null;
  adGroupName: string | null;
  field: AdChangeField | null;
  /** Vorher/nachher als Text bzw. Decimal-String; beide leer beim Anlegen. */
  before: string | null;
  after: string | null;
  /** Währung von Beträgen, sonst `null`. */
  currencyCode: string | null;
  /** Das neue Negative beim Anlegen. */
  negative: AdChangeNegative | null;
  /** Angaben zur Anzeige der Entity: Target bzw. Negative oder Product Ad; `null` bei Kampagne, Ad Group, Anlage. */
  entity:
    | {
        targetType: string | null;
        keywordText: string | null;
        matchType: string | null;
        expression: unknown;
      }
    | { asin: string | null; sku: string | null }
    | null;
  submissionId: string | null;
  amazonEntityId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  resolvedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Änderungen mit Profil, Kampagne, Ad Group und Entity; die Bedingung begrenzt der Aufrufer auf sichtbare Profile. */
export async function loadAdChangeRecords(
  db: DbOrTx,
  where: SQL | undefined,
): Promise<AdChangeRecord[]> {
  const a = adChanges;
  const c = amazonAdsCampaigns;
  const g = amazonAdsAdGroups;
  const t = amazonAdsTargets;
  const n = amazonAdsNegativeTargets;
  const ad = amazonAdsProductAds;
  // Flach gelesen: Ein geschachteltes Objekt setzt Drizzle bei einem Left Join auf `null`, sobald sein erstes Feld leer ist.
  const rows = await db
    .select({
      id: a.id,
      profileId: a.profileId,
      accountName: p.accountName,
      countryCode: p.countryCode,
      adProduct: c.adProduct,
      status: a.status,
      origin: a.origin,
      originChangeId: a.originChangeId,
      operation: a.operation,
      entityType: a.entityType,
      entityId: a.entityId,
      campaignId: a.campaignId,
      campaignName: c.name,
      adGroupId: a.adGroupId,
      adGroupName: g.name,
      field: a.field,
      oldValue: a.oldValue,
      newValue: a.newValue,
      oldAmount: a.oldAmount,
      newAmount: a.newAmount,
      currencyCode: a.currencyCode,
      payload: a.payload,
      targetType: sql<string | null>`coalesce(${t.targetType}, ${n.targetType})`,
      keywordText: sql<string | null>`coalesce(${t.keywordText}, ${n.keywordText})`,
      matchType: sql<string | null>`coalesce(${t.matchType}, ${n.matchType})`,
      expression: sql<unknown>`coalesce(${t.expression}, ${n.expression})`,
      asin: ad.asin,
      sku: ad.sku,
      submissionId: a.submissionId,
      amazonEntityId: a.amazonEntityId,
      errorCode: a.errorCode,
      errorMessage: a.errorMessage,
      resolvedAt: a.resolvedAt,
      createdBy: a.createdBy,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    })
    .from(a)
    .innerJoin(p, eq(p.id, a.profileId))
    .innerJoin(c, eq(c.id, a.campaignId))
    .leftJoin(g, eq(g.id, a.adGroupId))
    .leftJoin(t, and(eq(a.entityType, 'target'), eq(t.id, a.entityId)))
    .leftJoin(n, and(eq(a.entityType, 'negative_target'), eq(n.id, a.entityId)))
    .leftJoin(ad, and(eq(a.entityType, 'product_ad'), eq(ad.id, a.entityId)))
    .where(where)
    .orderBy(asc(a.createdAt), asc(a.id));

  return rows.map((row) => {
    const {
      oldValue,
      newValue,
      oldAmount,
      newAmount,
      payload,
      targetType,
      keywordText,
      matchType,
      expression,
      asin,
      sku,
      ...rest
    } = row;
    const entityType = row.entityType as AdChangeEntityType;
    let entity: AdChangeRecord['entity'] = null;
    if (row.entityId !== null && (entityType === 'target' || entityType === 'negative_target')) {
      entity = { targetType, keywordText, matchType, expression: expression ?? null };
    } else if (entityType === 'product_ad') {
      entity = { asin, sku };
    }
    return {
      ...rest,
      status: row.status as AdChangeStatus,
      origin: row.origin as AdChangeOrigin,
      operation: row.operation as AdChangeRecord['operation'],
      entityType,
      field: row.field as AdChangeField | null,
      before: oldValue ?? oldAmount,
      after: newValue ?? newAmount,
      negative: payload,
      entity,
    };
  });
}

export interface PendingAdChange extends AdChangeRecord {
  /** Vergleichswert für die ±50-%-Warnung: Standardgebot der Ad Group bei einem Target ohne eigenes Gebot. */
  comparisonBefore: string | null;
  /** Andere Nutzer mit einer offenen Änderung an derselben Stelle (F4), nach Name. */
  otherUsers: { userId: string; name: string }[];
}

/**
 * Warenkorb des Nutzers: seine offenen Änderungen in sichtbaren Profilen, älteste zuerst. `null` für
 * Nicht-Mitglieder.
 */
export async function listPendingAdChanges(
  db: Db,
  input: AdChangeActor,
): Promise<PendingAdChange[] | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const changes = await loadAdChangeRecords(
    db,
    and(
      eq(adChanges.status, 'pending'),
      eq(adChanges.createdBy, input.userId),
      inArray(adChanges.profileId, scope.ids),
    ),
  );
  if (changes.length === 0) return [];

  const mine = alias(adChanges, 'mine');
  const others = await db
    .select({
      changeId: mine.id,
      userId: users.id,
      name: users.name,
      minePayload: mine.payload,
      otherPayload: adChanges.payload,
    })
    .from(mine)
    .innerJoin(
      adChanges,
      and(
        eq(adChanges.status, 'pending'),
        eq(adChanges.operation, mine.operation),
        eq(adChanges.campaignId, mine.campaignId),
        ne(adChanges.createdBy, input.userId),
        // Feldänderung: dieselbe Entity und dasselbe Feld; Anlage: dieselbe Kampagne und Ad Group (Negative unten).
        sql`${adChanges.entityId} is not distinct from ${mine.entityId}`,
        sql`${adChanges.field} is not distinct from ${mine.field}`,
        sql`${adChanges.adGroupId} is not distinct from ${mine.adGroupId}`,
      ),
    )
    .innerJoin(users, eq(users.id, adChanges.createdBy))
    .where(
      and(
        eq(mine.status, 'pending'),
        eq(mine.createdBy, input.userId),
        inArray(mine.profileId, scope.ids),
      ),
    )
    .orderBy(asc(users.name), asc(users.id));
  const othersByChange = new Map<string, Map<string, string>>();
  for (const row of others) {
    if (
      row.minePayload &&
      (!row.otherPayload || negativeKey(row.minePayload) !== negativeKey(row.otherPayload))
    ) {
      continue;
    }
    const list = othersByChange.get(row.changeId) ?? new Map<string, string>();
    list.set(row.userId, row.name);
    othersByChange.set(row.changeId, list);
  }
  const comparisonBids = await loadComparisonBids(db, changes);
  return changes.map((change) => ({
    ...change,
    comparisonBefore: comparisonBids.get(change.id) ?? null,
    otherUsers: [...(othersByChange.get(change.id) ?? [])].map(([userId, name]) => ({
      userId,
      name,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Verwerfen
// ---------------------------------------------------------------------------

/**
 * Verwirft offene Änderungen aus dem eigenen Warenkorb (sichtbare Profile, wie die Liste): die genannten oder, ohne
 * `changeIds`, alle. Fremde und schon übermittelte Änderungen bleiben unberührt. Audit `ad_changes.discard`. Liefert die Zahl der verworfenen,
 * `null` für Nicht-Mitglieder.
 */
export async function discardPendingAdChanges(
  db: Db,
  input: AdChangeActor & { changeIds?: readonly string[] },
): Promise<number | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  return db.transaction(async (tx) => {
    const own = and(
      inArray(adChanges.profileId, scope.ids),
      eq(adChanges.createdBy, input.userId),
      eq(adChanges.status, 'pending'),
    );
    const deleted: { profileId: string }[] = [];
    if (input.changeIds === undefined) {
      deleted.push(
        ...(await tx.delete(adChanges).where(own).returning({ profileId: adChanges.profileId })),
      );
    } else {
      for (const part of chunks(input.changeIds)) {
        deleted.push(
          ...(await tx
            .delete(adChanges)
            .where(and(own, inArray(adChanges.id, part)))
            .returning({ profileId: adChanges.profileId })),
        );
      }
    }
    if (deleted.length > 0) {
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'ad_changes.discard',
        target: {
          type: 'ad_changes',
          id: input.orgId,
          discarded: deleted.length,
          profileIds: [...new Set(deleted.map((row) => row.profileId))].sort(),
        },
      });
    }
    return deleted.length;
  });
}

// ---------------------------------------------------------------------------
// Übermittlungen
// ---------------------------------------------------------------------------

export interface AdChangeSubmissionSummary {
  id: string;
  profileId: string;
  accountName: string;
  countryCode: string;
  channel: AdChangeChannel;
  status: AdChangeSubmissionStatus;
  /** Grund, wenn die Übermittlung als Ganzes gescheitert ist. */
  error: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Änderungen der Übermittlung, gesamt und je Status. */
  changes: number;
  counts: { submitted: number; applied: number; failed: number; dismissed: number };
}

/** Übermittlungen mit Zählern; die Bedingung begrenzt der Aufrufer auf sichtbare Profile. */
export async function loadAdChangeSubmissionSummaries(
  db: DbOrTx,
  where: SQL | undefined,
  limit?: number,
): Promise<AdChangeSubmissionSummary[]> {
  const s = adChangeSubmissions;
  const count = (status: AdChangeStatus) =>
    sql<number>`count(*) filter (where ${adChanges.status} = ${status})::int`;
  const query = db
    .select({
      id: s.id,
      profileId: s.profileId,
      accountName: p.accountName,
      countryCode: p.countryCode,
      channel: s.channel,
      status: s.status,
      error: s.error,
      createdBy: s.createdBy,
      createdByName: users.name,
      createdAt: s.createdAt,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      changes: sql<number>`count(${adChanges.id})::int`,
      submitted: count('submitted'),
      applied: count('applied'),
      failed: count('failed'),
      dismissed: count('dismissed'),
    })
    .from(s)
    .innerJoin(p, eq(p.id, s.profileId))
    .leftJoin(users, eq(users.id, s.createdBy))
    .leftJoin(adChanges, eq(adChanges.submissionId, s.id))
    .where(where)
    .groupBy(s.id, p.id, users.id)
    .orderBy(desc(s.createdAt), desc(s.id));
  const rows = await (limit === undefined ? query : query.limit(limit));
  return rows.map(({ submitted, applied, failed, dismissed, ...row }) => ({
    ...row,
    channel: row.channel as AdChangeChannel,
    status: row.status as AdChangeSubmissionStatus,
    counts: { submitted, applied, failed, dismissed },
  }));
}

export interface SubmitAdChangesInput extends AdChangeActor {
  channel: AdChangeChannel;
  /** Nur die Änderungen dieses Profils bzw. nur die genannten (sonst der ganze Warenkorb). */
  profileId?: string;
  changeIds?: readonly string[];
  /**
   * Plant die Jobs in derselben Transaktion ein (pg-boss über `tx`). Wird nur für den Weg `api` und nur mit
   * mindestens einer Übermittlung aufgerufen: Bulk-Dateien brauchen keinen Job.
   */
  enqueue: (tx: DbOrTx, submissions: readonly AdChangeSubmissionSummary[]) => Promise<unknown>;
  /**
   * Prüfung unmittelbar vor dem Übermitteln (3.4: Grenzen von Amazon, Warnungen nach F6), in der Transaktion und
   * mit dem neu gelesenen „vorher“, über genau die Änderungen, die übermittelt würden. Liefert sie etwas anderes
   * als `null`, wird nichts übermittelt (alles zurückgerollt) und der Wert kommt als `review` zurück.
   */
  review?: (changes: readonly AdChangeReviewRow[]) => unknown;
}

/** Eine Änderung, wie sie übermittelt würde. */
export interface AdChangeReviewRow {
  id: string;
  profileId: string;
  /** Leer beim Anlegen eines Negatives. */
  field: AdChangeField | null;
  before: string | null;
  /** Vergleichswert für die ±50-%-Warnung: Standardgebot der Ad Group bei einem Target ohne eigenes Gebot. */
  comparisonBefore: string | null;
  after: string | null;
  /** Ad-Typ der Kampagne und Land des Profils. */
  adProduct: string;
  countryCode: string;
  negative: AdChangeNegative | null;
}

/** Bricht die Transaktion ab, wenn die Prüfung etwas meldet. */
class ReviewRejected extends Error {
  constructor(public readonly verdict: unknown) {
    super('Prüfung vor dem Übermitteln hat etwas gemeldet.');
  }
}

export interface SubmitAdChangesResult {
  /** Eine Übermittlung je Profil. */
  submissions: AdChangeSubmissionSummary[];
  /** Entfallen: Der Wert entspricht inzwischen dem Stand der Entity. */
  dropped: number;
  /** Bleiben im Warenkorb, weil sie sich nicht mehr übermitteln lassen. */
  blocked: { changeId: string; reason: AdChangeRejection }[];
  /** Ergebnis von `review`, wenn deshalb nichts übermittelt wurde; sonst `null`. */
  review: unknown;
}

/**
 * Übermittelt den Warenkorb des Nutzers (oder einen Teil): je Profil eine Übermittlung, die Änderungen wechseln von
 * `pending` auf `submitted`. „Vorher“ wird dabei neu aus der Entity gelesen (Grundlage für den Revert). Über die
 * API gehen nur Profile mit Connection: sonst `AdChangeError` `PROFILE_HAS_NO_CONNECTION`, und nichts wird
 * übermittelt. Audit `ad_change_submission.create` je Übermittlung, alles in einer Transaktion mit dem Einplanen.
 * `null` für Nicht-Mitglieder.
 */
export async function submitAdChanges(
  db: Db,
  input: SubmitAdChangesInput,
): Promise<SubmitAdChangesResult | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;

  try {
    return await submitInTransaction(db, scope, input);
  } catch (error) {
    if (error instanceof ReviewRejected) {
      return { submissions: [], dropped: 0, blocked: [], review: error.verdict };
    }
    throw error;
  }
}

async function submitInTransaction(
  db: Db,
  scope: ProfileScope,
  input: SubmitAdChangesInput,
): Promise<SubmitAdChangesResult> {
  return db.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(adChanges)
      .where(
        and(
          eq(adChanges.status, 'pending'),
          eq(adChanges.createdBy, input.userId),
          inArray(adChanges.profileId, scope.ids),
          input.profileId === undefined ? undefined : eq(adChanges.profileId, input.profileId),
          input.changeIds === undefined ? undefined : inArray(adChanges.id, [...input.changeIds]),
        ),
      )
      .orderBy(asc(adChanges.createdAt), asc(adChanges.id))
      .for('update');
    const result: SubmitAdChangesResult = {
      submissions: [],
      dropped: 0,
      blocked: [],
      review: null,
    };
    if (pending.length === 0) return result;

    if (input.channel === 'api') {
      const withoutConnection = await tx
        .select({ id: p.id })
        .from(p)
        .where(
          and(
            inArray(p.id, [...new Set(pending.map((row) => row.profileId))]),
            isNull(p.connectionId),
          ),
        )
        .limit(1);
      if (withoutConnection.length > 0) {
        throw new AdChangeError(
          'PROFILE_HAS_NO_CONNECTION',
          'Profile ohne Connection lassen sich nur als Bulk-Datei übermitteln.',
        );
      }
    }

    // Stand der Entities neu lesen.
    const idsByType = new Map<AdChangeEntityType, string[]>();
    for (const row of pending) {
      if (row.operation !== 'update') continue;
      const entityType = row.entityType as AdChangeEntityType;
      const list = idsByType.get(entityType) ?? [];
      list.push(row.entityId!);
      idsByType.set(entityType, list);
    }
    const entities = new Map<string, EntitySnapshot>();
    for (const [entityType, entityIds] of idsByType) {
      for (const [id, entity] of await loadEntities(tx, scope, entityType, entityIds)) {
        entities.set(`${entityType}:${id}`, entity);
      }
    }

    const dropped: string[] = [];
    const byProfile = new Map<string, { organizationId: string; changeIds: string[] }>();
    const reviewed: Array<
      Omit<AdChangeReviewRow, 'adProduct' | 'countryCode' | 'comparisonBefore'> & {
        campaignId: string;
        adGroupId: string | null;
      }
    > = [];
    for (const row of pending) {
      let before: string | null = null;
      if (row.operation === 'update') {
        const field = row.field as AdChangeField;
        const after = (row.newValue ?? row.newAmount)!;
        const current = currentValue(entities.get(`${row.entityType}:${row.entityId}`), field);
        if (typeof current === 'string') {
          result.blocked.push({ changeId: row.id, reason: current });
          continue;
        }
        if (sameValue(field, current.value, after)) {
          dropped.push(row.id);
          continue;
        }
        before = current.value;
        const staged = row.oldValue ?? row.oldAmount;
        if (staged !== current.value || row.currencyCode !== current.currencyCode) {
          await tx
            .update(adChanges)
            .set({
              ...valueColumns(field, current.value, after),
              currencyCode: current.currencyCode,
            })
            .where(eq(adChanges.id, row.id));
        }
      } else {
        const parent = await checkNegative(tx, scope, {
          campaignId: row.campaignId,
          adGroupId: row.adGroupId,
          negative: row.payload!,
        });
        if (typeof parent === 'string') {
          result.blocked.push({ changeId: row.id, reason: parent });
          continue;
        }
      }
      const group = byProfile.get(row.profileId) ?? {
        organizationId: row.organizationId,
        changeIds: [],
      };
      group.changeIds.push(row.id);
      byProfile.set(row.profileId, group);
      reviewed.push({
        id: row.id,
        profileId: row.profileId,
        campaignId: row.campaignId,
        adGroupId: row.adGroupId,
        field: row.field as AdChangeField | null,
        before,
        after: row.newValue ?? row.newAmount,
        negative: row.payload,
      });
    }

    if (input.review && reviewed.length > 0) {
      const countries = new Map<string, string>();
      for (const profile of await tx
        .select({ id: p.id, countryCode: p.countryCode })
        .from(p)
        .where(inArray(p.id, [...byProfile.keys()]))) {
        countries.set(profile.id, profile.countryCode);
      }
      const adProducts = new Map<string, string>();
      for (const part of chunks([...new Set(reviewed.map((row) => row.campaignId))])) {
        for (const campaign of await tx
          .select({ id: amazonAdsCampaigns.id, adProduct: amazonAdsCampaigns.adProduct })
          .from(amazonAdsCampaigns)
          .where(inArray(amazonAdsCampaigns.id, part))) {
          adProducts.set(campaign.id, campaign.adProduct);
        }
      }
      const comparisonBids = await loadComparisonBids(tx, reviewed);
      const verdict: unknown = input.review(
        reviewed.map(({ campaignId, adGroupId: _adGroupId, ...row }) => ({
          ...row,
          comparisonBefore: comparisonBids.get(row.id) ?? null,
          adProduct: adProducts.get(campaignId) ?? '',
          countryCode: countries.get(row.profileId) ?? '',
        })),
      );
      if (verdict !== null && verdict !== undefined) throw new ReviewRejected(verdict);
    }

    for (const part of chunks(dropped)) {
      await tx.delete(adChanges).where(inArray(adChanges.id, part));
    }
    result.dropped = dropped.length;
    if (byProfile.size === 0) return result;

    const submissionIds: string[] = [];
    for (const [profileId, group] of byProfile) {
      const [submission] = await tx
        .insert(adChangeSubmissions)
        .values({
          organizationId: group.organizationId,
          profileId,
          channel: input.channel,
          createdBy: input.userId,
        })
        .returning({ id: adChangeSubmissions.id });
      submissionIds.push(submission!.id);
      for (const part of chunks(group.changeIds)) {
        await tx
          .update(adChanges)
          .set({ status: 'submitted', submissionId: submission!.id })
          .where(inArray(adChanges.id, part));
      }
      await recordAuditEvent(tx, {
        // Die Daten gehören der Organisation des Profils (ADR 002).
        organizationId: group.organizationId,
        actorUserId: input.userId,
        action: 'ad_change_submission.create',
        target: {
          type: 'ad_change_submission',
          id: submission!.id,
          profileId,
          channel: input.channel,
          changes: group.changeIds.length,
        },
      });
    }
    result.submissions = await loadAdChangeSubmissionSummaries(
      tx,
      inArray(adChangeSubmissions.id, submissionIds),
    );
    if (input.channel === 'api') await input.enqueue(tx, result.submissions);
    return result;
  });
}

export const AD_CHANGE_SUBMISSION_LIST_LIMIT = 100;

/** Übermittlungen der sichtbaren Profile, neueste zuerst (für die ganze Organisation). `null` für Nicht-Mitglieder. */
export async function listAdChangeSubmissions(
  db: Db,
  input: AdChangeActor & { limit?: number },
): Promise<AdChangeSubmissionSummary[] | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  return loadAdChangeSubmissionSummaries(
    db,
    inArray(adChangeSubmissions.profileId, scope.ids),
    Math.min(input.limit ?? AD_CHANGE_SUBMISSION_LIST_LIMIT, AD_CHANGE_SUBMISSION_LIST_LIMIT),
  );
}

/** Der letzte erneute Versuch bzw. Revert einer Änderung (3.3). */
export interface AdChangeFollowUp {
  changeId: string;
  origin: Extract<AdChangeOrigin, 'retry' | 'revert'>;
  status: AdChangeStatus;
  submissionId: string | null;
}

export interface SubmittedAdChange extends AdChangeRecord {
  followUp: AdChangeFollowUp | null;
}

/** Eine Übermittlung mit ihren Änderungen; `null`, wenn der Nutzer das Profil nicht sehen darf. */
export async function getAdChangeSubmission(
  db: Db,
  input: AdChangeActor & { submissionId: string },
): Promise<{ submission: AdChangeSubmissionSummary; changes: SubmittedAdChange[] } | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const [submission] = await loadAdChangeSubmissionSummaries(
    db,
    and(
      eq(adChangeSubmissions.id, input.submissionId),
      inArray(adChangeSubmissions.profileId, scope.ids),
    ),
  );
  if (!submission) return null;
  const changes = await loadAdChangeRecords(db, eq(adChanges.submissionId, submission.id));
  const followUps = new Map<string, AdChangeFollowUp>();
  for (const part of chunks(changes.map((change) => change.id))) {
    const rows = await db
      .select({
        changeId: adChanges.id,
        originChangeId: adChanges.originChangeId,
        origin: adChanges.origin,
        status: adChanges.status,
        submissionId: adChanges.submissionId,
      })
      .from(adChanges)
      .where(
        and(inArray(adChanges.originChangeId, part), eq(adChanges.profileId, submission.profileId)),
      )
      .orderBy(asc(adChanges.createdAt), asc(adChanges.id));
    // Aufsteigend gelesen: Der jüngste Folgeschritt gewinnt.
    for (const { originChangeId, ...row } of rows) {
      followUps.set(originChangeId!, {
        ...row,
        origin: row.origin as AdChangeFollowUp['origin'],
        status: row.status as AdChangeStatus,
      });
    }
  }
  return {
    submission,
    changes: changes.map((change) => ({ ...change, followUp: followUps.get(change.id) ?? null })),
  };
}
