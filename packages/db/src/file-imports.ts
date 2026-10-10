import { createHash } from 'node:crypto';
import {
  BULK_PERIOD_MAX_DAYS,
  bulkPeriodIssue,
  FILE_IMPORT_LIST_LIMIT,
  parseBulkPeriod,
  todayInTimezone,
  type BulkPeriod,
  type BulkPeriodIssue,
  type FileImport,
  type FileImportKind,
  type FileImportStatus,
} from '@profitbash/shared';
import {
  and,
  asc,
  desc,
  eq,
  getTableName,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { AccessDeniedError, canSeeProfile, getOrgRole } from './access';
import { recordAuditEvent, type DbOrTx } from './audit';
import { createNotification } from './notifications';
import type { Db } from './client';
import { amazonAdsCampaigns, amazonAdsProfiles, fileImportContents, fileImports } from './schema';

/**
 * Hochgeladene Dateien aus der Werbekonsole und ihr Import (`phase-1.md` 1.11c). Nutzerseitig (Upload,
 * Liste) über den Access-Layer (`canSeeProfile`, ADR 002), dazu die Systemzugriffe des Jobs `file-import`
 * (Abholen, Abschließen). Hochladen dürfen Org-Admins, nur für Profile ohne Connection: Bei API-Profilen
 * überschriebe der tägliche Sync die Daten aus der Datei.
 */

export type FileImportErrorCode =
  'PROFILE_NOT_FOUND' | 'PROFILE_HAS_CONNECTION' | 'EMPTY_FILE' | 'INVALID_PERIOD';

/** Meldungen zu einem ungültigen, von Hand angegebenen Zeitraum (API und Upload teilen sie). */
export const BULK_PERIOD_ISSUE_MESSAGES: Record<BulkPeriodIssue, string> = {
  incomplete: 'Für den Zeitraum bitte beide Tage angeben oder keinen.',
  invalidDate: 'Der Zeitraum enthält keinen gültigen Tag (JJJJ-MM-TT).',
  startAfterEnd: 'Der erste Tag des Zeitraums liegt nach dem letzten.',
  future: 'Der Zeitraum darf nicht in der Zukunft enden.',
  tooLong: `Der Zeitraum ist länger als ${BULK_PERIOD_MAX_DAYS} Tage.`,
  tooOld: 'Der erste Tag darf höchstens 365 Tage zurückliegen.',
};

export class FileImportError extends Error {
  constructor(
    public readonly code: FileImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FileImportError';
  }
}

/** Hängt eine Datei so lange in `running`, gilt ihr Lauf als abgebrochen (Absturz, Deploy). */
export const FILE_IMPORT_STALE_MS = 30 * 60 * 1000;
/** So oft wird eine Datei höchstens abgeholt. */
export const FILE_IMPORT_MAX_ATTEMPTS = 3;

const summaryColumns = {
  id: fileImports.id,
  profileId: fileImports.profileId,
  kind: fileImports.kind,
  fileName: fileImports.fileName,
  byteSize: fileImports.byteSize,
  sha256: fileImports.sha256,
  complete: fileImports.complete,
  status: fileImports.status,
  error: fileImports.error,
  counters: fileImports.counters,
  uploadedBy: fileImports.uploadedBy,
  periodStart: fileImports.periodStart,
  periodEnd: fileImports.periodEnd,
  createdAt: fileImports.createdAt,
  startedAt: fileImports.startedAt,
  finishedAt: fileImports.finishedAt,
};

type SummaryRow = Pick<typeof fileImports.$inferSelect, keyof typeof summaryColumns>;

function toFileImport(row: SummaryRow): FileImport {
  return {
    ...row,
    kind: row.kind as FileImportKind,
    status: row.status as FileImportStatus,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

interface Actor {
  userId: string;
  orgId: string;
}

/** `forUpload`: entfernte Profile nehmen keine neuen Dateien an; ihr Verlauf bleibt lesbar. */
async function requireFileProfile(
  db: Db,
  input: Actor & { profileId: string },
  options: { forUpload: boolean },
) {
  const role = await getOrgRole(db, input.userId, input.orgId);
  if (role !== 'admin') throw new AccessDeniedError('Nur Org-Admins importieren Dateien.');
  const visible = await canSeeProfile(db, {
    ...input,
    includeHidden: true,
    includeRemoved: !options.forUpload,
  });
  if (!visible) throw new FileImportError('PROFILE_NOT_FOUND', 'Profil nicht gefunden.');
  const [profile] = await db
    .select({ connectionId: amazonAdsProfiles.connectionId, timezone: amazonAdsProfiles.timezone })
    .from(amazonAdsProfiles)
    .where(eq(amazonAdsProfiles.id, input.profileId));
  if (!profile) throw new FileImportError('PROFILE_NOT_FOUND', 'Profil nicht gefunden.');
  return profile;
}

export interface CreateFileImportInput extends Actor {
  profileId: string;
  kind: FileImportKind;
  fileName: string;
  content: Uint8Array;
  /** Datei enthält laut Upload alle Entities (Standard `false`). */
  complete?: boolean;
  /**
   * Von Hand angegebener Zeitraum der Kennzahlen (2b.2c), für Dateien, deren Name keinen trägt. Trägt der Name
   * einen, gilt der und die Angabe wird ignoriert (auch nicht geprüft).
   */
  period?: BulkPeriod | null;
  /** Für „kein Tag in der Zukunft“ und „erster Tag höchstens 365 Tage zurück“ (Standard: jetzt). */
  now?: Date;
  /** Plant den Job in derselben Transaktion ein (pg-boss über `tx`). */
  enqueue: (tx: DbOrTx) => Promise<unknown>;
}

export async function createFileImport(db: Db, input: CreateFileImportInput): Promise<FileImport> {
  const profile = await requireFileProfile(db, input, { forUpload: true });
  if (profile.connectionId !== null) {
    throw new FileImportError(
      'PROFILE_HAS_CONNECTION',
      'Das Profil hat eine Connection; seine Daten kommen über die API.',
    );
  }
  if (input.content.byteLength === 0) {
    throw new FileImportError('EMPTY_FILE', 'Die Datei ist leer.');
  }
  // Der Dateiname der Werbekonsole gewinnt: Der Import liest den Zeitraum zuerst dort (`parseBulkPeriod`), eine
  // abweichende Angabe von Hand stünde sonst im Verlauf, ohne zu gelten.
  const period = parseBulkPeriod(input.fileName) ? null : (input.period ?? null);
  if (period) {
    // „Heute“ in der Zeitzone des Profils: Dort endet auch der Zeitraum der Werbekonsole.
    const issue = bulkPeriodIssue(
      period,
      todayInTimezone(profile.timezone, input.now ?? new Date()),
    );
    if (issue) throw new FileImportError('INVALID_PERIOD', BULK_PERIOD_ISSUE_MESSAGES[issue]);
  }
  const sha256 = createHash('sha256').update(input.content).digest('hex');
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(fileImports)
      .values({
        organizationId: input.orgId,
        profileId: input.profileId,
        kind: input.kind,
        fileName: input.fileName,
        byteSize: input.content.byteLength,
        sha256,
        complete: input.complete ?? false,
        periodStart: period?.startDate ?? null,
        periodEnd: period?.endDate ?? null,
        uploadedBy: input.userId,
      })
      .returning(summaryColumns);
    if (!row) throw new Error('Anlage des Imports lieferte keine Zeile.');
    await tx
      .insert(fileImportContents)
      .values({ fileImportId: row.id, organizationId: input.orgId, content: input.content });
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'file_import.create',
      target: {
        type: 'file_import',
        id: row.id,
        profileId: input.profileId,
        kind: input.kind,
        fileName: input.fileName,
        byteSize: row.byteSize,
        sha256,
        complete: row.complete,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
      },
    });
    await input.enqueue(tx);
    return toFileImport(row);
  });
}

