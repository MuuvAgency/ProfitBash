import {
  adChangeFieldKind,
  adChangeValueIssue,
  isAdChangePlacementField,
  type AdChangeChannel,
  type AdChangeEntityType,
  type AdChangeField,
  type AdChangeRejection,
} from '@profitbash/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { visibleProfilesScope } from './access';
import {
  checkNegative,
  chunks,
  currentValue,
  loadEntities,
  negativeKey,
  sameValue,
  valueColumns,
  type EntitySnapshot,
  type ProfileScope,
} from './ad-change-entities';
import {
  applyAdChangeToEntity,
  AD_CHANGE_UNKNOWN_OUTCOME,
  closeAdChangeSubmission,
  findMatchingNegative,
  lockProfileAdChanges,
} from './ad-change-processing';
import {
  AdChangeError,
  loadAdChangeSubmissionSummaries,
  type AdChangeActor,
  type AdChangeSubmissionSummary,
} from './ad-changes';
import { recordAuditEvent, type DbOrTx } from './audit';
import type { Db } from './client';
import {
  adChangeSubmissions,
  adChanges,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsProfiles,
} from './schema';

/**
 * Folgeschritte nach einer Übermittlung (`docs/tasks/phase-3.md` 3.3, F8): fehlgeschlagene Änderungen erneut
 * versuchen oder verwerfen, angewendete zurücknehmen (Revert), eine Übermittlung per Bulk-Datei von Hand
 * abschließen. Alles über `visibleProfilesScope()` (ADR 002); das Recht `write` im Feature `changes` prüft die API.
 *
 * Erneuter Versuch und Revert entstehen als **neue Änderungen mit Verweis** (`origin`, `origin_change_id`) in
 * einer **neuen Übermittlung** des handelnden Nutzers; die ursprüngliche Änderung bleibt als Verlauf stehen.
 */

type ChangeRow = typeof adChanges.$inferSelect;
type NewChange = typeof adChanges.$inferInsert;

export type AdChangeFollowUpSkipReason =
  /** Unbekannt oder in keinem sichtbaren Profil. */
  | 'notFound'
  | 'notFailed'
  | 'notApplied'
  /** Ein erneuter Versuch bzw. Revert läuft schon oder ist angewendet. */
  | 'alreadyRetried'
  | 'alreadyReverted'
  /** Archivieren lässt sich bei Amazon nicht zurücknehmen. */
  | 'archiveNotRevertible'
  /** Vorher gab es keinen eigenen Wert (z. B. Target ohne eigenes Gebot): Amazon kann ein Gebot nicht leeren. */
  | 'noPreviousValue'
  /** Der Stand entspricht schon dem Zielwert. */
  | 'nothingToChange'
  /** Dieselbe Anfrage nennt eine weitere Änderung an derselben Stelle, die gilt (Retry: die jüngste, Revert: die älteste). */
  | 'superseded'
  /** Anlage mit unklarem Ausgang: erst nach dem nächsten Sync bzw. Import wiederholbar (sonst doppelte Negatives). */
  | 'outcomeUnknown'
  /** Dasselbe Negative wird an derselben Stelle gerade schon angelegt. */
  | 'alreadySubmitted'
  | AdChangeRejection;

export interface SkippedAdChange {
  changeId: string;
  reason: AdChangeFollowUpSkipReason;
}

interface FollowUpInput extends AdChangeActor {
  channel: AdChangeChannel;
  /** Wie bei `submitAdChanges`: plant die Jobs für den Weg `api` in derselben Transaktion ein. */
  enqueue: (tx: DbOrTx, submissions: readonly AdChangeSubmissionSummary[]) => Promise<unknown>;
}

const OPEN_FOLLOW_UP_STATUSES = ['pending', 'submitted', 'applied'];

/** Änderungen mit einem laufenden oder angewendeten Folgeschritt dieser Art. */
async function withFollowUp(
  tx: DbOrTx,
  origin: 'retry' | 'revert',
  changeIds: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const part of chunks(changeIds)) {
    const rows = await tx
      .select({ originChangeId: adChanges.originChangeId })
      .from(adChanges)
      .where(
        and(
          inArray(adChanges.originChangeId, part),
          eq(adChanges.origin, origin),
          inArray(adChanges.status, OPEN_FOLLOW_UP_STATUSES),
        ),
      );
    for (const row of rows) found.add(row.originChangeId!);
  }
  return found;
}

