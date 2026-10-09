import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, type Ref } from 'vue';
import { api } from '../api';
import { activeOrgRole } from '../navigation/navigation';
import type {
  AdChangeChannelData,
  PlanSetupInput,
  ProductGroupData,
  SaveSetupDraftInput,
  StructureCatalogData,
} from '../api/client';
import { useActiveOrgId, useSessionStore } from '../stores/session';

/**
 * Tools (`phase-4.md`): Produktgruppen (4.1). Schlüssel `product-groups` mit Organisation; nach jeder Änderung werden
 * Gruppen und die Auswahl der beworbenen Produkte (zeigt die Gruppen je Produkt) neu geladen.
 */
const KEY = 'product-groups';
const ADVERTISED_KEY = 'advertised-products';
const CATALOG_KEY = 'structure-catalog';

export function useToolRights() {
  const session = useSessionStore();
  return {
    canView: computed(() => session.me?.features.tools.view ?? false),
    canWrite: computed(() => session.me?.features.tools.write ?? false),
    /** Katalog, Presets und Namensschema ändern nur Org-Admins (F11). */
    canEditCatalog: computed(
      () =>
        (session.me?.features.tools.write ?? false) &&
        session.me !== null &&
        activeOrgRole(session.me) === 'admin',
    ),
  };
}

export function useProductGroups() {
  const orgId = useActiveOrgId();
  const { canView } = useToolRights();
  return useQuery({
    queryKey: computed(() => [KEY, orgId.value] as const),
    queryFn: () => api.tools.productGroups.list(),
    enabled: computed(() => canView.value && orgId.value !== null),
    staleTime: 30_000,
  });
}

/** Beworbene Produkte des gewählten Profils (Auswahl im Dialog); ohne Profil nichts. */
export function useAdvertisedProducts(profileId: Ref<string | null>) {
  const orgId = useActiveOrgId();
  return useQuery({
    queryKey: computed(() => [ADVERTISED_KEY, orgId.value, profileId.value] as const),
    queryFn: () => api.tools.advertisedProducts(profileId.value!),
    enabled: computed(() => orgId.value !== null && profileId.value !== null),
    staleTime: 60_000,
  });
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: [KEY] }),
      queryClient.invalidateQueries({ queryKey: [ADVERTISED_KEY] }),
    ]);
}

export interface SaveProductGroupInput {
  id?: string;
  profileId: string;
  name: string;
  presetKey: string | null;
  items: ProductGroupData['items'];
}

export function useSaveProductGroup() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, profileId, name, presetKey, items }: SaveProductGroupInput) =>
      id
        ? api.tools.productGroups.update(id, { name, presetKey, items })
        : api.tools.productGroups.create({ profileId, name, presetKey, items }),
    onSettled: invalidate,
  });
}

export function useDeleteProductGroup() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.tools.productGroups.remove(id),
    onSettled: invalidate,
  });
}

/** Struktur-Katalog der Organisation (4.2) mit Presets je Client. */
export function useStructureCatalog() {
  const orgId = useActiveOrgId();
  const { canView } = useToolRights();
  return useQuery({
    queryKey: computed(() => [CATALOG_KEY, orgId.value] as const),
    queryFn: () => api.tools.catalog.get(),
    enabled: computed(() => canView.value && orgId.value !== null),
    staleTime: 30_000,
  });
}

export function useSaveStructureCatalog() {
  const queryClient = useQueryClient();
  const orgId = useActiveOrgId();
  return useMutation({
    mutationFn: (input: { catalog: StructureCatalogData['catalog']; version: number }) =>
      api.tools.catalog.save(input),
    onSuccess: (data) => queryClient.setQueryData([CATALOG_KEY, orgId.value], data),
  });
}

export function useSetClientPreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { clientId: string; presetKey: string | null }) =>
      api.tools.catalog.setClientPreset(input.clientId, input.presetKey),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [CATALOG_KEY] }),
  });
}

// --- Kampagnen-Setup (4.5) ---------------------------------------------------------------

const SETUP_KEY = 'setup-drafts';

/** Offene und übermittelte Entwürfe des Teams (F13). */
export function useSetupDrafts() {
  const orgId = useActiveOrgId();
  const { canView } = useToolRights();
  return useQuery({
    queryKey: computed(() => [SETUP_KEY, orgId.value] as const),
    queryFn: () => api.tools.setup.list(),
    enabled: computed(() => canView.value && orgId.value !== null),
    staleTime: 15_000,
  });
}

/** Harvest-Merkliste eines Profils als Eingang des Setups (4.6). */
export function useSetupHarvest(profileId: Ref<string | null>) {
  const orgId = useActiveOrgId();
  const { canView } = useToolRights();
  return useQuery({
    queryKey: computed(
      () => ['search-terms', orgId.value, 'harvest', 'setup', profileId.value] as const,
    ),
    queryFn: () => api.tools.setup.harvest(profileId.value!),
    enabled: computed(() => canView.value && orgId.value !== null && profileId.value !== null),
    staleTime: 15_000,
  });
}

export function usePlanSetup() {
  return useMutation({ mutationFn: (input: PlanSetupInput) => api.tools.setup.plan(input) });
}

export function useSaveSetupDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      version,
      draft,
    }: {
      id: string | null;
      version: number;
      draft: SaveSetupDraftInput;
    }) => (id ? api.tools.setup.update(id, version, draft) : api.tools.setup.create(draft)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [SETUP_KEY] }),
  });
}

export function useDiscardSetupDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      api.tools.setup.discard(id, version),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [SETUP_KEY] }),
  });
}

/** Übermitteln: Entwürfe und die Übermittlungen der Seite „Änderungen“ neu laden. */
export function useSubmitSetupDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      version,
      channel,
    }: {
      id: string;
      version: number;
      channel: AdChangeChannelData;
    }) => api.tools.setup.submit(id, version, channel),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: [SETUP_KEY] }),
        queryClient.invalidateQueries({ queryKey: ['ad-changes'] }),
      ]),
  });
}
