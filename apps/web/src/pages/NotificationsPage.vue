<script setup lang="ts">
import { NOTIFICATION_KINDS, type NotificationKind } from '@profitbash/shared';
import Button from 'primevue/button';
import Select from 'primevue/select';
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import NotificationItem from '../notifications/NotificationItem.vue';
import {
  useMarkNotificationsRead,
  useNotificationPages,
  useUnreadNotificationCount,
  type NotificationFilters,
} from '../notifications/queries';
import { ApiError } from '../api';
import { useActiveOrgId } from '../stores/session';

/**
 * Seite „Benachrichtigungen“ (`phase-5.md` 5.2b): alle sichtbaren Benachrichtigungen, neueste zuerst, mit Filtern
 * (ungelesen, Art, Profil), gelesen setzen und älteren Seiten. Neue erscheinen über den Live-Kanal der Shell.
 */
const { t } = useI18n();
const filters = ref<NotificationFilters>({ unread: false, kind: null, profileId: null });
const pages = useNotificationPages(filters);
const unreadCount = useUnreadNotificationCount();
// Getrennt, damit „Alle als gelesen markieren“ nur beim eigenen Aufruf lädt.
const markOne = useMarkNotificationsRead();
const markAll = useMarkNotificationsRead();
const orgId = useActiveOrgId();
const markFailed = computed(() => markOne.isError.value || markAll.isError.value);
/** Ohne ungelesene aus; ist der Zähler unbekannt (Fehler), entscheidet die geladene Liste. */
const nothingUnread = computed(() =>
  unreadCount.isSuccess.value
    ? unreadCount.data.value === 0
    : !items.value.some((item) => item.readAt === null),
);

const items = computed(() => pages.data.value?.pages.flatMap((page) => page.items) ?? []);
const filtered = computed(
  () => filters.value.unread || filters.value.kind !== null || filters.value.profileId !== null,
);
const errorKey = computed(() => {
  const error = pages.error.value;
  return error ? errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN') : null;
});

/** Profile aus den geladenen Benachrichtigungen (gemerkt, damit der Filter sie nicht selbst ausblendet). */
const seenProfiles = reactive(new Map<string, string>());
watch(
  items,
  (list) => {
    for (const item of list) {
      if (item.profileId && item.profileName) seenProfiles.set(item.profileId, item.profileName);
    }
  },
  { immediate: true },
);
const profileOptions = computed(() =>
  [...seenProfiles.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label)),
);
const kindOptions = computed(() =>
  NOTIFICATION_KINDS.map((kind) => ({ value: kind, label: t(`notifications.kind.${kind}.label`) })),
);

// Anderer Mandant: Filter und gemerkte Profile gehören zur alten Organisation.
watch(orgId, () => {
  seenProfiles.clear();
  filters.value = { unread: false, kind: null, profileId: null };
});

function setFilter<K extends keyof NotificationFilters>(key: K, value: NotificationFilters[K]) {
  filters.value = { ...filters.value, [key]: value };
}

function read(id: string) {
  markOne.mutate({ ids: [id] });
}
</script>

<template>
  <div class="flex flex-col gap-space-lg">
    <PageHeader :title="t('notifications.title')" :description="t('notifications.description')">
      <template #actions>
        <Button
          :label="t('notifications.markAllRead')"
          icon="pi pi-check-square"
          variant="outlined"
          size="small"
          :loading="markAll.isPending.value"
          :disabled="nothingUnread"
          @click="markAll.mutate({ all: true })"
        />
      </template>
    </PageHeader>

    <div
      class="flex flex-wrap items-end gap-space-md"
      role="group"
      :aria-label="t('notifications.filter.label')"
    >
      <div class="flex flex-col gap-space-xs">
        <span id="notifications-filter-show" class="text-body-sm text-ink-secondary">
          {{ t('notifications.filter.show') }}
        </span>
        <div
          class="flex rounded-control bg-well p-0.5"
          role="group"
          aria-labelledby="notifications-filter-show"
        >
          <button
            v-for="option in [false, true]"
            :key="String(option)"
            type="button"
            :aria-pressed="filters.unread === option"
            :class="[
              'rounded-control px-space-md py-space-xs text-body-sm outline-none focus-visible:ring-2 focus-visible:ring-violet',
              filters.unread === option
                ? 'bg-tile-peak text-ink shadow-tile'
                : 'text-ink-secondary',
            ]"
            @click="setFilter('unread', option)"
          >
            {{ option ? t('notifications.filter.unread') : t('notifications.filter.all') }}
          </button>
        </div>
      </div>
      <div class="flex w-full flex-col gap-space-xs sm:w-60">
        <span id="notifications-filter-kind" class="text-body-sm text-ink-secondary">
          {{ t('notifications.filter.kind') }}
        </span>
        <Select
          :model-value="filters.kind"
          :options="kindOptions"
          option-label="label"
          option-value="value"
          :placeholder="t('notifications.filter.kindAll')"
          aria-labelledby="notifications-filter-kind"
          show-clear
          size="small"
          fluid
          @update:model-value="(value: NotificationKind | null) => setFilter('kind', value ?? null)"
        />
      </div>
      <div v-if="profileOptions.length > 0" class="flex w-full flex-col gap-space-xs sm:w-60">
        <span id="notifications-filter-profile" class="text-body-sm text-ink-secondary">
          {{ t('notifications.filter.profile') }}
        </span>
        <Select
          :model-value="filters.profileId"
          :options="profileOptions"
          option-label="label"
          option-value="value"
          :placeholder="t('notifications.filter.profileAll')"
          aria-labelledby="notifications-filter-profile"
          show-clear
          size="small"
          fluid
          @update:model-value="(value: string | null) => setFilter('profileId', value ?? null)"
        />
      </div>
    </div>

    <InlineError v-if="markFailed" :message="t('notifications.markFailed')" />
    <InlineError
      v-if="errorKey && items.length === 0"
      :message="t('notifications.loadFailed') + ' ' + t(errorKey)"
      retryable
      :retrying="pages.isFetching.value"
      @retry="pages.refetch()"
    />
    <div
      v-else-if="pages.isPending.value && orgId !== null"
      class="flex flex-col gap-space-sm"
      role="status"
      aria-busy="true"
    >
      <span class="sr-only">{{ t('common.loading') }}</span>
      <SkeletonBlock v-for="n in 4" :key="n" shape="tile" height="4.5rem" />
    </div>
    <EmptyState
      v-else-if="items.length === 0"
      icon="bell"
      :title="t('notifications.empty.title')"
      :text="
        filtered
          ? filters.unread && !filters.kind && !filters.profileId
            ? t('notifications.empty.unread')
            : t('notifications.empty.filtered')
          : t('notifications.empty.text')
      "
    />
    <section v-else class="flex flex-col gap-space-xs rounded-tile bg-tile p-space-sm shadow-tile">
      <NotificationItem
        v-for="notification in items"
        :key="notification.id"
        :notification="notification"
        @read="read(notification.id)"
      />
      <div v-if="pages.hasNextPage.value" class="flex justify-center p-space-sm">
        <Button
          :label="t('notifications.loadMore')"
          variant="text"
          size="small"
          :loading="pages.isFetchingNextPage.value"
          @click="pages.fetchNextPage()"
        />
      </div>
      <InlineError
        v-if="errorKey && items.length > 0"
        :message="t('notifications.loadFailed') + ' ' + t(errorKey)"
      />
    </section>
  </div>
</template>