async function loadVisibleChanges(
  tx: DbOrTx,
  scope: ProfileScope,
  filter: { changeIds?: readonly string[] | undefined; submissionId?: string | undefined },
): Promise<ChangeRow[]> {
  const visible = inArray(adChanges.profileId, scope.ids);
  if (filter.changeIds === undefined) {
    if (filter.submissionId === undefined) return [];
    return tx
      .select()
      .from(adChanges)
      .where(and(visible, eq(adChanges.submissionId, filter.submissionId)))
      .orderBy(adChanges.createdAt, adChanges.id)
      .for('update');
  }
  const rows: ChangeRow[] = [];
  // Sortiert: Zwei Aufrufe mit denselben IDs sperren die Zeilen in derselben Reihenfolge.
  for (const part of chunks([...new Set(filter.changeIds)].sort())) {
    rows.push(
      ...(await tx
        .select()
        .from(adChanges)
        .where(
          and(
            visible,
            inArray(adChanges.id, part),
            filter.submissionId === undefined
              ? undefined
              : eq(adChanges.submissionId, filter.submissionId),
          ),
        )
        .orderBy(adChanges.createdAt, adChanges.id)
        .for('update')),
    );
  }
  return rows.sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
}

const placeKey = (row: ChangeRow) => `${row.entityType}:${row.entityId}:${row.field}`;

const negativePlaceKey = (row: Pick<ChangeRow, 'campaignId' | 'adGroupId' | 'payload'>) =>
  `${row.campaignId}:${row.adGroupId}:${negativeKey(row.payload!)}`;

/** Anlagen, die gerade übermittelt werden (noch ohne Ergebnis), nach Stelle und Inhalt. */
async function submittedNegativeKeys(tx: DbOrTx, rows: readonly ChangeRow[]): Promise<Set<string>> {
  const keys = new Set<string>();
  const campaignIds = [
    ...new Set(rows.flatMap((row) => (row.operation === 'create' ? [row.campaignId] : []))),
  ];
  for (const part of chunks(campaignIds)) {
    const open = await tx
      .select({
        campaignId: adChanges.campaignId,
        adGroupId: adChanges.adGroupId,
        payload: adChanges.payload,
      })
      .from(adChanges)
      .where(
        and(
          inArray(adChanges.campaignId, part),
          eq(adChanges.operation, 'create'),
          eq(adChanges.status, 'submitted'),
        ),
      );
    for (const row of open) if (row.payload) keys.add(negativePlaceKey(row));
  }
  return keys;
}

/** Letzter Sync bzw. Import je Kampagne (`synced_at`). */
async function campaignSyncedAt(
  tx: DbOrTx,
  campaignIds: readonly string[],
): Promise<Map<string, Date | null>> {
  const found = new Map<string, Date | null>();
  for (const part of chunks([...new Set(campaignIds)])) {
    const rows = await tx
      .select({ id: amazonAdsCampaigns.id, syncedAt: amazonAdsCampaigns.syncedAt })
      .from(amazonAdsCampaigns)
      .where(inArray(amazonAdsCampaigns.id, part));
    for (const row of rows) found.set(row.id, row.syncedAt);
  }
  return found;
}

async function loadSnapshots(
  tx: DbOrTx,
  scope: ProfileScope,
  rows: readonly Pick<ChangeRow, 'entityType' | 'entityId'>[],
): Promise<Map<string, EntitySnapshot>> {
  const idsByType = new Map<AdChangeEntityType, string[]>();
  for (const row of rows) {
    if (row.entityId === null) continue;
    const entityType = row.entityType as AdChangeEntityType;
    const list = idsByType.get(entityType) ?? [];
    list.push(row.entityId);
    idsByType.set(entityType, list);
  }
  const snapshots = new Map<string, EntitySnapshot>();
  for (const [entityType, ids] of idsByType) {
    for (const [id, entity] of await loadEntities(tx, scope, entityType, ids)) {
      snapshots.set(`${entityType}:${id}`, entity);
    }
  }
  return snapshots;
}