export async function listFileImports(
  db: Db,
  input: Actor & { profileId: string },
): Promise<FileImport[]> {
  await requireFileProfile(db, input, { forUpload: false });
  const rows = await db
    .select(summaryColumns)
    .from(fileImports)
    .where(
      and(eq(fileImports.organizationId, input.orgId), eq(fileImports.profileId, input.profileId)),
    )
    .orderBy(desc(fileImports.createdAt), desc(fileImports.id))
    .limit(FILE_IMPORT_LIST_LIMIT);
  return rows.map(toFileImport);
}

// --- Systemzugriffe des Jobs `file-import` ------------------------------------------------------

export interface ClaimedFileImport {
  id: string;
  kind: FileImportKind;
  fileName: string;
  content: Uint8Array;
  attempts: number;
  /** Laut Upload vollständig (siehe `file_imports.complete`). */
  complete: boolean;
  /** Zeitpunkt des Uploads: Entities, die erst danach entstanden, gelten nie als fehlend. */
  uploadedAt: Date;
  /** Beim Upload von Hand angegebener Zeitraum der Kennzahlen (2b.2c), sonst `null`. */
  period: BulkPeriod | null;
}

export interface FileImportScope {
  organizationId: string;
  profileId: string;
}

export interface FileImportClaim {
  /** Abgeholte Datei oder `null`, wenn nichts offen ist bzw. eine Datei gerade läuft. */
  file: ClaimedFileImport | null;
  /** Unterwegs aufgegebene Dateien (Versuche erschöpft, Inhalt fehlt): der Lauf meldet sie als gescheitert. */
  abandoned: number;
}

