import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, type Ref } from 'vue';
import { api } from '../api';
import type {
  AdChangeChannelData,
  AdChangeInputData,
  RevertAdChangesInput,
  SubmitAdChangesInput,
} from '../api/client';
import { useActiveOrgId, useSessionStore } from '../stores/session';
import { stageInChunks } from './stage';

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
    mutationFn: (changes: AdChangeInputData[]) =>
      stageInChunks(changes, (part) => api.adChanges.stage(part)),
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

// ---------------------------------------------------------------------------
// Übermitteln und Übermittlungen (3.6)
// ---------------------------------------------------------------------------

/** Solange eine Übermittlung über die API auf ihr Ergebnis wartet, wird nachgefragt. */
const POLL_MS = 5000;
const awaitsJob = (submission: { channel: string; status: string }) =>
  submission.channel === 'api' &&
  (submission.status === 'pending' || submission.status === 'running');

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [KEY] });
}

export function useSubmitChanges() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: SubmitAdChangesInput) => api.adChanges.submit(input),
    onSettled: invalidate,
  });
}

/** Übermittlungen der Organisation, neueste zuerst. */
export function useSubmissions(enabled: Ref<boolean>) {
  const orgId = useActiveOrgId();
  const { canView } = useChangeRights();
  return useQuery({
    queryKey: computed(() => [KEY, 'submissions', orgId.value] as const),
    queryFn: () => api.adChanges.submissions(),
    enabled: computed(() => canView.value && enabled.value && orgId.value !== null),
    refetchInterval: (query) => (query.state.data?.some(awaitsJob) ? POLL_MS : false),
  });
}

/** Eine Übermittlung mit ihren Änderungen, Folgeschritten und dem Stand der Kampagnen. */
export function useSubmission(id: Ref<string | null>) {
  const orgId = useActiveOrgId();
  const { canView } = useChangeRights();
  return useQuery({
    queryKey: computed(() => [KEY, 'submission', orgId.value, id.value] as const),
    queryFn: () => api.adChanges.submission(id.value!),
    enabled: computed(() => canView.value && id.value !== null && orgId.value !== null),
    refetchInterval: (query) =>
      query.state.data && awaitsJob(query.state.data.submission) ? POLL_MS : false,
    retry: false,
  });
}

export function useRetryChanges() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { changeIds: string[]; channel: AdChangeChannelData }) =>
      api.adChanges.retry(input),
    onSettled: invalidate,
  });
}

export function useDismissChanges() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (changeIds: string[]) => api.adChanges.dismiss(changeIds),
    onSettled: invalidate,
  });
}

export function useRevertChanges() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: RevertAdChangesInput) => api.adChanges.revert(input),
    onSettled: invalidate,
  });
}

export function useCloseSubmission() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { id: string; outcome: 'applied' | 'discarded' }) =>
      api.adChanges.close(input.id, input.outcome),
    onSettled: invalidate,
  });
}

/** Lädt die Bulk-Datei; der Abruf kann den Status von Änderungen ändern (übersprungene scheitern), deshalb neu laden. */
export function useBulkFileDownload() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.adChanges.bulkFile(id),
    onSettled: invalidate,
  });
}
