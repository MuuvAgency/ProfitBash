import {
  ATTRIBUTION_SETTINGS,
  dateRangeSchema,
  DEFAULT_ATTRIBUTION_SETTING,
  type AttributionSetting,
} from '@profitbash/shared';
import type { LocationQuery, LocationQueryRaw } from 'vue-router';
import {
  comparisonRange,
  DEFAULT_COMPARISON_MODE,
  DEFAULT_PERIOD_PRESET,
  isComparisonMode,
  isPeriodPreset,
  resolvePeriod,
  type ComparisonMode,
  type DateRange,
  type PeriodSelection,
} from './periods';

/**
 * Zustand der Filterleiste (`phase-2.md` F2–F5), geteilt zwischen Dashboard und Explorer. Die URL enthält nur Kurzes
 * (Zeitraum, Vergleich, Währung, Attribution, Client-IDs); die Liste einzelner Profile steht in `ui_state` und in der
 * URL nur als Merker `pf=1` (Regel „viele IDs nie im Query-String“).
 */
export interface FilterState {
  /** Clients, deren Profile ganz oder teilweise gewählt sind; leer (und ohne `withoutClient`) = alle. */
  clientIds: string[];
  /** Profile ohne Client („Ohne Client“). */
  withoutClient: boolean;
  /** Einzelne Profile innerhalb der Clients; `null` = alle Profile der gewählten Clients. */
  profileIds: string[] | null;
  period: PeriodSelection;
  comparison: ComparisonMode;
  /** `auto` oder ein Währungscode aus den wählbaren Währungen. */
  currency: string;
  attribution: AttributionSetting;
}

export const DEFAULT_FILTER_STATE: FilterState = Object.freeze({
  clientIds: [],
  withoutClient: false,
  profileIds: null,
  period: { preset: DEFAULT_PERIOD_PRESET },
  comparison: DEFAULT_COMPARISON_MODE,
  currency: 'auto',
  attribution: DEFAULT_ATTRIBUTION_SETTING,
}) as FilterState;

/** Höchstzahl gespeicherter Profile, wie die API (`profileIds` bis 1000). `ui_state` fasst 16 KB, also rund 400 IDs. */
const MAX_STORED_PROFILES = 1000;

/** Parameter der Filterleiste in der URL. Andere Parameter (Reiter, Drill-Down) gehören der Seite. */
export const FILTER_QUERY_KEYS = [
  'clients',
  'nc',
  'pf',
  'period',
  'from',
  'to',
  'cmp',
  'cur',
  'attr',
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;

function queryString(value: LocationQuery[string] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : undefined;
}

function isAttribution(value: unknown): value is AttributionSetting {
  return typeof value === 'string' && (ATTRIBUTION_SETTINGS as readonly string[]).includes(value);
}

function isCurrency(value: unknown): value is string {
  return value === 'auto' || (typeof value === 'string' && CURRENCY.test(value));
}

function validRange(range: unknown): DateRange | undefined {
  const parsed = dateRangeSchema.safeParse(range);
  return parsed.success ? parsed.data : undefined;
}

function period(preset: unknown, range: unknown): PeriodSelection {
  if (!isPeriodPreset(preset)) return { preset: DEFAULT_PERIOD_PRESET };
  if (preset !== 'custom') return { preset };
  const valid = validRange(range);
  return valid ? { preset, range: valid } : { preset: DEFAULT_PERIOD_PRESET };
}

const uniqueSorted = (ids: string[]) => [...new Set(ids)].sort();

function uuidList(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  return value.every((id) => typeof id === 'string' && UUID.test(id))
    ? uniqueSorted(value as string[])
    : undefined;
}

/** Gespeicherte Auswahl (`ui_state`) prüfen; ungültig → `null` (dann gilt der Standard). */
export function parseStoredFilters(value: unknown): FilterState | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const clientIds = uuidList(v.clientIds, 500);
  // Eine ungültige Profilliste kostet nur die Profilauswahl, nicht die ganze Auswahl.
  const profileIds =
    v.profileIds === null ? null : (uuidList(v.profileIds, MAX_STORED_PROFILES) ?? null);
  const p = v.period as Record<string, unknown> | undefined;
  if (
    clientIds === undefined ||
    typeof v.withoutClient !== 'boolean' ||
    !isPeriodPreset(p?.preset) ||
    !isComparisonMode(v.comparison) ||
    !isCurrency(v.currency) ||
    !isAttribution(v.attribution)
  ) {
    return null;
  }
  return {
    clientIds,
    withoutClient: v.withoutClient,
    profileIds: profileIds?.length ? profileIds : null,
    period: period(p.preset, p.range),
    comparison: v.comparison,
    currency: v.currency,
    attribution: v.attribution,
  };
}

