import type { JobRun, JobRunListQuery } from '@profitbash/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/vue-query';
import { toValue, computed, type MaybeRefOrGetter } from 'vue';
import { api } from '../api';
import { useActiveOrgId } from '../stores/session';

/** Query-Keys mit aktiver Organisation (wie `connectionKeys`), je Filter ein eigener Eintrag. */
export const syncKeys = {
  allJobRuns: (orgId: string | null) => ['job-runs', orgId] as const,
  jobRuns: (orgId: string | null, filters: JobRunListQuery) =>
    ['job-runs', orgId, filters] as const,
  /** Zeitpunkt (ms) des letzten angeforderten Syncs, nur im Cache (kein Request). */
  syncRequestedAt: (orgId: string | null) => ['sync-requested-at', orgId] as const,
};

/** Abstand der Abfragen, solange ein Lauf läuft oder gleich starten sollte. */
export const JOB_RUNS_POLL_INTERVAL_MS = 3_000;
/**
 * So lange nach „Jetzt synchronisieren“ fragt der Sync-Status nach: Der Job ist eingeplant, hat aber
 * erst eine `job_runs`-Zeile, wenn der Worker ihn abholt.
 */
export const SYNC_REQUEST_WINDOW_MS = 60_000;
/** Läuft ein Lauf länger, gilt er als abgebrochen (der Cleanup setzt ihn später auf `failed`). */
export const STALE_RUNNING_MS = 60 * 60_000;

export function jobRunsPollInterval(
  runs: JobRun[] | undefined,
  { now, requestedAt }: { now: number; requestedAt?: number },
): number | false {
  const running = runs?.some(
    (run) => run.status === 'running' && now - Date.parse(run.startedAt) < STALE_RUNNING_MS,
  );
  const requested = requestedAt !== undefined && now - requestedAt < SYNC_REQUEST_WINDOW_MS;
  return running || requested ? JOB_RUNS_POLL_INTERVAL_MS : false;
}

export function useJobRunsQuery(filters: MaybeRefOrGetter<JobRunListQuery>) {
  const orgId = useActiveOrgId();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: computed(() => syncKeys.jobRuns(orgId.value, toValue(filters))),
    queryFn: () => api.listJobRuns(toValue(filters)),
    enabled: computed(() => orgId.value !== null),
    // Beim Öffnen immer neu laden: Der Stand von vor 30 s hilft hier nicht.
    staleTime: 0,
    // Beim Filterwechsel bleibt die bisherige Tabelle stehen, bis die neue Antwort da ist. Nie über
    // einen Org-Wechsel hinweg: Dann zeigte die Seite kurz die Läufe der anderen Org.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === orgId.value ? keepPreviousData(previous) : undefined,
    refetchInterval: (query) =>
      jobRunsPollInterval(query.state.data, {
        now: Date.now(),
        requestedAt: queryClient.getQueryData<number>(syncKeys.syncRequestedAt(orgId.value)),
      }),
  });
}

/**
 * Nach „Jetzt synchronisieren“ oder dem Verbinden: Der Sync-Status lädt beim nächsten Öffnen neu und
 * fragt eine Weile nach, bis der eingeplante Lauf erscheint.
 */
export function useMarkSyncRequested() {
  const orgId = useActiveOrgId();
  const queryClient = useQueryClient();
  return () => {
    queryClient.setQueryData(syncKeys.syncRequestedAt(orgId.value), Date.now());
    void queryClient.invalidateQueries({ queryKey: syncKeys.allJobRuns(orgId.value) });
  };
}
