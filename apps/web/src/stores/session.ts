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

  const preferences = computed<Settings>(
    () => me.value?.preferences ?? { ...DEFAULT_SETTINGS, theme: cachedTheme.value },
  );

  const guardSession = computed<GuardSession>(() =>
    status.value === 'authenticated' && me.value
      ? { status: 'authenticated', me: me.value }
      : { status: status.value === 'error' ? 'error' : 'anonymous' },
  );

  function markSignedOut() {
    me.value = null;
    loadError.value = null;
    status.value = 'anonymous';
  }

  async function fetchMe() {
    try {
      me.value = await api.me();
      loadError.value = null;
      status.value = 'authenticated';
      cachedTheme.value = me.value.preferences.theme;
      writeCachedTheme(cachedTheme.value);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        markSignedOut();
        return;
      }
      me.value = null;
      loadError.value = error instanceof ApiError ? error : ApiError.network(error);
      status.value = 'error';
    }
  }

  /** Lädt `/api/me` neu. Gleichzeitige Aufrufe teilen sich einen Request. */
  function load(): Promise<void> {
    pending ??= fetchMe().finally(() => {
      pending = null;
    });
    return pending;
  }

  /** Lädt nur, wenn noch nichts geladen ist (Router-Guard beim Start). */
  function ensureLoaded(): Promise<void> {
    return status.value === 'unknown' ? load() : (pending ?? Promise.resolve());
  }

  async function signIn(input: SignInInput) {
    await api.auth.signIn(input);
    await load();
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
    await load();
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
    writeCachedTheme(theme);
    try {
      await api.updateSettings(next);
    } catch (error) {
      current.preferences = before;
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