/** Neue Änderungen direkt als Übermittlung je Profil anlegen (nie über den Warenkorb des Nutzers). */
async function submitFollowUps(
  tx: DbOrTx,
  input: FollowUpInput,
  origin: 'retry' | 'revert',
  changes: readonly NewChange[],
): Promise<AdChangeSubmissionSummary[]> {
  if (changes.length === 0) return [];
  const byProfile = new Map<string, NewChange[]>();
  for (const change of changes) {
    const list = byProfile.get(change.profileId) ?? [];
    list.push(change);
    byProfile.set(change.profileId, list);
  }
  if (input.channel === 'api') {
    const withoutConnection = await tx
      .select({ id: amazonAdsProfiles.id })
      .from(amazonAdsProfiles)
      .where(
        and(
          inArray(amazonAdsProfiles.id, [...byProfile.keys()]),
          isNull(amazonAdsProfiles.connectionId),
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
  const submissionIds: string[] = [];
  for (const [profileId, rows] of byProfile) {
    const organizationId = rows[0]!.organizationId;
    const [submission] = await tx
      .insert(adChangeSubmissions)
      .values({ organizationId, profileId, channel: input.channel, createdBy: input.userId })
      .returning({ id: adChangeSubmissions.id });
    submissionIds.push(submission!.id);
    for (const part of chunks(rows, 500)) {
      await tx.insert(adChanges).values(
        part.map((row) => ({
          ...row,
          origin,
          status: 'submitted',
          submissionId: submission!.id,
          createdBy: input.userId,
        })),
      );
    }
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: input.userId,
      action: 'ad_change_submission.create',
      target: {
        type: 'ad_change_submission',
        id: submission!.id,
        profileId,
        channel: input.channel,
        changes: rows.length,
        origin,
      },
    });
  }
  const submissions = await loadAdChangeSubmissionSummaries(
    tx,
    inArray(adChangeSubmissions.id, submissionIds),
  );
  if (input.channel === 'api') await input.enqueue(tx, submissions);
  return submissions;
}

/** Spalten einer Folgeänderung an derselben Stelle wie das Original. */
const samePlace = (row: ChangeRow) => ({
  organizationId: row.organizationId,
  profileId: row.profileId,
  origin: row.origin,
  originChangeId: row.id,
  operation: row.operation,
  entityType: row.entityType,
  entityId: row.entityId,
  campaignId: row.campaignId,
  adGroupId: row.adGroupId,
});

// ---------------------------------------------------------------------------
// Erneut versuchen
// ---------------------------------------------------------------------------

export interface RetryAdChangesResult {
  submissions: AdChangeSubmissionSummary[];
  skipped: SkippedAdChange[];
}

/**
 * Versucht fehlgeschlagene Änderungen erneut: je Änderung eine neue mit Verweis, „vorher“ neu gelesen. Entspricht
 * der Stand inzwischen dem Zielwert (z. B. nach einem unklaren Ausgang, der doch gewirkt hat), entfällt der
 * Versuch (`nothingToChange`). `null` für Nicht-Mitglieder.
 */
export async function retryAdChanges(
  db: Db,
  input: FollowUpInput & { changeIds: readonly string[] },
): Promise<RetryAdChangesResult | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  return db.transaction(async (tx) => {
    const rows = await loadVisibleChanges(tx, scope, { changeIds: input.changeIds });
    const skipped: SkippedAdChange[] = [];
    const skip = (changeId: string, reason: AdChangeFollowUpSkipReason) =>
      skipped.push({ changeId, reason });
    const found = new Set(rows.map((row) => row.id));
    for (const changeId of new Set(input.changeIds)) {
      if (!found.has(changeId)) skip(changeId, 'notFound');
    }
    const retried = await withFollowUp(
      tx,
      'retry',
      rows.map((row) => row.id),
    );
    const snapshots = await loadSnapshots(tx, scope, rows);
    const retryable = (row: ChangeRow) => row.status === 'failed' && !retried.has(row.id);
    // Mehrere Fehlschläge an derselben Stelle: Es gilt der jüngste (die Zeilen sind nach Alter sortiert).
    const newestAtPlace = new Map<string, string>();
    for (const row of rows) {
      if (row.operation === 'update' && retryable(row)) newestAtPlace.set(placeKey(row), row.id);
    }
    const creating = await submittedNegativeKeys(tx, rows);
    const syncedAt = await campaignSyncedAt(
      tx,
      rows.flatMap((row) =>
        row.operation === 'create' && row.errorCode === AD_CHANGE_UNKNOWN_OUTCOME
          ? [row.campaignId]
          : [],
      ),
    );

    const changes: NewChange[] = [];
    for (const row of rows) {
      if (row.status !== 'failed') {
        skip(row.id, 'notFailed');
        continue;
      }
      if (retried.has(row.id)) {
        skip(row.id, 'alreadyRetried');
        continue;
      }
      if (row.operation === 'update' && newestAtPlace.get(placeKey(row)) !== row.id) {
        skip(row.id, 'superseded');
        continue;
      }
      if (row.operation === 'create') {
        // Unklarer Ausgang: Erst ein Sync nach dem Fehlschlag zeigt, ob Amazon das Negative angelegt hat.
        const synced = syncedAt.get(row.campaignId) ?? null;
        if (
          row.errorCode === AD_CHANGE_UNKNOWN_OUTCOME &&
          (synced === null || row.resolvedAt === null || synced <= row.resolvedAt)
        ) {
          skip(row.id, 'outcomeUnknown');
          continue;
        }
        const key = negativePlaceKey(row);
        if (creating.has(key)) {
          skip(row.id, 'alreadySubmitted');
          continue;
        }
        const parent = await checkNegative(tx, scope, {
          campaignId: row.campaignId,
          adGroupId: row.adGroupId,
          negative: row.payload!,
        });
        if (typeof parent === 'string') {
          skip(row.id, parent);
          continue;
        }
        creating.add(key);
        changes.push({ ...samePlace(row), payload: row.payload });
        continue;
      }
      const field = row.field as AdChangeField;
      const after = (row.newValue ?? row.newAmount)!;
      const current = currentValue(snapshots.get(`${row.entityType}:${row.entityId}`), field);
      if (typeof current === 'string') {
        skip(row.id, current);
        continue;
      }
      if (sameValue(field, current.value, after)) {
        skip(row.id, 'nothingToChange');
        continue;
      }
      changes.push({
        ...samePlace(row),
        field,
        ...valueColumns(field, current.value, after),
        currencyCode: current.currencyCode,
      });
    }
    return { submissions: await submitFollowUps(tx, input, 'retry', changes), skipped };
  });
}

