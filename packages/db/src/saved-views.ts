import {
  DEFAULT_ATTRIBUTION_SETTING,
  DEFAULT_COMPARISON_MODE,
  DEFAULT_PERIOD_PRESET,
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
  /** Von der eingeschränkten Auswahl ist nichts sichtbar (`FilteredSavedViewState`). */
  selectionHidden: boolean;
  /** Gespeicherter Zustand passt nicht mehr zum Schema; `state` ist der Standard des Bereichs. */
  outdated: boolean;
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
  new SavedViewError('NAME_TAKEN', 'Der Besitzer hat schon eine Ansicht mit diesem Namen.');
const notFound = () => new SavedViewError('NOT_FOUND', 'Ansicht nicht gefunden.');

type DrillTable = typeof amazonAdsPortfolios | typeof amazonAdsCampaigns | typeof amazonAdsAdGroups;
const DRILL_TABLES = {
  portfolioId: amazonAdsPortfolios,
  campaignId: amazonAdsCampaigns,
  adGroupId: amazonAdsAdGroups,
} as const satisfies Record<keyof NonNullable<SavedViewState['explorer']>['drill'], DrillTable>;
type DrillKey = keyof typeof DRILL_TABLES;

/**
 * Sichtbarkeit des Nutzers, einmal je Anfrage geladen (Access-Layer): sichtbare Clients und Profile, dazu die sichtbaren
 * Drill-Down-IDs der genannten Zustände (eine Abfrage je Entity-Tabelle statt je Ansicht).
 */
export interface SavedViewVisibility {
  clientIds: Set<string>;
  profileIds: Set<string>;
  drillIds: Record<DrillKey, Set<string>>;
}

export async function loadSavedViewVisibility(
  db: Db,
  input: SavedViewAccessInput,
  states: readonly SavedViewState[],
): Promise<SavedViewVisibility> {
  const visible = await listVisibleClientsAndProfiles(db, input);
  const drillIds = {
    portfolioId: new Set<string>(),
    campaignId: new Set<string>(),
    adGroupId: new Set<string>(),
  };
  const scope = await visibleProfilesScope(db, input);
  if (scope !== null) {
    for (const key of Object.keys(DRILL_TABLES) as DrillKey[]) {
      const wanted = [...new Set(states.flatMap((state) => state.explorer?.drill[key] ?? []))];
      if (wanted.length === 0) continue;
      const table: DrillTable = DRILL_TABLES[key];
      const rows = await db
        .select({ id: table.id })
        .from(table)
        .where(and(inArray(table.id, wanted), inArray(table.profileId, scope.ids)));
      for (const row of rows) drillIds[key].add(row.id);
    }
  }
  return {
    clientIds: new Set(visible.clients.map((c) => c.id)),
    profileIds: new Set(visible.profiles.map((p) => p.id)),
    drillIds,
  };
}

export interface FilteredSavedViewState {
  state: SavedViewState;
  /** Anzahl entfernter Clients, Profile und Drill-Down-IDs. */
  hiddenItems: number;
  /**
   * Die Ansicht schränkte auf Clients bzw. Profile ein, von denen nichts sichtbar bleibt. Der gefilterte Zustand hieße
   * dann „alle“; das Web lädt die Auswahl deshalb nicht, sondern sagt es.
   */
  selectionHidden: boolean;
}

/** Zustand auf das Sichtbare beschränken (Access-Layer); zählt, was entfernt wurde. */
export function applySavedViewVisibility(
  visibility: SavedViewVisibility,
  state: SavedViewState,
): FilteredSavedViewState {
  const { filters } = state;
  const keptClients = filters.clientIds.filter((id) => visibility.clientIds.has(id));
  const keptProfiles = filters.profileIds?.filter((id) => visibility.profileIds.has(id)) ?? null;
  let hiddenItems =
    filters.clientIds.length -
    keptClients.length +
    (filters.profileIds?.length ?? 0) -
    (keptProfiles?.length ?? 0);
  const restricted =
    filters.clientIds.length > 0 || filters.withoutClient || (filters.profileIds?.length ?? 0) > 0;
  const stillRestricted =
    keptClients.length > 0 || filters.withoutClient || (keptProfiles?.length ?? 0) > 0;

  let explorer = state.explorer;
  if (explorer) {
    const { drill } = explorer;
    const keep = (key: DrillKey) => {
      const id = drill[key];
      return id !== null && visibility.drillIds[key].has(id) ? id : null;
    };
    const kept = {
      portfolioId: keep('portfolioId'),
      campaignId: keep('campaignId'),
      adGroupId: keep('adGroupId'),
    };
    hiddenItems += (Object.keys(kept) as DrillKey[]).filter(
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
    selectionHidden: restricted && !stillRestricted,
  };
}

/** Zustand auf das Sichtbare beschränken (ein Zustand, z. B. beim Speichern). */
export async function filterSavedViewState(
  db: Db,
  input: SavedViewAccessInput,
  state: SavedViewState,
): Promise<FilteredSavedViewState> {
  return applySavedViewVisibility(await loadSavedViewVisibility(db, input, [state]), state);
}

/**
 * Ersatz für einen Zustand, den das heutige Schema nicht mehr kennt (ältere Version): Standard des Bereichs, damit die
 * Ansicht sichtbar bleibt und sich überschreiben oder löschen lässt.
 */
function fallbackState(area: SavedViewArea): SavedViewState {
  return {
    filters: {
      clientIds: [],
      withoutClient: false,
      profileIds: null,
      period: { preset: DEFAULT_PERIOD_PRESET },
      comparison: DEFAULT_COMPARISON_MODE,
      currency: 'auto',
      attribution: DEFAULT_ATTRIBUTION_SETTING,
    },
    ...(area === 'explorer' && {
      explorer: {
        level: 'campaign',
        drill: { portfolioId: null, campaignId: null, adGroupId: null },
        includeRemoved: false,
        adProducts: [],
        chartMetrics: ['cost', 'sales'],
        columns: null,
        sort: null,
      },
    }),
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

function parseRow(row: Row): { state: SavedViewState; outdated: boolean } {
  const parsed = savedViewStateSchema.safeParse(row.state);
  const area = row.area as SavedViewArea;
  return parsed.success && stateMatchesArea(area, parsed.data)
    ? { state: parsed.data, outdated: false }
    : { state: fallbackState(area), outdated: true };
}

function toRecord(
  input: SavedViewAccessInput,
  isAdmin: boolean,
  row: Row,
  parsed: { state: SavedViewState; outdated: boolean },
  visibility: SavedViewVisibility,
): SavedViewRecord {
  const own = row.ownerUserId === input.userId;
  const filtered = applySavedViewVisibility(visibility, parsed.state);
  return {
    id: row.id,
    name: row.name,
    area: row.area as SavedViewArea,
    shared: row.shared,
    owner: { id: row.ownerUserId, name: row.ownerName },
    own,
    canEdit: own || isAdmin,
    ...filtered,
    outdated: parsed.outdated,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function toRecords(
  db: Db,
  input: SavedViewAccessInput,
  isAdmin: boolean,
  rows: readonly Row[],
): Promise<SavedViewRecord[]> {
  const parsed = rows.map(parseRow);
  const visibility = await loadSavedViewVisibility(
    db,
    input,
    parsed.map((p) => p.state),
  );
  return rows.map((row, index) => toRecord(input, isAdmin, row, parsed[index]!, visibility));
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
  return toRecords(db, input, role === 'admin', rows);
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
  if (!row) return null;
  const [record] = await toRecords(db, input, role === 'admin', [row]);
  return record ?? null;
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
  const saved = await filterSavedViewState(db, input, input.state);
  const { state } = saved;
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
  return withSaveFilter((await loadEdited(db, input, role === 'admin', id))!, saved);
}

/** Beim Speichern Entferntes melden (die gespeicherte Fassung enthält es nicht mehr). */
function withSaveFilter(
  record: SavedViewRecord,
  saved: FilteredSavedViewState | undefined,
): SavedViewRecord {
  if (!saved) return record;
  return {
    ...record,
    hiddenItems: record.hiddenItems + saved.hiddenItems,
    selectionHidden: record.selectionHidden || saved.selectionHidden,
  };
}

/**
 * Ansicht nach einer eigenen Änderung, ohne die Regel „eigene oder freigegebene“: Nimmt ein Admin die Freigabe einer
 * fremden Ansicht zurück, sieht er sie danach nicht mehr, bekommt aber das Ergebnis seiner Änderung.
 */
async function loadEdited(
  db: Db,
  input: SavedViewAccessInput,
  isAdmin: boolean,
  id: string,
): Promise<SavedViewRecord | null> {
  const [row] = await db
    .select(columns)
    .from(savedViews)
    .innerJoin(users, eq(users.id, savedViews.ownerUserId))
    .where(and(eq(savedViews.organizationId, input.orgId), eq(savedViews.id, id)))
    .limit(1);
  if (!row) return null;
  const [record] = await toRecords(db, input, isAdmin, [row]);
  return record ?? null;
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
  return { ...row, area: row.area as SavedViewArea, isAdmin: role === 'admin' };
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
  let isAdmin = false;
  try {
    await db.transaction(async (tx) => {
      const before = await editable(tx, input);
      isAdmin = before.isAdmin;
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
  const record = await loadEdited(db, input, isAdmin, input.id);
  if (!record) throw notFound();
  return withSaveFilter(record, filtered);
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