const isStale = (startedAt: Date | null, now: Date) =>
  startedAt === null || now.getTime() - startedAt.getTime() >= FILE_IMPORT_STALE_MS;

/**
 * Holt die älteste offene Datei des Profils ab (`running`, `attempts + 1`). Eine Datei zur Zeit je Profil:
 * Läuft eine noch, kommt nichts. Hängt eine länger als `FILE_IMPORT_STALE_MS`, wird sie erneut abgeholt,
 * nach `FILE_IMPORT_MAX_ATTEMPTS` Versuchen aufgegeben; eine Datei ohne Inhalt ebenso. Aufgegebene Dateien
 * enden als `failed`, die Suche geht mit der nächsten weiter.
 */
export async function claimNextFileImport(
  db: Db,
  input: FileImportScope & { jobRunId: string; now: Date },
): Promise<FileImportClaim> {
  return db.transaction(async (tx) => {
    const open = await tx
      .select({
        id: fileImports.id,
        kind: fileImports.kind,
        fileName: fileImports.fileName,
        status: fileImports.status,
        attempts: fileImports.attempts,
        startedAt: fileImports.startedAt,
        complete: fileImports.complete,
        createdAt: fileImports.createdAt,
        periodStart: fileImports.periodStart,
        periodEnd: fileImports.periodEnd,
      })
      .from(fileImports)
      .where(
        and(
          eq(fileImports.organizationId, input.organizationId),
          eq(fileImports.profileId, input.profileId),
          inArray(fileImports.status, ['pending', 'running']),
        ),
      )
      .orderBy(asc(fileImports.createdAt), asc(fileImports.id))
      .for('update');

    // Läuft eine Datei noch (nicht hängend), wartet alles Weitere auf sie.
    if (open.some((row) => row.status === 'running' && !isStale(row.startedAt, input.now))) {
      return { file: null, abandoned: 0 };
    }

    let abandoned = 0;
    const giveUp = async (id: string, error: string) => {
      abandoned += 1;
      await closeFileImport(tx, {
        organizationId: input.organizationId,
        id,
        status: 'failed',
        error,
        counters: {},
        now: input.now,
      });
    };
    for (const candidate of open) {
      if (candidate.status === 'running' && candidate.attempts >= FILE_IMPORT_MAX_ATTEMPTS) {
        await giveUp(
          candidate.id,
          `Der Import wurde ${FILE_IMPORT_MAX_ATTEMPTS}-mal abgebrochen und nicht erneut versucht.`,
        );
        continue;
      }
      const [stored] = await tx
        .select({ content: fileImportContents.content })
        .from(fileImportContents)
        .where(eq(fileImportContents.fileImportId, candidate.id));
      if (!stored) {
        // Sollte nicht vorkommen: Der Inhalt geht erst am Ende des Imports.
        await giveUp(candidate.id, 'Der Inhalt der Datei fehlt.');
        continue;
      }
      const attempts = candidate.attempts + 1;
      await tx
        .update(fileImports)
        .set({ status: 'running', attempts, startedAt: input.now, jobRunId: input.jobRunId })
        .where(eq(fileImports.id, candidate.id));
      return {
        file: {
          id: candidate.id,
          kind: candidate.kind as FileImportKind,
          fileName: candidate.fileName,
          content: stored.content,
          attempts,
          complete: candidate.complete,
          uploadedAt: candidate.createdAt,
          period:
            candidate.periodStart !== null && candidate.periodEnd !== null
              ? { startDate: candidate.periodStart, endDate: candidate.periodEnd }
              : null,
        },
        abandoned,
      };
    }
    return { file: null, abandoned };
  });
}

