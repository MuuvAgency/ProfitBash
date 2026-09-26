import type { Client, Profile, ProfilePatch } from '@profitbash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { api } from '../api';
import { useSessionStore } from '../stores/session';

/**
 * Query-Keys enthalten die aktive Organisation: Nach einem Org-Wechsel gehören die Daten
 * zu einem anderen Key und werden nie mit denen der vorherigen Org vermischt.
 */
export const connectionKeys = {
  connections: (orgId: string | null) => ['connections', orgId] as const,
  allProfiles: (orgId: string | null) => ['profiles', orgId] as const,
  profiles: (orgId: string | null, connectionId: string) =>
    ['profiles', orgId, connectionId] as const,
  clients: (orgId: string | null) => ['clients', orgId] as const,
};

function useActiveOrgId() {
  const session = useSessionStore();
  return computed(() => session.me?.activeOrganizationId ?? null);
}

export function useConnectionsQuery() {
  const orgId = useActiveOrgId();
  return useQuery({
    queryKey: computed(() => connectionKeys.connections(orgId.value)),
    queryFn: () => api.listConnections(),
    enabled: computed(() => orgId.value !== null),
  });
}

export function useProfilesQuery(connectionId: MaybeRefOrGetter<string>) {
  const orgId = useActiveOrgId();
  return useQuery({
    queryKey: computed(() => connectionKeys.profiles(orgId.value, toValue(connectionId))),
    queryFn: () => api.listProfiles(toValue(connectionId)),
    enabled: computed(() => orgId.value !== null),
  });
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

type ProfileLists = [readonly unknown[], Profile[] | undefined][];

/**
 * Profil ändern. Die Änderung erscheint sofort (optimistisch) und wird bei einem Fehler
 * zurückgenommen, damit Schalter und Auswahl nie einen ungespeicherten Stand zeigen.
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
    onMutate: async ({ profile, patch }): Promise<{ snapshot: ProfileLists }> => {
      const filters = { queryKey: connectionKeys.allProfiles(orgId.value) };
      await queryClient.cancelQueries(filters);
      const snapshot = queryClient.getQueriesData<Profile[]>(filters);
      replaceProfile(profile.id, (current) => ({ ...current, ...patch }));
      return { snapshot };
    },
    onError: (_error, _variables, context) => {
      context?.snapshot.forEach(([key, list]) => queryClient.setQueryData(key, list));
    },
    onSuccess: (updated) => replaceProfile(updated.id, () => updated),
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
