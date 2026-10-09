import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, type Ref } from 'vue';
import { api } from '../api';
import type { AdChangeInputData } from '../api/client';
import { useActiveOrgId, useSessionStore } from '../stores/session';

/**
 * Änderungen (`phase-3.md` 3.5): Warenkorb des Nutzers und offene Änderungen fürs Grid. Alle Schlüssel beginnen mit
 * `ad-changes` und tragen die Organisation; nach jedem Vormerken oder Verwerfen werden sie neu geladen.
 */
const KEY = 'ad-changes';

export function useChangeRights() {
  const session = useSessionStore();
  return {
    canView: computed(() => session.me?.features.changes.view ?? false),
    canWrite: computed(() => session.me?.features.changes.write ?? false),
  };
}

/** Eigener Warenkorb (mit den Prüfungen); nur mit dem Recht `view` im Feature `changes`. */
export function usePendingChanges() {
  const orgId = useActiveOrgId();
  const { canView } = useChangeRights();
  return useQuery({
    queryKey: computed(() => [KEY, 'pending', orgId.value] as const),
    queryFn: () => api.adChanges.pending(),
    enabled: computed(() => canView.value && orgId.value !== null),
    staleTime: 30_000,
  });
}

/** Zahl der Änderungen im eigenen Warenkorb; `null`, solange sie nicht bekannt ist. */
export function usePendingCount() {
  const pending = usePendingChanges();
  return computed(() => pending.data.value?.changes.length ?? null);
}

/** Offene Änderungen aller Nutzer für das Grid (F4), auf Wunsch nur eines Profils. */
export function useOpenChanges(profileId: Ref<string | undefined>, enabled: Ref<boolean>) {
  const orgId = useActiveOrgId();
  const { canView } = useChangeRights();
  return useQuery({
    queryKey: computed(() => [KEY, 'open', orgId.value, profileId.value ?? null] as const),
    queryFn: () => api.adChanges.open(profileId.value),
    enabled: computed(() => canView.value && enabled.value && orgId.value !== null),
    staleTime: 30_000,
  });
}

/** Vormerken; lädt danach Warenkorb und offene Änderungen neu. */
export function useStageChanges() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: AdChangeInputData[]) => api.adChanges.stage(changes),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** Eigene vorgemerkte Änderungen verwerfen (genannte oder alle). */
export function useDiscardChanges() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changeIds?: string[]) => api.adChanges.discard(changeIds),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}