interface CloseInput {
  organizationId: string;
  id: string;
  status: 'imported' | 'failed';
  error: string | null;
  counters: Record<string, number>;
  now: Date;
}

/** Setzt das Ergebnis und löscht den Inhalt (F5: keine Rohdateien aufbewahren, auch nicht nach Fehlschlag). */
async function closeFileImport(db: DbOrTx, input: CloseInput & { jobRunId?: string }) {
  const [closed] = await db
    .update(fileImports)
    .set({
      status: input.status,
      error: input.error,
      counters: input.counters,
      finishedAt: input.now,
    })
    .where(
      and(
        eq(fileImports.id, input.id),
        eq(fileImports.organizationId, input.organizationId),
        // Abschließen nur durch den Lauf, der die Datei hält; aufgeben auch eine wartende.
        input.jobRunId === undefined
          ? inArray(fileImports.status, ['pending', 'running'])
          : and(eq(fileImports.status, 'running'), eq(fileImports.jobRunId, input.jobRunId)),
      ),
    )
    .returning({
      id: fileImports.id,
      profileId: fileImports.profileId,
      fileName: fileImports.fileName,
      uploadedBy: fileImports.uploadedBy,
    });
  if (!closed) return false;
  // Benachrichtigung (5.2a, Dominik 2026-10-10): Erfolg an den Uploader, Fehler an ihn und die Org-Admins.
  const failed = input.status === 'failed';
  await createNotification(db, {
    organizationId: input.organizationId,
    profileId: closed.profileId,
    audience: failed ? 'admins' : 'recipient',
    recipientUserId: closed.uploadedBy,
    kind: failed ? 'file_import_failed' : 'file_import_imported',
    severity: failed ? 'error' : 'success',
    params: {
      fileName: closed.fileName,
      ...(failed && input.error !== null && { error: input.error }),
    },
    link: '/admin/connections',
    dedupeKey: `file_import:${closed.id}`,
  });
  await db
    .delete(fileImportContents)
    .where(
      and(
        eq(fileImportContents.fileImportId, input.id),
        eq(fileImportContents.organizationId, input.organizationId),
      ),
    );
  return true;
}

/**
 * Schließt eine Datei ab, die `jobRunId` abgeholt hat. Hat inzwischen ein neuerer Lauf sie übernommen
 * (hängender Lauf, nach `FILE_IMPORT_STALE_MS` erneut abgeholt), bleibt sein Ergebnis stehen: `false`.
 */
export function finishFileImport(
  db: DbOrTx,
  input: CloseInput & { jobRunId: string },
): Promise<boolean> {
  return db.transaction((tx) => closeFileImport(tx, input));
}

/**
 * Profile mit wartenden oder hängenden Dateien (plattformweit, für den Auslöser alle 10 Min.): So läuft ein
 * Import nach Absturz oder Deploy weiter, auch wenn kein neuer Upload kommt.
 */
export async function listProfilesWithOpenFileImports(
  db: Db,
  input: { now: Date },
): Promise<FileImportScope[]> {
  const staleBefore = new Date(input.now.getTime() - FILE_IMPORT_STALE_MS);
  return db
    .selectDistinct({
      organizationId: fileImports.organizationId,
      profileId: fileImports.profileId,
    })
    .from(fileImports)
    .where(
      or(
        eq(fileImports.status, 'pending'),
        and(eq(fileImports.status, 'running'), lte(fileImports.startedAt, staleBefore)),
      ),
    )
    .orderBy(fileImports.organizationId, fileImports.profileId);
}