/**
 * Zustand aus der URL. Ohne Filter-Parameter gilt die letzte Auswahl (`stored`, sonst der Standard). Mit Parametern
 * gelten nur diese; gespeicherte Profile nur mit dem Merker `pf=1` (ein geteilter Link ohne Merker zeigt die Clients
 * ganz).
 */
export function filterStateFromQuery(
  query: LocationQuery,
  stored: FilterState | null,
): FilterState {
  const hasFilter = FILTER_QUERY_KEYS.some((key) => query[key] !== undefined);
  if (!hasFilter) return stored ?? DEFAULT_FILTER_STATE;

  const get = (key: (typeof FILTER_QUERY_KEYS)[number]) => queryString(query[key]);
  const clients = get('clients')?.split(',') ?? [];
  const cmp = get('cmp');
  const cur = get('cur');
  const attr = get('attr');
  return {
    clientIds: clients.every((id) => UUID.test(id)) ? uniqueSorted(clients) : [],
    withoutClient: get('nc') === '1',
    profileIds: get('pf') === '1' ? (stored?.profileIds ?? null) : null,
    period: period(get('period') ?? DEFAULT_PERIOD_PRESET, { from: get('from'), to: get('to') }),
    comparison: isComparisonMode(cmp) ? cmp : DEFAULT_COMPARISON_MODE,
    currency: isCurrency(cur) ? cur : 'auto',
    attribution: isAttribution(attr) ? attr : DEFAULT_ATTRIBUTION_SETTING,
  };
}

/** Kurzer Zustand für die URL; Standardwerte fehlen, damit Links kurz bleiben. */
export function filterStateToQuery(state: FilterState): Record<string, string> {
  const query: Record<string, string> = {};
  if (state.clientIds.length) query.clients = uniqueSorted(state.clientIds).join(',');
  if (state.withoutClient) query.nc = '1';
  if (state.profileIds?.length) query.pf = '1';
  if (state.period.preset !== DEFAULT_PERIOD_PRESET) query.period = state.period.preset;
  if (state.period.preset === 'custom' && state.period.range) {
    query.from = state.period.range.from;
    query.to = state.period.range.to;
  }
  if (state.comparison !== DEFAULT_COMPARISON_MODE) query.cmp = state.comparison;
  if (state.currency !== 'auto') query.cur = state.currency;
  if (state.attribution !== DEFAULT_ATTRIBUTION_SETTING) query.attr = state.attribution;
  return query;
}

/** URL der Seite mit neuem Filter: andere Parameter bleiben, die der Filterleiste werden ersetzt. */
export function mergeFilterQuery(current: LocationQuery, state: FilterState): LocationQueryRaw {
  const rest = Object.fromEntries(
    Object.entries(current).filter(
      ([key]) => !(FILTER_QUERY_KEYS as readonly string[]).includes(key),
    ),
  );
  return { ...rest, ...filterStateToQuery(state) };
}

export interface FilterOptionsLike {
  clients: { id: string; name: string }[];
  profiles: { id: string; clientId: string | null }[];
  currencies?: string[];
}

/**
 * Auswahl an die sichtbaren Clients und Profile anpassen (ADR 002: der Server filtert ohnehin; hier nur, damit die
 * Anzeige nichts Unsichtbares als gewählt zeigt). Profile müssen zu den gewählten Clients gehören; bleibt keins,
 * gelten die Clients ganz.
 */
export function sanitizeFilterState(state: FilterState, options: FilterOptionsLike): FilterState {
  const clientIds = state.clientIds.filter((id) => options.clients.some((c) => c.id === id));
  const withoutClient = state.withoutClient && options.profiles.some((p) => p.clientId === null);
  const all = clientIds.length === 0 && !withoutClient;
  const inSelection = (clientId: string | null) =>
    all || (clientId === null ? withoutClient : clientIds.includes(clientId));
  const profileIds =
    state.profileIds?.filter((id) => {
      const profile = options.profiles.find((p) => p.id === id);
      return profile !== undefined && inSelection(profile.clientId);
    }) ?? null;
  const currency =
    state.currency !== 'auto' && options.currencies && !options.currencies.includes(state.currency)
      ? 'auto'
      : state.currency;
  return {
    ...state,
    clientIds,
    withoutClient,
    profileIds: profileIds?.length ? profileIds : null,
    currency,
  };
}