// ---------------------------------------------------------------------------
// Verwerfen
// ---------------------------------------------------------------------------

/**
 * Verwirft fehlgeschlagene Änderungen (`failed` → `dismissed`); andere bleiben unberührt. Audit
 * `ad_changes.dismiss`. Liefert die Zahl der verworfenen, `null` für Nicht-Mitglieder.
 */
export async function dismissFailedAdChanges(
  db: Db,
  input: AdChangeActor & { changeIds: readonly string[] },
): Promise<number | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  return db.transaction(async (tx) => {
    const dismissed: { profileId: string }[] = [];
    for (const part of chunks([...new Set(input.changeIds)])) {
      dismissed.push(
        ...(await tx
          .update(adChanges)
          .set({ status: 'dismissed' })
          .where(
            and(
              inArray(adChanges.id, part),
              inArray(adChanges.profileId, scope.ids),
              eq(adChanges.status, 'failed'),
            ),
          )
          .returning({ profileId: adChanges.profileId })),
      );
    }
    if (dismissed.length > 0) {
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'ad_changes.dismiss',
        target: {
          type: 'ad_changes',
          id: input.orgId,
          dismissed: dismissed.length,
          profileIds: [...new Set(dismissed.map((row) => row.profileId))].sort(),
        },
      });
    }
    return dismissed.length;
  });
}

// ---------------------------------------------------------------------------
// Revert (F8)
// ---------------------------------------------------------------------------

export interface AdChangeRevertConflict {
  changeId: string;
  /** Wert nach der Übermittlung („nachher“ der Änderung). */
  expected: string;
  /** Stand der Entity heute. */
  current: string | null;
}

export type RevertAdChangesResult =
  /** Nichts übermittelt: Der Stand weicht ab, die Oberfläche fragt nach (`overwriteChanged`). */
  | { status: 'conflict'; conflicts: AdChangeRevertConflict[]; skipped: SkippedAdChange[] }
  | { status: 'submitted'; submissions: AdChangeSubmissionSummary[]; skipped: SkippedAdChange[] };

/**
 * Nimmt angewendete Änderungen zurück: eine ganze Übermittlung (`submissionId`) oder einzelne (`changeIds`), als
 * neue Übermittlung auf den Wert vor der Änderung. Weicht der Stand der Entity vom „nachher“ der Änderung ab (in
 * der Werbekonsole oder durch eine spätere Übermittlung geändert), wird nichts übermittelt und die Abweichungen
 * kommen zurück; erst mit `overwriteChanged` wird überschrieben (F8).
 *
 * Nicht zurücknehmen lassen sich: Archivieren, Werte ohne „vorher“ (Target ohne eigenes Gebot; eine Platzierung
 * ohne Eintrag geht auf 0 %). Ein angelegtes Negative wird archiviert. `null` für Nicht-Mitglieder.
 */
