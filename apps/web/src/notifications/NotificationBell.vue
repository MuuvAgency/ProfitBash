<script setup lang="ts">
import { formatNumber } from '@profitbash/shared';
import Button from 'primevue/button';
import Popover from 'primevue/popover';
import { computed, ref, useTemplateRef } from 'vue';
import { useI18n } from 'vue-i18n';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { useSessionStore } from '../stores/session';
import NotificationItem from './NotificationItem.vue';
import {
  useMarkNotificationsRead,
  useRecentNotifications,
  useUnreadNotificationCount,
  RECENT_NOTIFICATIONS,
} from './queries';

/**
 * Glocke mit Zähler (`phase-5.md` 5.2b): oben in der Sidebar und in der mobilen Kopfzeile. Das Popover zeigt die
 * neuesten Benachrichtigungen, „Alle gelesen“ und den Weg zur Seite. Fehlt der Zähler (Fehler), bleibt die Glocke
 * ohne Zahl bedienbar.
 */
defineProps<{ variant?: 'panel' | 'bar'; collapsed?: boolean }>();

const { t } = useI18n();
const session = useSessionStore();
const popover = useTemplateRef<InstanceType<typeof Popover>>('popover');
const open = ref(false);
/** Ab dem ersten Öffnen laden (und danach aktuell halten). */
const requested = ref(false);
const countQuery = useUnreadNotificationCount();
const recent = useRecentNotifications(requested);
// Getrennt, damit „Alle gelesen“ nur beim eigenen Aufruf lädt.
const markOne = useMarkNotificationsRead();
const markAll = useMarkNotificationsRead();

const count = computed(() => countQuery.data.value ?? 0);
const badge = computed(() =>
  count.value > 99 ? '99+' : formatNumber(String(count.value), session.preferences.locale),
);
const label = computed(() =>
  count.value > 0
    ? `${t('notifications.bell')}, ${t('notifications.unreadCount', { count: count.value }, count.value)}`
    : t('notifications.bell'),
);
const items = computed(() => recent.data.value?.items ?? []);
</script>

<template>
  <div>
    <button
      v-tooltip.right="collapsed ? label : undefined"
      data-notification-bell
      type="button"
      :aria-label="label"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :class="[
        'relative flex size-9 items-center justify-center rounded-control outline-none transition-colors focus-visible:ring-2 focus-visible:ring-violet',
        variant === 'bar'
          ? 'text-ink-secondary hover:bg-well hover:text-ink'
          : 'text-on-panel-muted hover:bg-on-panel/10 hover:text-on-panel',
      ]"
      @click="
        requested = true;
        popover?.toggle($event);
      "
    >
      <i class="pi pi-bell text-body-lg" aria-hidden="true" />
      <span
        v-if="count > 0"
        aria-hidden="true"
        class="absolute -top-0.5 -right-1 min-w-4.5 rounded-full bg-violet px-1 text-center font-mono text-[0.6875rem] leading-4.5 font-bold text-on-violet tabular-nums"
        >{{ badge }}</span
      >
    </button>
    <Popover
      ref="popover"
      :aria-label="t('notifications.title')"
      @show="open = true"
      @hide="open = false"
    >
      <div class="flex w-[min(24rem,calc(100vw-3rem))] flex-col gap-space-sm p-space-xs">
        <div class="flex items-center justify-between gap-space-sm">
          <h2 class="text-headline-sm text-ink">{{ t('notifications.recent') }}</h2>
          <Button
            :label="t('notifications.markAllRead')"
            variant="text"
            size="small"
            :disabled="count === 0"
            :loading="markAll.isPending.value"
            @click="markAll.mutate({ all: true })"
          />
        </div>
        <InlineError
          v-if="recent.isError.value"
          :message="t('notifications.loadFailed')"
          retryable
          :retrying="recent.isFetching.value"
          @retry="recent.refetch()"
        />
        <div
          v-else-if="recent.isPending.value"
          class="flex flex-col gap-space-xs"
          role="status"
          aria-busy="true"
        >
          <span class="sr-only">{{ t('common.loading') }}</span>
          <SkeletonBlock v-for="n in 3" :key="n" height="3.5rem" />
        </div>
        <p v-else-if="items.length === 0" class="text-body-sm text-ink-secondary">
          {{ t('notifications.empty.text') }}
        </p>
        <div v-else class="flex max-h-[60dvh] flex-col gap-space-xs overflow-y-auto">
          <NotificationItem
            v-for="notification in items.slice(0, RECENT_NOTIFICATIONS)"
            :key="notification.id"
            :notification="notification"
            compact
            @read="markOne.mutate({ ids: [notification.id] })"
            @navigate="popover?.hide()"
          />
        </div>
        <RouterLink
          to="/notifications"
          class="self-start rounded-control text-body-sm font-medium text-violet outline-none hover:underline focus-visible:ring-2 focus-visible:ring-violet"
          @click="popover?.hide()"
          >{{ t('notifications.showAll') }}</RouterLink
        >
      </div>
    </Popover>
  </div>
</template>
