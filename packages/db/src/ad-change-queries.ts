import type {
  AdChangeChannel,
  AdChangeEntityType,
  AdChangeField,
  AdChangeStatus,
} from '@profitbash/shared';
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { visibleProfilesScope } from './access';
import { chunks } from './ad-change-entities';
import { loadAdChangeJobRows, type AdChangeJobRow } from './ad-change-processing';
import {
  AdChangeError,
  loadAdChangeRecords,
  loadAdChangeSubmissionSummaries,
  type AdChangeActor,
  type AdChangeRecord,
  type AdChangeSubmissionSummary,
} from './ad-changes';
import type { DbOrTx } from './audit';
import type { Db } from './client';
import { adChangeSubmissions, adChanges, amazonAdsProfiles, users } from './schema';

/**
 * Lesen für API und Oberfläche (`docs/tasks/phase-3.md` 3.4), alles über `visibleProfilesScope()` (ADR 002):
 * offene Änderungen je Entity (Anzeige im Grid, Hinweis auf offene Übermittlungen an derselben Stelle), Verlauf,
 * Zeilen für die Bulk-Datei einer Übermittlung.
 */

export const AD_CHANGE_OPEN_LIST_LIMIT = 5000;
export const AD_CHANGE_HISTORY_LIMIT = 200;

export interface OpenAdChange {
  id: string;
  profileId: string;
  /** `pending` (Warenkorb, eigener oder fremder) oder `submitted` (übermittelt, noch ohne Ergebnis). */
  status: Extract<AdChangeStatus, 'pending' | 'submitted'>;
  /** Weg der Übermittlung; `null` im Warenkorb. */
  channel: AdChangeChannel | null;
  submissionId: string | null;
  operation: 'update' | 'create';
  entityType: AdChangeEntityType;
  /** Leer beim Anlegen eines Negatives. */
  entityId: string | null;
  campaignId: string;
  adGroupId: string | null;
  field: AdChangeField | null;
  after: string | null;
  /** Vom anfragenden Nutzer vorgemerkt bzw. übermittelt. */
  mine: boolean;
  userName: string | null;
}

/**
 * Offene Änderungen in sichtbaren Profilen: der Warenkorb aller Nutzer (F4) und übermittelte Änderungen ohne
 * Ergebnis, älteste zuerst, höchstens `AD_CHANGE_OPEN_LIST_LIMIT`. `null` für Nicht-Mitglieder.
 */
export async function listOpenAdChanges(
  db: Db,
  input: AdChangeActor,
): Promise<OpenAdChange[] | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const rows = await db
    .select({
      id: adChanges.id,
      profileId: adChanges.profileId,
      status: adChanges.status,
      channel: adChangeSubmissions.channel,
      submissionId: adChanges.submissionId,
      operation: adChanges.operation,
      entityType: adChanges.entityType,
      entityId: adChanges.entityId,
      campaignId: adChanges.campaignId,
      adGroupId: adChanges.adGroupId,
      field: adChanges.field,
      newValue: adChanges.newValue,
      newAmount: adChanges.newAmount,
      createdBy: adChanges.createdBy,
      userName: users.name,
    })
    .from(adChanges)
    .leftJoin(adChangeSubmissions, eq(adChangeSubmissions.id, adChanges.submissionId))
    .leftJoin(users, eq(users.id, adChanges.createdBy))
    .where(
      and(
        inArray(adChanges.status, ['pending', 'submitted']),
        inArray(adChanges.profileId, scope.ids),
      ),
    )
    .orderBy(asc(adChanges.createdAt), asc(adChanges.id))
    .limit(AD_CHANGE_OPEN_LIST_LIMIT);
  return rows.map(({ newValue, newAmount, createdBy, ...row }) => ({
    ...row,
    status: row.status as OpenAdChange['status'],
    channel: row.channel as AdChangeChannel | null,
    operation: row.operation as OpenAdChange['operation'],
    entityType: row.entityType as AdChangeEntityType,
    field: row.field as AdChangeField | null,
    after: newValue ?? newAmount,
    mine: createdBy === input.userId,
  }));
}

export interface AdChangeHistoryEntry extends AdChangeRecord {
  channel: AdChangeChannel | null;
  createdByName: string | null;
}

