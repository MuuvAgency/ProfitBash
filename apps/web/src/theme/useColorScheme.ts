import { computed, ref, watchEffect } from 'vue';
import { useSessionStore } from '../stores/session';
import { applyColorScheme, resolveColorScheme } from './mode';

const query = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
const systemPrefersDark = ref(query?.matches ?? false);
query?.addEventListener('change', (event) => {
  systemPrefersDark.value = event.matches;
});

/** Sichtbare Darstellung aus der Einstellung (`preferences.theme`) und dem System. */
export function useColorScheme() {
  const session = useSessionStore();
  return computed(() => resolveColorScheme(session.preferences.theme, systemPrefersDark.value));
}

/** Einmal in App.vue: hält die Klasse `.dark` am <html> aktuell. */
export function useColorSchemeSync() {
  const scheme = useColorScheme();
  watchEffect(() => applyColorScheme(scheme.value));
}