export async function revertAdChanges(
  db: Db,
  input: FollowUpInput & {
    submissionId?: string;
    changeIds?: readonly string[];
    overwriteChanged?: boolean;
  },
): Promise<RevertAdChangesResult | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  return db.transaction(async (tx) => {
    const rows = await loadVisibleChanges(tx, scope, input);
    const skipped: SkippedAdChange[] = [];
    const skip = (changeId: string, reason: AdChangeFollowUpSkipReason) =>
      skipped.push({ changeId, reason });
    const found = new Set(rows.map((row) => row.id));
    for (const changeId of new Set(input.changeIds ?? [])) {
      if (!found.has(changeId)) skip(changeId, 'notFound');
    }
    const reverted = await withFollowUp(
      tx,
      'revert',
      rows.map((row) => row.id),
    );
    const snapshots = await loadSnapshots(tx, scope, rows);

    // Mehrere Änderungen an derselben Stelle gehen gemeinsam zurück: Ziel ist „vorher“ der ältesten, verglichen
    // wird der Stand mit „nachher“ der jüngsten (die Zeilen sind nach Alter sortiert).
    const atPlace = new Map<string, ChangeRow[]>();
    for (const row of rows) {
      if (row.operation !== 'update' || row.status !== 'applied' || reverted.has(row.id)) continue;
      if (row.field === 'state' && row.newValue === 'ARCHIVED') continue;
      const list = atPlace.get(placeKey(row)) ?? [];
      list.push(row);
      atPlace.set(placeKey(row), list);
    }

    const conflicts: AdChangeRevertConflict[] = [];
    const changes: NewChange[] = [];
    for (const row of rows) {
      if (row.status !== 'applied') {
        skip(row.id, 'notApplied');
        continue;
      }
      if (reverted.has(row.id)) {
        skip(row.id, 'alreadyReverted');
        continue;
      }
      const together = atPlace.get(placeKey(row));
      if (together && together[0] !== row) {
        skip(row.id, 'superseded');
        continue;
      }
      if (row.operation === 'create') {
        const archive = await archiveCreatedNegative(tx, scope, row);
        if (typeof archive === 'string') skip(row.id, archive);
        else changes.push(archive);
        continue;
      }
      const field = row.field as AdChangeField;
      const entityType = row.entityType as AdChangeEntityType;
      const newest = together?.at(-1) ?? row;
      const after = (newest.newValue ?? newest.newAmount)!;
      if (field === 'state' && after === 'ARCHIVED') {
        skip(row.id, 'archiveNotRevertible');
        continue;
      }
      const before =
        row.oldValue ?? row.oldAmount ?? (isAdChangePlacementField(field) ? '0' : null);
      // Auch ein Zustand oder eine Strategie, die sich nicht setzen lässt (z. B. regelbasierte Gebote), ist kein
      // Ziel für den Revert. Beträge gehen so zurück, wie sie waren (auch mit mehr Nachkommastellen, als der
      // Warenkorb annimmt).
      if (
        before === null ||
        (adChangeFieldKind(field) === 'enum' &&
          adChangeValueIssue(entityType, field, before) !== null)
      ) {
        skip(row.id, 'noPreviousValue');
        continue;
      }
      const current = currentValue(snapshots.get(`${entityType}:${row.entityId}`), field);
      if (typeof current === 'string') {
        skip(row.id, current);
        continue;
      }
      if (sameValue(field, current.value, before)) {
        skip(row.id, 'nothingToChange');
        continue;
      }
      if (!sameValue(field, current.value, after)) {
        conflicts.push({ changeId: row.id, expected: after, current: current.value });
      }
      changes.push({
        ...samePlace(row),
        field,
        ...valueColumns(field, current.value, before),
        currencyCode: current.currencyCode,
      });
    }
    if (conflicts.length > 0 && !input.overwriteChanged) {
      return { status: 'conflict', conflicts, skipped };
    }
    return {
      status: 'submitted',
      submissions: await submitFollowUps(tx, input, 'revert', changes),
      skipped,
    };
  });
}

/**
 * Revert einer Anlage: das Negative archivieren. Die Entity findet sich über die von Amazon vergebene ID, sonst
 * (Bulk-Datei von Hand abgeschlossen) über denselben Inhalt an derselben Stelle.
 */
