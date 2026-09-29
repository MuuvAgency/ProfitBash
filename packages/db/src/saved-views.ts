import {
  MAX_SAVED_VIEWS_PER_OWNER,
  savedViewStateSchema,
  stateMatchesArea,
  type SavedViewArea,
  type SavedViewState,
} from '@profitbash/shared';
import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { getOrgRole, listVisibleClientsAndProfiles, visibleProfilesScope } from './access';
import { recordAuditEvent, type DbOrTx } from './audit';
import type { Db } from './client';
import {
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsPortfolios,
  savedViews,
  users,
} from './schema';

/**
 * Gespeicherte Ansichten (`phase-2.md` F8, 2.9). Organisationsdaten wie Clients und Connections, aber für alle
 * Mitglieder: persönliche Ansichten sieht nur der Besitzer, freigegebene alle Mitglieder der Organisation. Ändern und
 * löschen dürfen Besitzer und Org-Admins; freigeben nur mit Schreibrecht im Feature des Bereichs (`canShare`, prüft die
 * API). Clients, Profile und Drill-Down-IDs im Zustand filtert der Access-Layer beim Speichern **und** beim Laden
 * (ADR 002, Geltungsbereich): Unsichtbares wird nie gespeichert und nie ausgeliefert.
 */

export type SavedViewErrorCode =
  'NOT_FOUND' | 'FORBIDDEN' | 'SHARE_FORBIDDEN' | 'NAME_TAKEN' | 'LIMIT_REACHED' | 'INVALID_STATE';

export class SavedViewError extends Error {
  constructor(
    public readonly code: SavedViewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SavedViewError';
  }
}

export interface SavedViewAccessInput {
  userId: string;
  orgId: string;
}

export interface SavedViewRecord {
  id: string;
  name: string;
  area: SavedViewArea;
  shared: boolean;
  owner: { id: string; name: string };
  own: boolean;
  canEdit: boolean;
  /** Zustand ohne Unsichtbares. */
  state: SavedViewState;
  /** Anzahl entfernter Clients, Profile und Drill-Down-IDs (nicht mehr sichtbar). */
  hiddenItems: number;
  createdAt: Date;
  updatedAt: Date;
}

const NAME_CONSTRAINT = 'saved_views_owner_area_name_uq';

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

const nameTaken = () =>
  new SavedViewError('NAME_TAKEN', 'Eine eigene Ansicht mit diesem Namen gibt es schon.');
const notFound = () => new SavedViewError('NOT_FOUND', 'Ansicht nicht gefunden.');

async function visibleEntityId(
  db: Db,
  input: SavedViewAccessInput,
  table: typeof amazonAdsPortfolios | typeof amazonAdsCampaigns | typeof amazonAdsAdGroups,
  id: string | null,
): Promise<string | null> {
  if (id === null) return null;
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), inArray(table.profileId, scope.ids)))
    .limit(1);
  return row?.id ?? null;
}

/** Zustand auf das Sichtbare beschränken (Access-Layer); zählt, was entfernt wurde. */
export async function filterSavedViewState(
  db: Db,
  input: SavedViewAccessInput,
  state: SavedViewState,
): Promise<{ state: SavedViewState; hiddenItems: number }> {
  const visible = await listVisibleClientsAndProfiles(db, input);
  const clientIds = new Set(visible.clients.map((c) => c.id));
  const profileIds = new Set(visible.profiles.map((p) => p.id));
  const { filters } = state;
  const keptClients = filters.clientIds.filter((id) => clientIds.has(id));
  const keptProfiles = filters.profileIds?.filter((id) => profileIds.has(id)) ?? null;
  let hiddenItems =
    filters.clientIds.length -
    keptClients.length +
    (filters.profileIds?.length ?? 0) -
    (keptProfiles?.length ?? 0);

  let explorer = state.explorer;
  if (explorer) {
    const { drill } = explorer;
    const kept = {
      portfolioId: await visibleEntityId(db, input, amazonAdsPortfolios, drill.portfolioId),
      campaignId: await visibleEntityId(db, input, amazonAdsCampaigns, drill.campaignId),
      adGroupId: await visibleEntityId(db, input, amazonAdsAdGroups, drill.adGroupId),
    };
    hiddenItems += (Object.keys(kept) as (keyof typeof kept)[]).filter(
      (key) => drill[key] !== null && kept[key] === null,
    ).length;
    explorer = { ...explorer, drill: kept };
  }

  return {
    state: {
      filters: {
        ...filters,
        clientIds: keptClients,
        profileIds: keptProfiles?.length ? keptProfiles : null,
      },
      ...(explorer && { explorer }),
    },
    hiddenItems,
  };
}

