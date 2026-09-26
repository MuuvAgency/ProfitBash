<script setup lang="ts">
import {
  formatNumber,
  type Client,
  type Connection,
  type Profile,
  type ProfilePatch,
} from '@profitbash/shared';
import { useMutation } from '@tanstack/vue-query';
import Button from 'primevue/button';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useSessionStore } from '../stores/session';
import ProfileGrid from './ProfileGrid.vue';
import { useProfilesQuery, useRefreshConnections } from './queries';

const props = defineProps<{
  connection: Connection;
  clients: Client[];
  clientsReady: boolean;
  showRemoved: boolean;
  /** Ein Sync läuft: Profile regelmäßig nachladen. */
  polling: boolean;
  /** „Neu verbinden“ läuft gerade (Weiterleitung zu Amazon). */
  reconnecting: boolean;
}>();
const emit = defineEmits<{
  reconnect: [connection: Connection];
  /** Sync eingeplant: Die Seite lädt eine Weile nach. */
  synced: [];
  patch: [profile: Profile, patch: ProfilePatch];
  createClient: [profile: Profile];
}>();

const { t } = useI18n();
const session = useSessionStore();
const refresh = useRefreshConnections();

const profilesQuery = useProfilesQuery(
  () => props.connection.id,
  () => props.polling,
);
const allProfiles = computed(() => profilesQuery.data.value ?? []);
const profiles = computed(() =>
  props.showRemoved ? allProfiles.value : allProfiles.value.filter((p) => !p.removedAt),
);
const activeCount = computed(() => allProfiles.value.filter((p) => !p.removedAt).length);

const needsReauth = computed(() => props.connection.status === 'reauth_required');
const locale = computed(() => session.preferences.locale);

const sync = useMutation({
  mutationFn: () => api.syncConnection(props.connection.id),
  onSuccess: () => emit('synced'),
  onError: (error) => {
    // Der Status hat sich auf dem Server geändert: Karte zeigt danach „Neu verbinden“.
    if (error instanceof ApiError && error.status === 409) void refresh();
  },
});

const syncErrorKey = computed(() => {
  const error = sync.error.value;
  if (!error) return null;
  // Der Hinweis zum Neu-Verbinden steht schon in der Karte.
  if (
    needsReauth.value &&
    error instanceof ApiError &&
    error.code === 'CONNECTION_REAUTH_REQUIRED'
  ) {
    return null;
  }
  return errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
});

const title = computed(
  () => props.connection.externalAccountEmail ?? props.connection.externalAccountId,
);

const lastRefreshed = computed(() => {
  const value = props.connection.lastRefreshedAt;
  if (!value) return t('connections.never');
  return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
});

const statusDot = computed(
  () =>
    ({ active: 'bg-lime', reauth_required: 'bg-warn', error: 'bg-loss' })[props.connection.status],
);
</script>

<template>
  <section
    class="flex flex-col gap-space-lg rounded-tile bg-tile p-space-lg shadow-tile"
    :aria-label="title"
  >
    <header class="flex flex-col gap-space-md lg:flex-row lg:items-start lg:justify-between">
      <div class="flex min-w-0 items-start gap-space-md">
        <span
          class="flex size-12 shrink-0 items-center justify-center rounded-control bg-panel text-on-panel"
          aria-hidden="true"
        >
          <i class="pi pi-amazon text-headline-sm" />
        </span>
        <div class="flex min-w-0 flex-col gap-space-xs">
          <div class="flex flex-wrap items-center gap-space-sm">
            <h2 class="truncate text-headline-sm text-ink">{{ title }}</h2>
            <span
              class="inline-flex items-center gap-1.5 rounded-full bg-well px-2.5 py-0.5 text-body-sm text-ink"
            >
              <span :class="['size-2 rounded-full', statusDot]" aria-hidden="true" />
              {{ t(`connections.status.${connection.status}`) }}
            </span>
          </div>
          <p class="flex flex-wrap gap-x-space-md gap-y-space-xs text-body-sm text-ink-secondary">
            <span>
              {{
                [
                  t(`connections.provider.${connection.provider}`),
                  connection.region && t(`connections.region.${connection.region}`),
                ]
                  .filter(Boolean)
                  .join(' · ')
              }}
            </span>
            <span>
              {{ t('connections.lastRefreshed') }}:
              <span class="font-data text-ink">{{ lastRefreshed }}</span>
            </span>
            <span v-if="profilesQuery.data.value">
              <span class="font-data text-ink">{{ formatNumber(activeCount, locale) }}</span>
              {{ t('connections.profileCount') }}
            </span>
          </p>
        </div>
      </div>
      <div class="flex shrink-0 flex-wrap items-center gap-space-sm">
        <Button
          v-if="needsReauth"
          :label="t('connections.reconnect')"
          icon="pi pi-refresh"
          :loading="reconnecting"
          @click="emit('reconnect', connection)"
        />
        <Button
          v-else
          :label="t('connections.sync')"
          icon="pi pi-sync"
          severity="secondary"
          variant="outlined"
          :loading="sync.isPending.value"
          @click="sync.mutate()"
        />
      </div>
    </header>

    <p
      v-if="needsReauth"
      class="flex items-start gap-space-sm rounded-control bg-well px-space-md py-space-sm text-body-sm text-ink"
    >
      <i class="pi pi-exclamation-circle mt-0.5 text-warn" aria-hidden="true" />
      {{ t('connections.reauthHint') }}
    </p>
    <p
      v-if="sync.isSuccess.value"
      role="status"
      class="rounded-control bg-violet-wash px-space-md py-space-sm text-body-sm text-ink"
    >
      <i18n-t keypath="connections.syncQueued" scope="global">
        <template #link>
          <RouterLink
            :to="{ name: 'sync', query: { job: 'profiles-sync' } }"
            class="font-medium text-violet underline underline-offset-2"
          >
            {{ t('nav.sync') }}
          </RouterLink>
        </template>
      </i18n-t>
    </p>
    <InlineError v-if="syncErrorKey" :message="t(syncErrorKey)" />

    <div v-if="profilesQuery.isPending.value" class="flex flex-col gap-space-sm" aria-busy="true">
      <SkeletonBlock v-for="n in 3" :key="n" height="2.5rem" />
    </div>
    <InlineError
      v-else-if="profilesQuery.isError.value"
      :message="t('connections.profiles.loadError')"
      retryable
      :retrying="profilesQuery.isFetching.value"
      @retry="profilesQuery.refetch()"
    />
    <p v-else-if="profiles.length === 0" class="text-body-md text-ink-secondary">
      {{
        allProfiles.length === 0
          ? t('connections.profiles.empty')
          : t('connections.profiles.emptyFiltered')
      }}
    </p>
    <!-- Mindestbreite = Summe der Mindestbreiten der Spalten (ProfileGrid): darunter scrollt die Tabelle in der Kachel. -->
    <div
      v-else
      class="-mx-space-lg overflow-x-auto"
      role="region"
      :aria-label="t('connections.profiles.label', { account: title })"
    >
      <ProfileGrid
        class="min-w-[1090px]"
        :profiles="profiles"
        :clients="clients"
        :clients-ready="clientsReady"
        @patch="(profile, patch) => emit('patch', profile, patch)"
        @create-client="(profile) => emit('createClient', profile)"
      />
    </div>
  </section>
</template>
