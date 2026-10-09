import {
  DEFAULT_STRUCTURE_CATALOG,
  structureCatalogSchema,
  type StructureCatalog,
} from '@profitbash/shared';
import { and, asc, count, eq, isNotNull, notInArray } from 'drizzle-orm';
import { getOrgRole } from './access';
import { recordAuditEvent } from './audit';
import type { Db } from './client';
import { clientPresets, clients, productGroups, structureCatalogs } from './schema';

/**
 * Struktur-Katalog (`docs/tasks/phase-4.md` 4.2, F11): ein Dokument je Organisation, lesbar für alle Mitglieder,
 * änderbar nur für Org-Admins. Presets je Client (hier) und je Produktgruppe (`product-groups.ts`) setzen Admins und
 * Editoren; die API prüft dazu das Feature `tools`.
 */

export type StructureCatalogErrorCode =
  'FORBIDDEN' | 'VERSION_CONFLICT' | 'NOT_FOUND' | 'UNKNOWN_PRESET';

export class StructureCatalogError extends Error {
  constructor(
    public readonly code: StructureCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StructureCatalogError';
  }
}

export interface StoredStructureCatalog {
  catalog: StructureCatalog;
  version: number;
  updatedAt: Date | null;
}

type Reader = Pick<Db, 'select'>;

/**
 * Katalog der Organisation ohne Rechteprüfung (für andere Module des Access-Layers). Ohne Zeile die Startwerte
 * (Version 0); ein Dokument, das nicht mehr zum Schema passt, fällt mit seiner Version auf die Startwerte zurück,
 * damit ein Admin es überschreiben kann.
 */
export async function loadStructureCatalog(
  db: Reader,
  orgId: string,
): Promise<StoredStructureCatalog> {
  const [row] = await db
    .select({
      catalog: structureCatalogs.catalog,
      version: structureCatalogs.version,
      updatedAt: structureCatalogs.updatedAt,
    })
    .from(structureCatalogs)
    .where(eq(structureCatalogs.organizationId, orgId));
  if (!row) return { catalog: DEFAULT_STRUCTURE_CATALOG, version: 0, updatedAt: null };
  const parsed = structureCatalogSchema.safeParse(row.catalog);
  return {
    catalog: parsed.success ? parsed.data : DEFAULT_STRUCTURE_CATALOG,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

export interface StructureCatalogView extends StoredStructureCatalog {
  clientPresets: { clientId: string; presetKey: string }[];
  /** Produktgruppen mit eigenem Preset je Preset (alle Profile der Organisation, nur Zahlen). */
  productGroupPresets: { presetKey: string; productGroups: number }[];
  clients: { id: string; name: string }[];
}

/** Katalog, Presets je Client und die Clients der Organisation; `null` für Nicht-Mitglieder. */
export async function getStructureCatalog(
  db: Db,
  input: { userId: string; orgId: string },
): Promise<StructureCatalogView | null> {
  if ((await getOrgRole(db, input.userId, input.orgId)) === null) return null;
  const stored = await loadStructureCatalog(db, input.orgId);
  const presets = await db
    .select({ clientId: clientPresets.clientId, presetKey: clientPresets.presetKey })
    .from(clientPresets)
    .where(eq(clientPresets.organizationId, input.orgId))
    .orderBy(asc(clientPresets.clientId));
  const orgClients = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.organizationId, input.orgId))
    .orderBy(asc(clients.name), asc(clients.id));
  const groupPresets = await db
    .select({ presetKey: productGroups.presetKey, productGroups: count() })
    .from(productGroups)
    .where(and(eq(productGroups.organizationId, input.orgId), isNotNull(productGroups.presetKey)))
    .groupBy(productGroups.presetKey)
    .orderBy(asc(productGroups.presetKey));
  return {
    ...stored,
    clientPresets: presets,
    productGroupPresets: groupPresets.map((row) => ({
      presetKey: row.presetKey!,
      productGroups: row.productGroups,
    })),
    clients: orgClients,
  };
}

/**
 * Speichert den Katalog (nur Org-Admins, `FORBIDDEN` sonst). `version` muss der gelesenen entsprechen
 * (`VERSION_CONFLICT`), danach zählt sie hoch. Audit `structure_catalog.update` mit Katalog vorher und nachher.
 * Der Katalog ist schon mit `structureCatalogSchema` geprüft. `null` für Nicht-Mitglieder.
 */
export async function saveStructureCatalog(
  db: Db,
  input: { userId: string; orgId: string; catalog: StructureCatalog; version: number },
): Promise<StoredStructureCatalog | null> {
  const role = await getOrgRole(db, input.userId, input.orgId);
  if (role === null) return null;
  if (role !== 'admin') {
    throw new StructureCatalogError('FORBIDDEN', 'Nur Admins ändern den Struktur-Katalog.');
  }
  try {
    return await saveInTransaction(db, input);
  } catch (error) {
    // Zwei gleichzeitige erste Speicherungen: Die zweite scheitert am Primärschlüssel.
    if (isUniqueViolation(error, 'structure_catalogs_pkey')) {
      throw new StructureCatalogError(
        'VERSION_CONFLICT',
        'Der Katalog wurde inzwischen geändert. Bitte neu laden.',
      );
    }
    throw error;
  }
}

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