/** Gibt es für das Profil jetzt etwas abzuholen (wartend oder hängend, und keine Datei läuft gerade)? */
export async function hasClaimableFileImport(
  db: Db,
  input: FileImportScope & { now: Date },
): Promise<boolean> {
  const open = await db
    .select({ status: fileImports.status, startedAt: fileImports.startedAt })
    .from(fileImports)
    .where(
      and(
        eq(fileImports.organizationId, input.organizationId),
        eq(fileImports.profileId, input.profileId),
        inArray(fileImports.status, ['pending', 'running']),
      ),
    );
  if (open.some((row) => row.status === 'running' && !isStale(row.startedAt, input.now))) {
    return false;
  }
  return open.length > 0;
}

/**
 * Wem gehören die Kampagnen einer Datei? Schutz gegen die Bulk-Datei eines anderen Kontos (1.11d, Dominik
 * 2026-10-07). `otherProfiles` = nicht entfernte Profile derselben Organisation, die schon eine dieser
 * Kampagnen-IDs haben (mit `isHidden`: Meldungen nennen nur sichtbare beim Namen); `existing` = echte,
 * nicht entfernte Kampagnen des Profils (ohne Platzhalter aus Berichten), `matched` = davon in der Datei.
 */
export async function campaignOwnership(
  db: DbOrTx,
  input: FileImportScope & { amazonCampaignIds: readonly string[] },
): Promise<{
  existing: number;
  matched: number;
  otherProfiles: Array<{ id: string; accountName: string; isHidden: boolean }>;
}> {
  const ids = sql.param([...new Set(input.amazonCampaignIds)]);
  const [counts] = await db.execute<{ existing: number; matched: number }>(sql`
    select count(*)::int as existing,
      (count(*) filter (where ${amazonAdsCampaigns.amazonCampaignId} = any(${ids}::text[])))::int as matched
    from ${amazonAdsCampaigns}
    where ${amazonAdsCampaigns.organizationId} = ${input.organizationId}
      and ${amazonAdsCampaigns.profileId} = ${input.profileId}
      and ${amazonAdsCampaigns.removedAt} is null
      and ${amazonAdsCampaigns.syncedAt} is not null`);
  const otherProfiles = await db
    .selectDistinct({
      id: amazonAdsProfiles.id,
      accountName: amazonAdsProfiles.accountName,
      isHidden: amazonAdsProfiles.isHidden,
    })
    .from(amazonAdsCampaigns)
    .innerJoin(amazonAdsProfiles, eq(amazonAdsProfiles.id, amazonAdsCampaigns.profileId))
    .where(
      and(
        eq(amazonAdsCampaigns.organizationId, input.organizationId),
        ne(amazonAdsCampaigns.profileId, input.profileId),
        isNull(amazonAdsProfiles.removedAt),
        sql`${amazonAdsCampaigns.amazonCampaignId} = any(${ids}::text[])`,
      ),
    )
    .orderBy(amazonAdsProfiles.accountName, amazonAdsProfiles.id);
  return { existing: counts?.existing ?? 0, matched: counts?.matched ?? 0, otherProfiles };
}

/**
 * Upload-Zeitpunkt der letzten erfolgreich importierten Bulk-Datei eines Profils, für ein `select` über
 * `amazon_ads_profiles` (`phase-1.md` 1.11f, Hinweis auf veraltete Daten). Der Upload liegt nah am Download in der
 * Konsole; das Ende des Imports kann bei Wiederholungen deutlich später sein.
 */
export function lastBulkImportAtSql(): SQL<Date | null> {
  // Ausdrücklich qualifiziert: `"id"` träfe in der Unterabfrage sonst die Zeile von `file_imports`.
  const profileId = sql`${sql.identifier(getTableName(amazonAdsProfiles))}.${sql.identifier(amazonAdsProfiles.id.name)}`;
  return sql<Date | null>`(
    select max(${fileImports.createdAt}) from ${fileImports}
    where ${fileImports.profileId} = ${profileId}
      and ${fileImports.kind} = 'bulk' and ${fileImports.status} = 'imported'
  )`.mapWith((value: string | Date | null) => (value === null ? null : new Date(value)));
}