/**
 * Verlauf: übermittelte Änderungen (ohne Warenkorb) in sichtbaren Profilen, neueste zuerst; auf eine Entity oder
 * ein Profil begrenzbar, höchstens `AD_CHANGE_HISTORY_LIMIT`. `null` für Nicht-Mitglieder.
 */
export async function listAdChangeHistory(
  db: Db,
  input: AdChangeActor & {
    entityType?: AdChangeEntityType;
    entityId?: string;
    profileId?: string;
    limit?: number;
  },
): Promise<AdChangeHistoryEntry[] | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const limit = Math.min(input.limit ?? AD_CHANGE_HISTORY_LIMIT, AD_CHANGE_HISTORY_LIMIT);
  const page = await db
    .select({
      id: adChanges.id,
      channel: adChangeSubmissions.channel,
      createdByName: users.name,
    })
    .from(adChanges)
    .innerJoin(adChangeSubmissions, eq(adChangeSubmissions.id, adChanges.submissionId))
    .leftJoin(users, eq(users.id, adChanges.createdBy))
    .where(
      and(
        isNotNull(adChanges.submissionId),
        inArray(adChanges.profileId, scope.ids),
        input.profileId === undefined ? undefined : eq(adChanges.profileId, input.profileId),
        input.entityId === undefined ? undefined : eq(adChanges.entityId, input.entityId),
        input.entityType === undefined ? undefined : eq(adChanges.entityType, input.entityType),
      ),
    )
    .orderBy(desc(adChanges.createdAt), desc(adChanges.id))
    .limit(limit);
  if (page.length === 0) return [];
  const records = await loadAdChangeRecords(
    db,
    inArray(
      adChanges.id,
      page.map((row) => row.id),
    ),
  );
  const byId = new Map(records.map((record) => [record.id, record]));
  return page.flatMap(({ id, channel, createdByName }) => {
    const record = byId.get(id);
    return record ? [{ ...record, channel: channel as AdChangeChannel | null, createdByName }] : [];
  });
}

/**
 * Die Änderungen einer Übermittlung per Bulk-Datei für das Erzeugen der Datei: nur, was (noch) als übermittelt
 * oder angewendet gilt (beim Erzeugen übersprungene Änderungen sind `failed`). `null`, wenn der Nutzer die
 * Übermittlung nicht sehen darf; `AdChangeError` `SUBMISSION_NOT_BULK_FILE` für den Weg über die API.
 */
export async function getBulkFileSubmissionRows(
  db: Db,
  input: AdChangeActor & { submissionId: string },
): Promise<{ submission: AdChangeSubmissionSummary; rows: AdChangeJobRow[] } | null> {
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
  if (submission.channel !== 'bulk_file') {
    throw new AdChangeError(
      'SUBMISSION_NOT_BULK_FILE',
      'Eine Bulk-Datei gibt es nur für Übermittlungen per Bulk-Datei.',
    );
  }
  const changes = await db
    .select()
    .from(adChanges)
    .where(
      and(
        eq(adChanges.submissionId, submission.id),
        inArray(adChanges.status, ['submitted', 'applied']),
      ),
    )
    .orderBy(asc(adChanges.createdAt), asc(adChanges.id));
  return { submission, rows: await loadAdChangeJobRows(db, changes, { finalizeBefore: false }) };
}

/** Connections der Profile dieser Übermittlungen (Einplanen des Jobs); Profile ohne Connection fehlen. */
export async function listSubmissionConnections(
  db: DbOrTx,
  submissionIds: readonly string[],
): Promise<Array<{ organizationId: string; connectionId: string }>> {
  const found = new Map<string, { organizationId: string; connectionId: string }>();
  for (const part of chunks([...new Set(submissionIds)])) {
    const rows = await db
      .selectDistinct({
        organizationId: amazonAdsProfiles.organizationId,
        connectionId: amazonAdsProfiles.connectionId,
      })
      .from(adChangeSubmissions)
      .innerJoin(amazonAdsProfiles, eq(amazonAdsProfiles.id, adChangeSubmissions.profileId))
      .where(and(inArray(adChangeSubmissions.id, part), isNotNull(amazonAdsProfiles.connectionId)));
    for (const row of rows) {
      found.set(row.connectionId!, {
        organizationId: row.organizationId,
        connectionId: row.connectionId!,
      });
    }
  }
  return [...found.values()];
}