export interface AnalyticsQueryBody {
  clientIds?: string[];
  withoutClient?: boolean;
  profileIds?: string[];
  period: DateRange;
  comparison: DateRange | null;
  currency: string;
  attribution: AttributionSetting;
}

/** Anfrage-Body für `/api/ads/*` (Auswahl nur, wenn eingeschränkt). `today` = Tag in der Zeitzone des Browsers. */
export function toAnalyticsQuery(state: FilterState, today: string): AnalyticsQueryBody {
  const range = resolvePeriod(state.period, today);
  return {
    ...(state.clientIds.length && { clientIds: state.clientIds }),
    ...(state.withoutClient && { withoutClient: true }),
    ...(state.profileIds?.length && { profileIds: state.profileIds }),
    period: range,
    comparison: comparisonRange(range, state.comparison),
    currency: state.currency,
    attribution: state.attribution,
  };
}

// --- Baumauswahl (PrimeVue TreeSelect, Modus „checkbox“) ---------------------------------

export interface TreeCheck {
  checked: boolean;
  partialChecked: boolean;
}
export type TreeSelection = Record<string, TreeCheck>;

export const clientNodeKey = (id: string) => `client:${id}`;
export const profileNodeKey = (id: string) => `profile:${id}`;
export const WITHOUT_CLIENT_NODE_KEY = 'none';

interface Group {
  key: string;
  clientId: string | null;
  profileIds: string[];
}

function groups(options: FilterOptionsLike): Group[] {
  const result: Group[] = options.clients.map((client) => ({
    key: clientNodeKey(client.id),
    clientId: client.id,
    profileIds: options.profiles.filter((p) => p.clientId === client.id).map((p) => p.id),
  }));
  const without = options.profiles.filter((p) => p.clientId === null).map((p) => p.id);
  if (without.length)
    result.push({ key: WITHOUT_CLIENT_NODE_KEY, clientId: null, profileIds: without });
  return result.filter((group) => group.profileIds.length > 0);
}

const CHECKED: TreeCheck = { checked: true, partialChecked: false };
const PARTIAL: TreeCheck = { checked: false, partialChecked: true };

export function toTreeSelection(state: FilterState, options: FilterOptionsLike): TreeSelection {
  const all = state.clientIds.length === 0 && !state.withoutClient;
  const selection: TreeSelection = {};
  for (const group of groups(options)) {
    const groupSelected = all
      ? true
      : group.clientId === null
        ? state.withoutClient
        : state.clientIds.includes(group.clientId);
    if (!groupSelected) continue;
    const checked = state.profileIds
      ? group.profileIds.filter((id) => state.profileIds!.includes(id))
      : group.profileIds;
    if (checked.length === 0) continue;
    selection[group.key] = checked.length === group.profileIds.length ? CHECKED : PARTIAL;
    for (const id of checked) selection[profileNodeKey(id)] = CHECKED;
  }
  return selection;
}

export function fromTreeSelection(
  selection: TreeSelection,
  options: FilterOptionsLike,
): Pick<FilterState, 'clientIds' | 'withoutClient' | 'profileIds'> {
  const all = { clientIds: [], withoutClient: false, profileIds: null };
  const allGroups = groups(options);
  const chosen = allGroups
    .map((group) => ({
      group,
      checked: group.profileIds.filter((id) => selection[profileNodeKey(id)]?.checked),
    }))
    .filter(({ checked }) => checked.length > 0);
  const complete = chosen.every(({ group, checked }) => checked.length === group.profileIds.length);
  if (chosen.length === 0 || (complete && chosen.length === allGroups.length)) return all;
  return {
    clientIds: uniqueSorted(
      chosen.flatMap(({ group }) => (group.clientId === null ? [] : [group.clientId])),
    ),
    withoutClient: chosen.some(({ group }) => group.clientId === null),
    profileIds: complete ? null : uniqueSorted(chosen.flatMap(({ checked }) => checked)),
  };
}
