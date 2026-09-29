import { createHash } from 'node:crypto';
import {
  FILE_IMPORT_LIST_LIMIT,
  type FileImport,
  type FileImportKind,
  type FileImportStatus,
} from '@profitbash/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
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

type SummaryRow = { [K in keyof typeof summaryColumns]: (typeof summaryColumns)[K]['_']['data'] };

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

async function requireFileProfile(db: Db, input: Actor & { profileId: string }) {
  const role = await getOrgRole(db, input.userId, input.orgId);
  if (role !== 'admin') throw new AccessDeniedError('Nur Org-Admins importieren Dateien.');
  const visible = await canSeeProfile(db, { ...input, includeHidden: true, includeRemoved: true });
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
  enqueue: (tx: DbOrTx) => Promise<void>;
}

export async function createFileImport(db: Db, input: CreateFileImportInput): Promise<FileImport> {
  const profile = await requireFileProfile(db, input);
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
  await requireFileProfile(db, input);
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

/**
 * Holt die älteste offene Datei des Profils ab (`running`, `attempts + 1`). Eine Datei zur Zeit je Profil:
 * Läuft eine noch, kommt nichts. Hängt eine länger als `FILE_IMPORT_STALE_MS`, wird sie erneut abgeholt,
 * nach `FILE_IMPORT_MAX_ATTEMPTS` Versuchen als `failed` beendet.
 */
export async function claimNextFileImport(
  db: Db,
  input: FileImportScope & { jobRunId: string; now: Date },
): Promise<ClaimedFileImport | null> {
  return db.transaction(async (tx) => {
    const open = await tx
      .select({
        id: fileImports.id,
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

    let next: (typeof open)[number] | undefined;
    for (const candidate of open) {
      if (candidate.status === 'pending') {
        next ??= candidate;
        continue;
      }
      const stale =
        candidate.startedAt === null ||
        input.now.getTime() - candidate.startedAt.getTime() >= FILE_IMPORT_STALE_MS;
      if (!stale) return null;
      if (candidate.attempts >= FILE_IMPORT_MAX_ATTEMPTS) {
        await finishFileImport(tx, {
          organizationId: input.organizationId,
          id: candidate.id,
          status: 'failed',
          error: `Der Import wurde ${FILE_IMPORT_MAX_ATTEMPTS}-mal abgebrochen und nicht erneut versucht.`,
          counters: {},
          now: input.now,
        });
        continue;
      }
      next = candidate;
      break;
    }
    if (!next) return null;

    const [claimed] = await tx
      .update(fileImports)
      .set({
        status: 'running',
        attempts: next.attempts + 1,
        startedAt: input.now,
        jobRunId: input.jobRunId,
      })
      .where(eq(fileImports.id, next.id))
      .returning({
        id: fileImports.id,
        kind: fileImports.kind,
        fileName: fileImports.fileName,
        attempts: fileImports.attempts,
      });
    const [stored] = await tx
      .select({ content: fileImportContents.content })
      .from(fileImportContents)
      .where(eq(fileImportContents.fileImportId, next.id));
    if (!claimed) throw new Error('Abholen des Imports lieferte keine Zeile.');
    if (!stored) {
      // Ohne Inhalt lässt sich nichts importieren (sollte nicht vorkommen: der Inhalt geht erst am Ende).
      await finishFileImport(tx, {
        organizationId: input.organizationId,
        id: next.id,
        status: 'failed',
        error: 'Der Inhalt der Datei fehlt.',
        counters: {},
        now: input.now,
      });
      return null;
    }
    return { ...claimed, kind: claimed.kind as FileImportKind, content: stored.content };
  });
}

export async function finishFileImport(
  db: DbOrTx,
  input: {
    organizationId: string;
    id: string;
    status: 'imported' | 'failed';
    error: string | null;
    counters: Record<string, number>;
    now: Date;
  },
): Promise<void> {
  const scope = and(
    eq(fileImports.id, input.id),
    eq(fileImports.organizationId, input.organizationId),
  );
  await db
    .update(fileImports)
    .set({
      status: input.status,
      error: input.error,
      counters: input.counters,
      finishedAt: input.now,
    })
    .where(scope);
  // Keine Rohdateien aufbewahren (F5), auch nicht nach einem Fehlschlag.
  await db
    .delete(fileImportContents)
    .where(
      and(
        eq(fileImportContents.fileImportId, input.id),
        eq(fileImportContents.organizationId, input.organizationId),
      ),
    );
}
