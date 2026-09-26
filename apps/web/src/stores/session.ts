import { DEFAULT_SETTINGS, type MeResponse, type Settings, type Theme } from '@profitbash/shared';
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { api, ApiError, type SignInInput } from '../api';
import type { GuardSession } from '../router/guard';
import { readCachedTheme, writeCachedTheme } from '../theme/mode';

export type SessionStatus = 'unknown' | 'authenticated' | 'anonymous' | 'error';

/**
 * Angemeldeter Nutzer (`/api/me`): Quelle für Sidebar-Sichtbarkeit, Router-Guards und Einstellungen.
 * Session-Cookies verlängert der Server selbst; der Client lädt nur neu, wenn sich etwas ändert.
 */
export const useSessionStore = defineStore('session', () => {
  const status = ref<SessionStatus>('unknown');
  const me = ref<MeResponse | null>(null);
  const loadError = shallowRef<ApiError | null>(null);
  const cachedTheme = ref<Theme>(readCachedTheme());
  let pending: Promise<void> | null = null;
  /**
   * Zählt Zustandswechsel (Abmelden, Anmelden, Org-Wechsel). Antworten von `/api/me`, die zu einer
   * älteren Generation gehören, werden verworfen, damit sie keinen neueren Zustand überschreiben.
   */
  let generation = 0;

  const preferences = computed<Settings>(
    () => me.value?.preferences ?? { ...DEFAULT_SETTINGS, theme: cachedTheme.value },
  );

  const guardSession = computed<GuardSession>(() =>
    status.value === 'authenticated' && me.value
      ? { status: 'authenticated', me: me.value }
      : { status: status.value === 'error' ? 'error' : 'anonymous' },
  );

  function resetState() {
    me.value = null;
    loadError.value = null;
    status.value = 'anonymous';
  }

  function markSignedOut() {
    generation += 1;
    pending = null;
    resetState();
  }

  async function fetchMe(requestGeneration: number) {
    try {
      const result = await api.me();
      if (requestGeneration !== generation) return;
      me.value = result;
      confirmedPreferences = { ...result.preferences };
      loadError.value = null;
      status.value = 'authenticated';
      cachedTheme.value = result.preferences.theme;
      writeCachedTheme(cachedTheme.value);
    } catch (error) {
      if (requestGeneration !== generation) return;
      if (error instanceof ApiError && error.status === 401) {
        resetState();
        return;
      }
      me.value = null;
      loadError.value = error instanceof ApiError ? error : ApiError.network(error);
      status.value = 'error';
    }
  }

  function startFetch(): Promise<void> {
    const request: Promise<void> = fetchMe(generation).finally(() => {
      if (pending === request) pending = null;
    });
    pending = request;
    return request;
  }

  /** Lädt `/api/me` neu. Gleichzeitige Aufrufe teilen sich einen Request. */
  function load(): Promise<void> {
    return pending ?? startFetch();
  }

  /** Nach einem Zustandswechsel: neue Generation, ältere Anfragen zählen nicht mehr. */
  function reload(): Promise<void> {
    generation += 1;
    return startFetch();
  }

  /** Lädt nur, wenn noch nichts geladen ist (Router-Guard beim Start). */
  function ensureLoaded(): Promise<void> {
    return status.value === 'unknown' ? load() : (pending ?? Promise.resolve());
  }

  async function signIn(input: SignInInput) {
    await api.auth.signIn(input);
    await reload();
  }

  async function signOut() {
    try {
      await api.auth.signOut();
    } catch (error) {
      // 401: Die Session war schon abgelaufen, der Nutzer ist also abgemeldet.
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
    markSignedOut();
  }

  async function switchOrganization(organizationId: string) {
    await api.auth.setActiveOrganization(organizationId);
    await reload();
  }

  /**
   * Speichern läuft nacheinander: `PUT /api/settings` ersetzt alle Einstellungen, ein späterer Request
   * darf keinen früheren überholen. Jeder Request sendet den Stand zum Zeitpunkt des Sendens.
   */
  let saveQueue: Promise<void> = Promise.resolve();
  /** Vom Server bestätigter Stand (`/api/me` oder letzte erfolgreiche Antwort auf `PUT`). */
  let confirmedPreferences: Settings | null = null;
  /** Zählt Änderungen je Feld: Eine Rücknahme gilt nur, solange niemand das Feld seither geändert hat. */
  const fieldVersions: Record<keyof Settings, number> = { theme: 0, locale: 0, density: 0 };

  function setCachedTheme(theme: Theme) {
    cachedTheme.value = theme;
    writeCachedTheme(theme);
  }

  function sameSettings(a: Settings, b: Settings) {
    return a.theme === b.theme && a.locale === b.locale && a.density === b.density;
  }

  /**
   * Ändert Einstellungen sofort und speichert sie. Scheitert das Speichern, gilt für die Felder dieses
   * Patches wieder der vom Server bestätigte Wert, sofern niemand sie inzwischen erneut geändert hat.
   * Ist der Nutzer beim Senden ein anderer (Abmelden, `/api/me` neu geladen), entfällt der Request.
   */
  async function updatePreferences(patch: Partial<Settings>) {
    const current = me.value;
    if (!current) {
      // Vor dem Login gibt es nur das Theme (aus dem Browser-Cache).
      if (patch.theme) setCachedTheme(patch.theme);
      return;
    }
    const keys = Object.keys(patch) as (keyof Settings)[];
    const versions = Object.fromEntries(keys.map((key) => [key, ++fieldVersions[key]]));
    current.preferences = { ...current.preferences, ...patch };
    if (patch.theme) setCachedTheme(patch.theme);

    const job = saveQueue.then(async () => {
      if (me.value !== current) return;
      const sending = current.preferences;
      // Ein früherer Request hat diesen Stand schon mitgenommen.
      if (confirmedPreferences && sameSettings(sending, confirmedPreferences)) return;
      try {
        const saved = await api.updateSettings(sending);
        if (me.value === current) confirmedPreferences = saved;
      } catch (error) {
        const confirmed = confirmedPreferences;
        if (me.value === current && confirmed) {
          const reverted = { ...current.preferences };
          for (const key of keys) {
            if (fieldVersions[key] === versions[key])
              Object.assign(reverted, { [key]: confirmed[key] });
          }
          current.preferences = reverted;
          setCachedTheme(reverted.theme);
        }
        throw error;
      }
    });
    saveQueue = job.catch(() => undefined);
    await job;
  }

  /** Setzt das Theme sofort und speichert es; scheitert das Speichern, gilt wieder der alte Wert. */
  function setTheme(theme: Theme) {
    return updatePreferences({ theme });
  }

  return {
    status,
    me,
    loadError,
    preferences,
    guardSession,
    load,
    ensureLoaded,
    signIn,
    signOut,
    switchOrganization,
    setTheme,
    updatePreferences,
    markSignedOut,
  };
});

/** Aktive Organisation (`null` ohne Organisation). Gehört in jeden Query-Key mit Org-Daten. */
export function useActiveOrgId() {
  const session = useSessionStore();
  return computed(() => session.me?.activeOrganizationId ?? null);
}
