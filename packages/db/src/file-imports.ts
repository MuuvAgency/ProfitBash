import { createHash } from 'node:crypto';
import {
  FILE_IMPORT_LIST_LIMIT,
  type FileImport,
  type FileImportKind,
  type FileImportStatus,
} from '@profitbash/shared';
import { and, asc, desc, eq, inArray, lte, or } from 'drizzle-orm';
import { AccessDeniedError, canSeeProfile, getOrgRole } from './access';
import { recordAuditEvent, type DbOrTx } from './audit';
import type { Db } from './client';
import { amazonAdsProfiles, fileImportContents, fileImports } from './schema';

/**
 * Hochgeladene Dateien aus der Werbekonsole und ihr Import (`phase-1.md` 1.11c). Nutzerseitig (Upload,
 * Liste) über den Access-Layer (`canSeeProfile`, ADR 002), dazu die Systemzugriffe des Jobs `file-import`
 * (Abholen, Abschließen). Hochladen dürfen Org-Admins, nur für Profile ohne Connection: Bei API-Profilen
 * überschriebe der tägliche Sync die Daten aus der Datei.
 */

export type FileImportErrorCode = 'PROFILE_NOT_FOUND' | 'PROFILE_HAS_CONNECTION' | 'EMPTY_FILE';

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
  status: fileImports.status,
  error: fileImports.error,
  counters: fileImports.counters,
  uploadedBy: fileImports.uploadedBy,
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
    .select({ connectionId: amazonAdsProfiles.connectionId })
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
    .returning({ id: fileImports.id });
  if (!closed) return false;
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
  return closeFileImport(db, input);
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
