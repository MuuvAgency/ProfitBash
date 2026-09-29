import type { Client, FileProfileCreate, Profile, ProfilePatch } from '@profitbash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, onBeforeUnmount, readonly, ref, toValue, type MaybeRefOrGetter } from 'vue';
import { api } from '../api';
import { useActiveOrgId } from '../stores/session';

/**
 * Query-Keys enthalten die aktive Organisation: Nach einem Org-Wechsel gehören die Daten
 * zu einem anderen Key und werden nie mit denen der vorherigen Org vermischt.
 */
export const connectionKeys = {
  connections: (orgId: string | null) => ['connections', orgId] as const,
  allProfiles: (orgId: string | null) => ['profiles', orgId] as const,
  profiles: (orgId: string | null, connectionId: string) =>
    ['profiles', orgId, connectionId] as const,
  /** Profile ohne Connection (Datei-Import); unter `allProfiles`, damit Profil-Änderungen sie mit erfassen. */
  fileProfiles: (orgId: string | null) => ['profiles', orgId, 'file'] as const,
  clients: (orgId: string | null) => ['clients', orgId] as const,
};

/** Abstand der Abfragen, solange ein Sync läuft (siehe `useSyncPolling`). */
export const SYNC_POLL_INTERVAL_MS = 3_000;

const pollInterval = (polling: MaybeRefOrGetter<boolean>) =>
  computed(() => (toValue(polling) ? SYNC_POLL_INTERVAL_MS : false));

export function useConnectionsQuery(polling: MaybeRefOrGetter<boolean> = false) {
  const orgId = useActiveOrgId();
  return useQuery({
    queryKey: computed(() => connectionKeys.connections(orgId.value)),
    queryFn: () => api.listConnections(),
    enabled: computed(() => orgId.value !== null),
    refetchInterval: pollInterval(polling),
  });
}

export function useProfilesQuery(
  connectionId: MaybeRefOrGetter<string>,
  polling: MaybeRefOrGetter<boolean> = false,
) {
  const orgId = useActiveOrgId();
  return useQuery({
    queryKey: computed(() => connectionKeys.profiles(orgId.value, toValue(connectionId))),
    queryFn: () => api.listProfiles(toValue(connectionId)),
    enabled: computed(() => orgId.value !== null),
    refetchInterval: pollInterval(polling),
  });
}

export function useFileProfilesQuery() {
  const orgId = useActiveOrgId();
  return useQuery({
    queryKey: computed(() => connectionKeys.fileProfiles(orgId.value)),
    queryFn: () => api.listFileProfiles(),
    enabled: computed(() => orgId.value !== null),
  });
}

export function useCreateFileProfile() {
  const orgId = useActiveOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FileProfileCreate) => api.createFileProfile(input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: connectionKeys.fileProfiles(orgId.value) }),
  });
}

/**
 * Nach dem Verbinden oder „Jetzt synchronisieren“ läuft der Profil-Sync im Hintergrund. So lange
 * (höchstens `windowMs`) fragen Connections und Profile regelmäßig nach, damit das Ergebnis ohne
 * Neuladen erscheint. Der genaue Fortschritt steht im Sync-Status.
 */
export function useSyncPolling(windowMs = 60_000) {
  const polling = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  function start() {
    polling.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => (polling.value = false), windowMs);
  }
  onBeforeUnmount(() => clearTimeout(timer));
  return { polling: readonly(polling), start };
}

export function useClientsQuery() {
  const orgId = useActiveOrgId();
  return useQuery({
    queryKey: computed(() => connectionKeys.clients(orgId.value)),
    queryFn: () => api.listClients(),
    enabled: computed(() => orgId.value !== null),
  });
}

/** Lädt Connections und alle Profillisten der aktiven Org neu (z. B. nach einem Sync). */
export function useRefreshConnections() {
  const orgId = useActiveOrgId();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: connectionKeys.connections(orgId.value) }),
      queryClient.invalidateQueries({ queryKey: connectionKeys.allProfiles(orgId.value) }),
    ]);
}

type PatchedFields = Partial<Pick<Profile, keyof ProfilePatch>>;

/** Nur die Felder, die der Patch ändert (für Rollback und Server-Antwort). */
function patchedFields(profile: Profile, patch: ProfilePatch): PatchedFields {
  const fields: PatchedFields = {};
  if (patch.clientId !== undefined) fields.clientId = profile.clientId;
  if (patch.isHidden !== undefined) fields.isHidden = profile.isHidden;
  return fields;
}

/**
 * Profil ändern. Die Änderung erscheint sofort (optimistisch) und wird bei einem Fehler
 * zurückgenommen, damit Schalter und Auswahl nie einen ungespeicherten Stand zeigen.
 * Rollback und Server-Antwort betreffen nur die Felder dieses Patches: Laufen zwei Änderungen am
 * selben Profil gleichzeitig (ausblenden, Client wählen), überschreibt keine die andere.
 */
export function useUpdateProfile() {
  const orgId = useActiveOrgId();
  const queryClient = useQueryClient();

  function replaceProfile(profileId: string, update: (profile: Profile) => Profile) {
    queryClient.setQueriesData<Profile[]>(
      { queryKey: connectionKeys.allProfiles(orgId.value) },
      (list) => list?.map((profile) => (profile.id === profileId ? update(profile) : profile)),
    );
  }

  return useMutation({
    mutationFn: ({ profile, patch }: { profile: Profile; patch: ProfilePatch }) =>
      api.updateProfile(profile.id, patch),
    onMutate: async ({ profile, patch }): Promise<{ previous: PatchedFields }> => {
      await queryClient.cancelQueries({ queryKey: connectionKeys.allProfiles(orgId.value) });
      let previous = patchedFields(profile, patch);
      replaceProfile(profile.id, (current) => {
        previous = patchedFields(current, patch);
        return { ...current, ...patch };
      });
      return { previous };
    },
    onError: (_error, { profile }, context) => {
      if (context) replaceProfile(profile.id, (current) => ({ ...current, ...context.previous }));
    },
    onSuccess: (updated, { patch }) =>
      replaceProfile(updated.id, (current) => ({ ...current, ...patchedFields(updated, patch) })),
  });
}

export function useCreateClient() {
  const orgId = useActiveOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createClient({ name }),
    onSuccess: async (created) => {
      // Sofort in der Auswahl verfügbar, danach mit dem Server abgleichen.
      queryClient.setQueryData<Client[]>(connectionKeys.clients(orgId.value), (list) =>
        [...(list ?? []), created].sort((a, b) => a.name.localeCompare(b.name, 'de')),
      );
      await queryClient.invalidateQueries({ queryKey: connectionKeys.clients(orgId.value) });
    },
  });
}