async function archiveCreatedNegative(
  tx: DbOrTx,
  scope: ProfileScope,
  row: ChangeRow,
): Promise<NewChange | AdChangeFollowUpSkipReason> {
  const n = amazonAdsNegativeTargets;
  const amazonTargetId = row.amazonEntityId ?? (await findMatchingNegative(tx, row));
  if (amazonTargetId === null) return 'notFound';
  const [entity] = await tx
    .select({ id: n.id })
    .from(n)
    .where(and(eq(n.profileId, row.profileId), eq(n.amazonTargetId, amazonTargetId)));
  if (!entity) return 'notFound';
  const snapshot = (await loadEntities(tx, scope, 'negative_target', [entity.id])).get(entity.id);
  const current = currentValue(snapshot, 'state');
  if (typeof current === 'string') return current;
  return {
    ...samePlace(row),
    operation: 'update',
    entityId: entity.id,
    field: 'state',
    ...valueColumns('state', current.value, 'ARCHIVED'),
  };
}

// ---------------------------------------------------------------------------
// Bulk-Datei von Hand abschließen
// ---------------------------------------------------------------------------

/**
 * Schließt eine offene Übermittlung per Bulk-Datei von Hand ab. `applied`: Die Datei ist in der Werbekonsole
 * hochgeladen, die noch offenen Änderungen gelten als angewendet und die Entities werden nachgezogen (der nächste
 * Import liefert den echten Stand). `discarded`: Die Datei wird nicht hochgeladen, die offenen Änderungen sind
 * verworfen. Audit `ad_change_submission.close`. `null`, wenn der Nutzer die Übermittlung nicht sehen darf;
 * `AdChangeError` `SUBMISSION_NOT_OPEN` für andere Wege und schon abgeschlossene.
 */
export async function closeBulkFileSubmission(
  db: Db,
  input: AdChangeActor & {
    submissionId: string;
    outcome: 'applied' | 'discarded';
    now?: Date;
  },
): Promise<{ changes: number } | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const s = adChangeSubmissions;
    const visible = and(eq(s.id, input.submissionId), inArray(s.profileId, scope.ids));
    const [found] = await tx.select({ profileId: s.profileId }).from(s).where(visible);
    if (!found) return null;
    // Vor allen Zeilensperren, wie der Import (sonst Deadlock mit dessen Bestätigung).
    await lockProfileAdChanges(tx, found.profileId);
    const [submission] = await tx.select().from(s).where(visible).for('update');
    if (!submission) return null;
    if (submission.channel !== 'bulk_file' || !['pending', 'running'].includes(submission.status)) {
      throw new AdChangeError(
        'SUBMISSION_NOT_OPEN',
        'Von Hand abschließen lassen sich nur offene Übermittlungen per Bulk-Datei.',
      );
    }
    const open = await tx
      .select()
      .from(adChanges)
      .where(and(eq(adChanges.submissionId, submission.id), eq(adChanges.status, 'submitted')))
      .for('update');
    for (const part of chunks(open.map((row) => row.id))) {
      await tx
        .update(adChanges)
        .set({ status: input.outcome === 'applied' ? 'applied' : 'dismissed', resolvedAt: now })
        .where(inArray(adChanges.id, part));
    }
    if (input.outcome === 'applied') {
      // „Vorher“ endgültig: der Stand unmittelbar vor dem Nachziehen (eine frühere Bulk-Übermittlung an derselben
      // Stelle kann inzwischen abgeschlossen sein).
      const snapshots = await loadSnapshots(tx, scope, open);
      for (const row of open) {
        if (row.operation !== 'update') continue;
        const field = row.field as AdChangeField;
        const after = (row.newValue ?? row.newAmount)!;
        const current = currentValue(snapshots.get(`${row.entityType}:${row.entityId}`), field);
        if (typeof current === 'string' || sameValue(field, current.value, after)) continue;
        if ((row.oldValue ?? row.oldAmount) === current.value) continue;
        await tx
          .update(adChanges)
          .set({ ...valueColumns(field, current.value, after), currencyCode: current.currencyCode })
          .where(eq(adChanges.id, row.id));
      }
      // Die Amazon-ID eines neuen Negatives kennt erst der nächste Import.
      for (const row of open) await applyAdChangeToEntity(tx, row, null);
    }
    await closeAdChangeSubmission(tx, { submissionId: submission.id, now });
    await recordAuditEvent(tx, {
      organizationId: submission.organizationId,
      actorUserId: input.userId,
      action: 'ad_change_submission.close',
      target: {
        type: 'ad_change_submission',
        id: submission.id,
        profileId: submission.profileId,
        outcome: input.outcome,
        changes: open.length,
      },
    });
    return { changes: open.length };
  });
}
