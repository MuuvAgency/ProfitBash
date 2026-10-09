import {
  MAX_TAGS_PER_ORGANIZATION,
  TAG_ENTITY_TYPES,
  type TagColor,
  type TagEntityType,
} from '@profitbash/shared';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { getOrgRole, visibleProfilesScope } from './access';
import { chunks, loadEntities } from './ad-change-entities';
import { recordAuditEvent } from './audit';
import type { Db } from './client';
import { tagAssignments, tags } from './schema';

/**
 * Eigene Tags (`docs/tasks/phase-3.md` 3.7, F7). Tags sind Organisationsdaten (für alle Mitglieder lesbar wie die
 * Suchbegriff-Regeln); Zuweisungen hängen an Entities und laufen über `visibleProfilesScope()` (ADR 002): Zuweisen
 * und Lösen nur für Entities sichtbarer Profile, Zähler nur über sichtbare Profile. Das Recht (`write` bzw. `view`
 * im Feature `tags`) prüft die API. Namen und Farben sind mit zod geprüft (`createTagRequestSchema`).
 */

export type TagErrorCode = 'NOT_FOUND' | 'NAME_TAKEN' | 'LIMIT_REACHED';

export class TagError extends Error {
  constructor(
    public readonly code: TagErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TagError';
  }
}

const NAME_CONSTRAINT = 'tags_org_name_uq';
const nameTaken = () => new TagError('NAME_TAKEN', 'Ein Tag mit diesem Namen gibt es schon.');
const notFound = () => new TagError('NOT_FOUND', 'Tag nicht gefunden.');

function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const { code, constraint_name: name } = current as {
      code?: unknown;
      constraint_name?: unknown;
    };
    if (code === '23505' && name === constraint) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface TagAccessInput {
  userId: string;
  orgId: string;
}

export type TagCounts = Record<TagEntityType, number>;

export interface TagRecord {
  id: string;
  name: string;
  color: TagColor;
  /** Zuweisungen in den sichtbaren Profilen. */
  counts: TagCounts;
  createdAt: Date;
  updatedAt: Date;
}

const noCounts = (): TagCounts => ({ campaign: 0, ad_group: 0, target: 0, product_ad: 0 });

const tagColumns = {
  id: tags.id,
  name: tags.name,
  color: tags.color,
  createdAt: tags.createdAt,
  updatedAt: tags.updatedAt,
};
type TagRow = { id: string; name: string; color: string; createdAt: Date; updatedAt: Date };
const record = (row: TagRow, counts: TagCounts = noCounts()): TagRecord => ({
  ...row,
  color: row.color as TagColor,
  counts,
});

/** Tags der Organisation nach Name, mit den Zuweisungen in sichtbaren Profilen; `null` für Nicht-Mitglieder. */
export async function listTags(db: Db, input: TagAccessInput): Promise<TagRecord[] | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const rows = await db
    .select(tagColumns)
    .from(tags)
    .where(eq(tags.organizationId, input.orgId))
    .orderBy(asc(sql`lower(${tags.name})`), asc(tags.id));
  const a = tagAssignments;
  const counted = await db
    .select({ tagId: a.tagId, entityType: a.entityType, assignments: count() })
    .from(a)
    .where(and(eq(a.organizationId, input.orgId), inArray(a.profileId, scope.ids)))
    .groupBy(a.tagId, a.entityType);
  const counts = new Map<string, TagCounts>();
  for (const row of counted) {
    const entry = counts.get(row.tagId) ?? noCounts();
    if ((TAG_ENTITY_TYPES as readonly string[]).includes(row.entityType)) {
      entry[row.entityType as TagEntityType] = row.assignments;
    }
    counts.set(row.tagId, entry);
  }
  return rows.map((row) => record(row, counts.get(row.id)));
}

/**
 * Legt ein Tag an (Audit `tag.create`). `TagError` `NAME_TAKEN` bzw. `LIMIT_REACHED`
 * (`MAX_TAGS_PER_ORGANIZATION`); `null` für Nicht-Mitglieder.
 */
export async function createTag(
  db: Db,
  input: TagAccessInput & { name: string; color: TagColor },
): Promise<TagRecord | null> {
  if ((await getOrgRole(db, input.userId, input.orgId)) === null) return null;
  try {
    return await db.transaction(async (tx) => {
      // Anlegen je Organisation nacheinander: Sonst kämen zwei gleichzeitige Anfragen beide unter der Höchstzahl durch.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`tags:${input.orgId}`}, 0))`,
      );
      const [{ existing } = { existing: 0 }] = await tx
        .select({ existing: count() })
        .from(tags)
        .where(eq(tags.organizationId, input.orgId));
      if (existing >= MAX_TAGS_PER_ORGANIZATION) {
        throw new TagError('LIMIT_REACHED', 'Die Organisation hat schon die Höchstzahl an Tags.');
      }
      const [row] = await tx
        .insert(tags)
        .values({
          organizationId: input.orgId,
          name: input.name,
          color: input.color,
          createdBy: input.userId,
        })
        .returning(tagColumns);
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'tag.create',
        target: { type: 'tag', id: row!.id, name: row!.name, color: row!.color },
      });
      return record(row!);
    });
  } catch (err) {
    if (isUniqueViolation(err, NAME_CONSTRAINT)) throw nameTaken();
    throw err;
  }
}