const columns = {
  id: savedViews.id,
  name: savedViews.name,
  area: savedViews.area,
  shared: savedViews.shared,
  ownerUserId: savedViews.ownerUserId,
  ownerName: users.name,
  state: savedViews.state,
  createdAt: savedViews.createdAt,
  updatedAt: savedViews.updatedAt,
};
type Row = {
  id: string;
  name: string;
  area: string;
  shared: boolean;
  ownerUserId: string;
  ownerName: string;
  state: unknown;
  createdAt: Date;
  updatedAt: Date;
};

/** Sichtbar: eigene Ansichten und die freigegebenen der Organisation. */
const visibleTo = (input: SavedViewAccessInput): SQL =>
  and(
    eq(savedViews.organizationId, input.orgId),
    or(eq(savedViews.ownerUserId, input.userId), eq(savedViews.shared, true)),
  )!;

async function toRecord(
  db: Db,
  input: SavedViewAccessInput,
  isAdmin: boolean,
  row: Row,
): Promise<SavedViewRecord | null> {
  // Ein Zustand, den das heutige Schema nicht kennt (ältere Version), wird nicht ausgeliefert.
  const parsed = savedViewStateSchema.safeParse(row.state);
  if (!parsed.success) return null;
  const own = row.ownerUserId === input.userId;
  const { state, hiddenItems } = await filterSavedViewState(db, input, parsed.data);
  return {
    id: row.id,
    name: row.name,
    area: row.area as SavedViewArea,
    shared: row.shared,
    owner: { id: row.ownerUserId, name: row.ownerName },
    own,
    canEdit: own || isAdmin,
    state,
    hiddenItems,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listSavedViews(
  db: Db,
  input: SavedViewAccessInput & { area: SavedViewArea },
): Promise<SavedViewRecord[]> {
  const role = await getOrgRole(db, input.userId, input.orgId);
  if (role === null) return [];
  const rows = await db
    .select(columns)
    .from(savedViews)
    .innerJoin(users, eq(users.id, savedViews.ownerUserId))
    .where(and(visibleTo(input), eq(savedViews.area, input.area)))
    .orderBy(
      desc(sql`${savedViews.ownerUserId} = ${input.userId}`),
      asc(sql`lower(${savedViews.name})`),
      asc(savedViews.id),
    );
  const records = await Promise.all(rows.map((row) => toRecord(db, input, role === 'admin', row)));
  return records.filter((record): record is SavedViewRecord => record !== null);
}

export async function getSavedView(
  db: Db,
  input: SavedViewAccessInput & { id: string },
): Promise<SavedViewRecord | null> {
  const role = await getOrgRole(db, input.userId, input.orgId);
  if (role === null) return null;
  const [row] = await db
    .select(columns)
    .from(savedViews)
    .innerJoin(users, eq(users.id, savedViews.ownerUserId))
    .where(and(visibleTo(input), eq(savedViews.id, input.id)))
    .limit(1);
  return row ? toRecord(db, input, role === 'admin', row) : null;
}

export interface CreateSavedViewInput extends SavedViewAccessInput {
  name: string;
  area: SavedViewArea;
  shared: boolean;
  state: SavedViewState;
  /** Schreibrecht im Feature des Bereichs (API). */
  canShare: boolean;
}

export async function createSavedView(
  db: Db,
  input: CreateSavedViewInput,
): Promise<SavedViewRecord> {
  const role = await getOrgRole(db, input.userId, input.orgId);
  if (role === null) throw notFound();
  if (input.shared && !input.canShare) {
    throw new SavedViewError('SHARE_FORBIDDEN', 'Freigeben erfordert Schreibrecht.');
  }
  if (!stateMatchesArea(input.area, input.state)) {
    throw new SavedViewError('INVALID_STATE', 'Zustand passt nicht zum Bereich.');
  }
  const { state, hiddenItems } = await filterSavedViewState(db, input, input.state);
  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ n: count() })
        .from(savedViews)
        .where(
          and(
            eq(savedViews.organizationId, input.orgId),
            eq(savedViews.ownerUserId, input.userId),
            eq(savedViews.area, input.area),
          ),
        );
      if ((existing?.n ?? 0) >= MAX_SAVED_VIEWS_PER_OWNER) {
        throw new SavedViewError(
          'LIMIT_REACHED',
          `Höchstens ${MAX_SAVED_VIEWS_PER_OWNER} eigene Ansichten je Bereich.`,
        );
      }
      const [row] = await tx
        .insert(savedViews)
        .values({
          organizationId: input.orgId,
          ownerUserId: input.userId,
          name: input.name,
          area: input.area,
          shared: input.shared,
          state,
        })
        .returning({ id: savedViews.id });
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'saved_view.create',
        target: {
          type: 'saved_view',
          id: row!.id,
          name: input.name,
          area: input.area,
          shared: input.shared,
        },
      });
      return row!.id;
    });
  } catch (err) {
    if (isUniqueViolation(err, NAME_CONSTRAINT)) throw nameTaken();
    throw err;
  }
  const record = (await getSavedView(db, { ...input, id }))!;
  // Beim Speichern entfernte Einträge melden (die gespeicherte Fassung enthält sie nicht mehr).
  return { ...record, hiddenItems: record.hiddenItems + hiddenItems };
}