function saveInTransaction(
  db: Db,
  input: { userId: string; orgId: string; catalog: StructureCatalog; version: number },
): Promise<StoredStructureCatalog> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ version: structureCatalogs.version })
      .from(structureCatalogs)
      .where(eq(structureCatalogs.organizationId, input.orgId))
      .for('update');
    const before = await loadStructureCatalog(tx, input.orgId);
    if ((current?.version ?? 0) !== input.version) {
      throw new StructureCatalogError(
        'VERSION_CONFLICT',
        'Der Katalog wurde inzwischen geändert. Bitte neu laden.',
      );
    }
    const version = input.version + 1;
    const updatedAt = new Date();
    const values = {
      catalog: input.catalog,
      version,
      updatedBy: input.userId,
      updatedAt,
    };
    // Gleichzeitiges erstes Speichern: Die zweite Anfrage scheitert am Primärschlüssel statt still zu überschreiben.
    if (current) {
      await tx
        .update(structureCatalogs)
        .set(values)
        .where(
          and(
            eq(structureCatalogs.organizationId, input.orgId),
            eq(structureCatalogs.version, input.version),
          ),
        );
    } else {
      await tx.insert(structureCatalogs).values({ organizationId: input.orgId, ...values });
    }
    // Zuordnungen zu Presets, die es nicht mehr gibt, lösen: Ein später neu angelegtes Preset mit demselben Schlüssel
    // bekäme sie sonst still.
    const keys = input.catalog.presets.map((preset) => preset.key);
    const clearedClients = await tx
      .delete(clientPresets)
      .where(
        and(
          eq(clientPresets.organizationId, input.orgId),
          notInArray(clientPresets.presetKey, keys),
        ),
      )
      .returning({ presetKey: clientPresets.presetKey });
    const dangling = and(
      eq(productGroups.organizationId, input.orgId),
      isNotNull(productGroups.presetKey),
      notInArray(productGroups.presetKey, keys),
    );
    // Schlüssel vorher lesen: `returning` liefert nach dem Leeren nur noch `null`.
    const clearedGroups = await tx
      .select({ presetKey: productGroups.presetKey })
      .from(productGroups)
      .where(dangling)
      .for('update');
    if (clearedGroups.length > 0) {
      await tx.update(productGroups).set({ presetKey: null, updatedAt }).where(dangling);
    }
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'structure_catalog.update',
      target: {
        type: 'structure_catalog',
        id: input.orgId,
        version,
        before: { version: before.version, catalog: before.catalog },
        after: input.catalog,
        clearedAssignments: {
          clients: clearedClients.length,
          productGroups: clearedGroups.length,
          presets: [
            ...new Set(
              [...clearedClients, ...clearedGroups].flatMap((row) =>
                row.presetKey ? [row.presetKey] : [],
              ),
            ),
          ].sort(),
        },
      },
    });
    return { catalog: input.catalog, version, updatedAt };
  });
}

/** `UNKNOWN_PRESET`, wenn der Schlüssel im Katalog der Organisation fehlt. */
export async function assertPresetKnown(db: Reader, orgId: string, presetKey: string | null) {
  if (presetKey === null) return;
  const { catalog } = await loadStructureCatalog(db, orgId);
  if (!catalog.presets.some((preset) => preset.key === presetKey)) {
    throw new StructureCatalogError('UNKNOWN_PRESET', 'Dieses Preset gibt es im Katalog nicht.');
  }
}

/**
 * Setzt oder löst (`null`) das Preset eines Clients der Organisation (Audit `client_preset.update`). `NOT_FOUND` für
 * fremde Clients, `UNKNOWN_PRESET`; `null` für Nicht-Mitglieder.
 */
export async function setClientPreset(
  db: Db,
  input: { userId: string; orgId: string; clientId: string; presetKey: string | null },
): Promise<true | null> {
  if ((await getOrgRole(db, input.userId, input.orgId)) === null) return null;
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.id, input.clientId), eq(clients.organizationId, input.orgId)));
    if (!owned) throw new StructureCatalogError('NOT_FOUND', 'Client nicht gefunden.');
    await assertPresetKnown(tx, input.orgId, input.presetKey);
    const [before] = await tx
      .select({ presetKey: clientPresets.presetKey })
      .from(clientPresets)
      .where(eq(clientPresets.clientId, input.clientId));
    if ((before?.presetKey ?? null) === input.presetKey) return true as const;
    if (input.presetKey === null) {
      await tx.delete(clientPresets).where(eq(clientPresets.clientId, input.clientId));
    } else {
      await tx
        .insert(clientPresets)
        .values({
          clientId: input.clientId,
          organizationId: input.orgId,
          presetKey: input.presetKey,
          updatedBy: input.userId,
        })
        .onConflictDoUpdate({
          target: clientPresets.clientId,
          set: { presetKey: input.presetKey, updatedBy: input.userId, updatedAt: new Date() },
        });
    }
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'client_preset.update',
      target: {
        type: 'client',
        id: input.clientId,
        before: before?.presetKey ?? null,
        after: input.presetKey,
      },
    });
    return true as const;
  });
}
