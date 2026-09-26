import type { JobRun, JobRunListQuery } from '@profitbash/shared';
import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { api } from '../api';
import { useSessionStore } from '../stores/session';

/** Query-Keys mit aktiver Organisation (wie `connectionKeys`), je Filter ein eigener Eintrag. */
export const syncKeys = {
  jobRuns: (orgId: string | null, filters: JobRunListQuery) =>
    ['job-runs', orgId, filters] as const,
};

/** Abstand der Abfragen, solange ein Lauf noch läuft. */
export const JOB_RUNS_POLL_INTERVAL_MS = 5_000;

export function jobRunsPollInterval(runs: JobRun[] | undefined): number | false {
  return runs?.some((run) => run.status === 'running') ? JOB_RUNS_POLL_INTERVAL_MS : false;
}

export function useJobRunsQuery(filters: MaybeRefOrGetter<JobRunListQuery>) {
  const session = useSessionStore();
  const orgId = computed(() => session.me?.activeOrganizationId ?? null);
  return useQuery({
    queryKey: computed(() => syncKeys.jobRuns(orgId.value, toValue(filters))),
    queryFn: () => api.listJobRuns(toValue(filters)),
    enabled: computed(() => orgId.value !== null),
    // Beim Filterwechsel bleibt die bisherige Tabelle stehen, bis die neue Antwort da ist. Nie über
    // einen Org-Wechsel hinweg: Dann zeigte die Seite kurz die Läufe der anderen Org.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === orgId.value ? keepPreviousData(previous) : undefined,
    refetchInterval: (query) => jobRunsPollInterval(query.state.data),
  });
}