/** Ansicht zum Ändern: sichtbar (sonst `NOT_FOUND`) und vom Nutzer änderbar (sonst `FORBIDDEN`). */
async function editable(db: DbOrTx, input: SavedViewAccessInput & { id: string }) {
  const role = await getOrgRole(db as Db, input.userId, input.orgId);
  if (role === null) throw notFound();
  const [row] = await db
    .select({
      id: savedViews.id,
      name: savedViews.name,
      area: savedViews.area,
      shared: savedViews.shared,
      ownerUserId: savedViews.ownerUserId,
    })
    .from(savedViews)
    .where(and(visibleTo(input), eq(savedViews.id, input.id)))
    .for('update')
    .limit(1);
  if (!row) throw notFound();
  if (row.ownerUserId !== input.userId && role !== 'admin') {
    throw new SavedViewError('FORBIDDEN', 'Nur Besitzer und Org-Admins ändern diese Ansicht.');
  }
  return { ...row, area: row.area as SavedViewArea };
}

export interface UpdateSavedViewInput extends SavedViewAccessInput {
  id: string;
  patch: { name?: string; shared?: boolean; state?: SavedViewState };
  canShare: boolean;
}

export async function updateSavedView(
  db: Db,
  input: UpdateSavedViewInput,
): Promise<SavedViewRecord> {
  const { patch } = input;
  const filtered = patch.state && (await filterSavedViewState(db, input, patch.state));
  const state = filtered?.state;
  try {
    await db.transaction(async (tx) => {
      const before = await editable(tx, input);
      if (patch.shared === true && !before.shared && !input.canShare) {
        throw new SavedViewError('SHARE_FORBIDDEN', 'Freigeben erfordert Schreibrecht.');
      }
      if (state && !stateMatchesArea(before.area, state)) {
        throw new SavedViewError('INVALID_STATE', 'Zustand passt nicht zum Bereich.');
      }
      const after = { name: patch.name ?? before.name, shared: patch.shared ?? before.shared };
      await tx
        .update(savedViews)
        .set({ ...after, ...(state && { state }) })
        .where(eq(savedViews.id, before.id));
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'saved_view.update',
        target: {
          type: 'saved_view',
          id: before.id,
          area: before.area,
          ownerUserId: before.ownerUserId,
          before: { name: before.name, shared: before.shared },
          after,
          stateChanged: state !== undefined,
        },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err, NAME_CONSTRAINT)) throw nameTaken();
    throw err;
  }
  const record = await getSavedView(db, input);
  // Nach dem Zurücknehmen der Freigabe durch einen Admin sieht nur noch der Besitzer die Ansicht.
  if (!record) throw notFound();
  return { ...record, hiddenItems: record.hiddenItems + (filtered?.hiddenItems ?? 0) };
}

export async function deleteSavedView(
  db: Db,
  input: SavedViewAccessInput & { id: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const view = await editable(tx, input);
    await tx.delete(savedViews).where(eq(savedViews.id, view.id));
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'saved_view.delete',
      target: {
        type: 'saved_view',
        id: view.id,
        name: view.name,
        area: view.area,
        shared: view.shared,
        ownerUserId: view.ownerUserId,
      },
    });
  });
}
