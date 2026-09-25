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

  /** Setzt das Theme sofort und speichert es; scheitert das Speichern, gilt wieder der alte Wert. */
  async function setTheme(theme: Theme) {
    const current = me.value;
    if (!current) {
      cachedTheme.value = theme;
      writeCachedTheme(theme);
      return;
    }
    const before = current.preferences;
    const next = { ...before, theme };
    current.preferences = next;
    cachedTheme.value = theme;
    writeCachedTheme(theme);
    try {
      await api.updateSettings(next);
    } catch (error) {
      current.preferences = before;
      cachedTheme.value = before.theme;
      writeCachedTheme(before.theme);
      throw error;
    }
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
    markSignedOut,
  };
});
