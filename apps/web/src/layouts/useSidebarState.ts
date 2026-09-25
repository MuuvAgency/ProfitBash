import { useMutation, useQuery } from '@tanstack/vue-query';
import { ref, watch } from 'vue';
import { api } from '../api';

const SCOPE = 'shell';
const KEY = 'sidebar';
const CACHE_KEY = 'profitbash.sidebar-collapsed';

function readCache(): boolean {
  try {
    return localStorage.getItem(CACHE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeCache(collapsed: boolean) {
  try {
    localStorage.setItem(CACHE_KEY, String(collapsed));
  } catch {
    // optional
  }
}

/**
 * Eingeklappte Sidebar, gespeichert im UI-State des Nutzers (geräteübergreifend).
 * Der Browser-Cache verhindert ein Springen beim Laden; Fehler beim Speichern sind unkritisch.
 */
export function useSidebarState() {
  const collapsed = ref(readCache());

  const stored = useQuery({
    queryKey: ['ui-state', SCOPE, KEY],
    queryFn: () => api.getUiState(SCOPE, KEY),
    staleTime: Infinity,
  });

  watch(stored.data, (value) => {
    if (typeof value === 'object' && value !== null && 'collapsed' in value) {
      collapsed.value = value.collapsed === true;
      writeCache(collapsed.value);
    }
  });

  const save = useMutation({
    mutationFn: (value: boolean) => api.putUiState(SCOPE, KEY, { collapsed: value }),
  });

  function toggle() {
    collapsed.value = !collapsed.value;
    writeCache(collapsed.value);
    save.mutate(collapsed.value);
  }

  return { collapsed, toggle };
}
