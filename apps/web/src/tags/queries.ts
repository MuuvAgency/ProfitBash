import { MAX_TAG_ASSIGN_ENTITIES, type TagEntityType } from '@profitbash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, type Ref } from 'vue';
import { api } from '../api';
import type { AssignTagsData, TagData } from '../api/client';
import { useActiveOrgId, useSessionStore } from '../stores/session';

/**
 * Eigene Tags (`phase-3.md` 3.7). Schlüssel `tags` mit Organisation; nach jeder Änderung werden die Tags und die
 * Auswertungen neu geladen (Zeilen tragen ihre Tags, Filter nach Tag).
 */
const KEY = 'tags';

export function useTagRights() {
  const session = useSessionStore();
  return {
    canView: computed(() => session.me?.features.tags.view ?? false),
    canWrite: computed(() => session.me?.features.tags.write ?? false),
  };
}

/** Tags der Organisation nach Name; nur mit dem Recht `view` im Feature `tags`. */
export function useTags(enabled?: Ref<boolean>) {
  const orgId = useActiveOrgId();
  const { canView } = useTagRights();
  return useQuery({
    queryKey: computed(() => [KEY, orgId.value] as const),
    queryFn: () => api.tags.list(),
    enabled: computed(() => canView.value && orgId.value !== null && (enabled?.value ?? true)),
    staleTime: 30_000,
  });
}

/** Tags nach ID (für Zellen und Filter). */
export function tagsById(tags: readonly TagData[] | undefined): Map<string, TagData> {
  return new Map((tags ?? []).map((tag) => [tag.id, tag]));
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: [KEY] }),
      queryClient.invalidateQueries({ queryKey: ['analytics'] }),
    ]);
}

export function useSaveTag() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { id?: string; name: string; color: TagData['color'] }) =>
      input.id
        ? api.tags.update(input.id, { name: input.name, color: input.color })
        : api.tags.create({ name: input.name, color: input.color }),
    onSettled: invalidate,
  });
}

export function useDeleteTag() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.tags.remove(id),
    onSettled: invalidate,
  });
}

export interface AssignTagsRequest {
  entityType: TagEntityType;
  entityIds: string[];
  addTagIds: string[];
  removeTagIds: string[];
}

/** Zuweisen in Stücken (`MAX_TAG_ASSIGN_ENTITIES`); scheitert ein Stück, sind die früheren schon zugewiesen. */
export async function assignInChunks(
  input: AssignTagsRequest,
  send: (part: AssignTagsRequest) => Promise<AssignTagsData>,
): Promise<AssignTagsData> {
  const total: AssignTagsData = { added: 0, removed: 0, skippedEntities: 0 };
  for (let start = 0; start < input.entityIds.length; start += MAX_TAG_ASSIGN_ENTITIES) {
    const part = await send({
      ...input,
      entityIds: input.entityIds.slice(start, start + MAX_TAG_ASSIGN_ENTITIES),
    });
    total.added += part.added;
    total.removed += part.removed;
    total.skippedEntities += part.skippedEntities;
  }
  return total;
}

export function useAssignTags() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: AssignTagsRequest) =>
      assignInChunks(input, (part) => api.tags.assign(part)),
    onSettled: invalidate,
  });
}