/** Ändert Name und/oder Farbe (Audit `tag.update` mit vorher/nachher). `TagError` `NOT_FOUND`, `NAME_TAKEN`. */
export async function updateTag(
  db: Db,
  input: TagAccessInput & { id: string; name?: string; color?: TagColor },
): Promise<TagRecord | null> {
  if ((await getOrgRole(db, input.userId, input.orgId)) === null) return null;
  const own = and(eq(tags.id, input.id), eq(tags.organizationId, input.orgId));
  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx
        .select({ name: tags.name, color: tags.color })
        .from(tags)
        .where(own)
        .for('update');
      if (!before) throw notFound();
      const changed =
        (input.name !== undefined && input.name !== before.name) ||
        (input.color !== undefined && input.color !== before.color);
      if (!changed) {
        const [same] = await tx.select(tagColumns).from(tags).where(own);
        return record(same!);
      }
      const [row] = await tx
        .update(tags)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.color !== undefined && { color: input.color }),
          updatedAt: new Date(),
        })
        .where(own)
        .returning(tagColumns);
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'tag.update',
        target: {
          type: 'tag',
          id: input.id,
          before,
          after: { name: row!.name, color: row!.color },
        },
      });
      return record(row!);
    });
  } catch (err) {
    if (isUniqueViolation(err, NAME_CONSTRAINT)) throw nameTaken();
    throw err;
  }
}

/**
 * Löscht ein Tag samt allen Zuweisungen, auch denen in ausgeblendeten Profilen (das Tag gehört der Organisation).
 * Audit `tag.delete` mit Name und Zahl der Zuweisungen. `true`, `TagError` `NOT_FOUND`; `null` für Nicht-Mitglieder.
 */
export async function deleteTag(
  db: Db,
  input: TagAccessInput & { id: string },
): Promise<true | null> {
  if ((await getOrgRole(db, input.userId, input.orgId)) === null) return null;
  return db.transaction(async (tx) => {
    const [{ assignments } = { assignments: 0 }] = await tx
      .select({ assignments: count() })
      .from(tagAssignments)
      .where(
        and(eq(tagAssignments.tagId, input.id), eq(tagAssignments.organizationId, input.orgId)),
      );
    const [deleted] = await tx
      .delete(tags)
      .where(and(eq(tags.id, input.id), eq(tags.organizationId, input.orgId)))
      .returning({ name: tags.name });
    if (!deleted) throw notFound();
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'tag.delete',
      target: { type: 'tag', id: input.id, name: deleted.name, assignments },
    });
    return true as const;
  });
}

export interface AssignTagsInput extends TagAccessInput {
  entityType: TagEntityType;
  /** Interne IDs der Entities. */
  entityIds: readonly string[];
  addTagIds?: readonly string[] | undefined;
  removeTagIds?: readonly string[] | undefined;
}

export interface AssignTagsResult {
  added: number;
  removed: number;
  /** Genannte Entities, die es nicht gibt oder die der Nutzer nicht sieht (auch: andere Art von Entity). */
  skippedEntities: number;
}

/**
 * Hängt Tags an Entities einer Art und löst andere (Bulk). Nur Entities sichtbarer Profile; unbekannte und
 * unsichtbare werden gezählt und übersprungen. Nennt die Anfrage ein Tag, das nicht der Organisation gehört:
 * `TagError` `NOT_FOUND`, nichts wird geändert. Ein Audit-Event `tags.assign` je Anfrage, wenn sich etwas geändert
 * hat. `null` für Nicht-Mitglieder.
 */
export async function assignTags(db: Db, input: AssignTagsInput): Promise<AssignTagsResult | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const addTagIds = [...new Set(input.addTagIds ?? [])];
  // Beides genannt: Hinzufügen gewinnt.
  const removeTagIds = [...new Set(input.removeTagIds ?? [])].filter(
    (id) => !addTagIds.includes(id),
  );
  const wanted = [...addTagIds, ...removeTagIds];

  return db.transaction(async (tx) => {
    const known =
      wanted.length === 0
        ? []
        : await tx
            .select({ id: tags.id })
            .from(tags)
            .where(and(eq(tags.organizationId, input.orgId), inArray(tags.id, wanted)))
            // Gegen gleichzeitiges Löschen des Tags.
            .for('share');
    if (known.length !== wanted.length) throw notFound();

    const entityIds = [...new Set(input.entityIds)];
    const entities = await loadEntities(tx, scope, input.entityType, entityIds);
    const a = tagAssignments;
    let added = 0;
    let removed = 0;
    if (addTagIds.length > 0) {
      // In fester Reihenfolge einfügen: Zwei überlappende Anfragen sperrten sich sonst gegenseitig (Deadlock).
      const values = [...entities.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .flatMap((entity) =>
          [...addTagIds].sort().map((tagId) => ({
            tagId,
            organizationId: entity.organizationId,
            profileId: entity.profileId,
            entityType: input.entityType,
            entityId: entity.id,
            createdBy: input.userId,
          })),
        );
      for (const part of chunks(values)) {
        const inserted = await tx
          .insert(a)
          .values(part)
          .onConflictDoNothing()
          .returning({ tagId: a.tagId });
        added += inserted.length;
      }
    }
    if (removeTagIds.length > 0) {
      for (const part of chunks([...entities.keys()])) {
        const deleted = await tx
          .delete(a)
          .where(
            and(
              inArray(a.tagId, removeTagIds),
              eq(a.entityType, input.entityType),
              inArray(a.entityId, part),
            ),
          )
          .returning({ tagId: a.tagId });
        removed += deleted.length;
      }
    }
    if (added + removed > 0) {
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'tags.assign',
        target: {
          type: 'tags',
          id: input.orgId,
          entityType: input.entityType,
          entities: entities.size,
          addTagIds,
          removeTagIds,
          added,
          removed,
        },
      });
    }
    return { added, removed, skippedEntities: entityIds.length - entities.size };
  });
}
