import type { NotificationKind } from '@profitbash/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, onScopeDispose, type Ref } from 'vue';
import { api } from '../api';
import { useActiveOrgId } from '../stores/session';
import { connectNotificationStream } from './live';

/**
 * Benachrichtigungen (5.2b). Schlüssel `notifications` mit Organisation; der Live-Kanal und „gelesen“ laden alles
 * darunter neu. Der Zähler fragt zusätzlich beim Fokus des Fensters ab (ohne Live-Kanal der einzige Weg).
 */
const KEY = 'notifications';
export const RECENT_NOTIFICATIONS = 5;
const PAGE_SIZE = 30;

export function useUnreadNotificationCount() {
  const orgId = useActiveOrgId();
  return useQuery({
    queryKey: computed(() => [KEY, 'unread', orgId.value] as const),
    queryFn: () => api.notifications.unreadCount(),
    enabled: computed(() => orgId.value !== null),
    refetchOnWindowFocus: 'always',
  });
}

/** Die neuesten Benachrichtigungen für die Glocke (erst geladen, wenn sie offen ist). */
export function useRecentNotifications(enabled: Ref<boolean>) {
  const orgId = useActiveOrgId();
  return useQuery({
    queryKey: computed(() => [KEY, 'recent', orgId.value] as const),
    queryFn: () => api.notifications.list({ limit: RECENT_NOTIFICATIONS }),
    enabled: computed(() => orgId.value !== null && enabled.value),
  });
}

export interface NotificationFilters {
  unread: boolean;
  kind: NotificationKind | null;
  profileId: string | null;
}

/** Liste der Seite, neueste zuerst, weitere Seiten über `before`. */
export function useNotificationPages(filters: Ref<NotificationFilters>) {
  const orgId = useActiveOrgId();
  return useInfiniteQuery({
    queryKey: computed(() => [KEY, 'list', orgId.value, { ...filters.value }] as const),
    queryFn: ({ pageParam }) =>
      api.notifications.list({
        limit: PAGE_SIZE,
        ...(filters.value.unread && { unread: 'true' as const }),
        ...(filters.value.kind && { kind: filters.value.kind }),
        ...(filters.value.profileId && { profileId: filters.value.profileId }),
        ...(pageParam !== null && { before: pageParam }),
      }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled: computed(() => orgId.value !== null),
  });
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { ids: string[] } | { all: true }) => api.notifications.markRead(input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** Hält den Live-Kanal offen, solange die aufrufende Komponente lebt (App-Shell). */
export function useNotificationStream() {
  const queryClient = useQueryClient();
  const stop = connectNotificationStream({
    orgId: useActiveOrgId(),
    onChange: () => void queryClient.invalidateQueries({ queryKey: [KEY] }),
    EventSourceImpl: typeof EventSource === 'undefined' ? undefined : EventSource,
  });
  onScopeDispose(stop);
}
