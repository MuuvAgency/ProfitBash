<script setup lang="ts">
import type { Client, Connection, Profile, ProfilePatch } from '@profitbash/shared';
import Button from 'primevue/button';
import ToggleSwitch from 'primevue/toggleswitch';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError } from '../api';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { browserNavigation } from '../connections/browser-navigation';
import ConnectionCard from '../connections/ConnectionCard.vue';
import ClientsCard from '../connections/ClientsCard.vue';
import CreateClientDialog from '../connections/CreateClientDialog.vue';
import CreateFileProfileDialog from '../connections/CreateFileProfileDialog.vue';
import FileProfilesCard from '../connections/FileProfilesCard.vue';
import { oauthNotice } from '../connections/oauth-notice';
import {
  useClientsQuery,
  useConnectionsQuery,
  useSyncPolling,
  useUpdateProfile,
} from '../connections/queries';
import { errorMessageKey } from '../i18n';
import { useMarkSyncRequested } from '../sync/queries';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const syncPolling = useSyncPolling();
const markSyncRequested = useMarkSyncRequested();

/** Ein Sync ist eingeplant: Diese Seite und der Sync-Status fragen eine Weile nach. */
function onSyncQueued() {
  syncPolling.start();
  markSyncRequested();
}

// Nach dem Verbinden läuft der erste Profil-Sync schon (vom Callback eingeplant).
if (route.query.oauth === 'connected') onSyncQueued();

const connectionsQuery = useConnectionsQuery(syncPolling.polling);
const clientsQuery = useClientsQuery();
const updateProfile = useUpdateProfile();

const connections = computed(() => connectionsQuery.data.value ?? []);
const clients = computed(() => clientsQuery.data.value ?? []);
const isEmpty = computed(() => connectionsQuery.isSuccess.value && connections.value.length === 0);

const showRemoved = ref(false);

// --- Ergebnis des OAuth-Callbacks (`?oauth=<Ergebnis>`) ------------------------------------

const notice = computed(() => oauthNotice(route.query.oauth));

function dismissNotice() {
  const query = { ...route.query };
  delete query.oauth;
  void router.replace({ query });
}

// --- Verbinden und Neu verbinden -----------------------------------------------------------

/** `'new'` = neue Connection, sonst die ID der Connection, die neu verbunden wird. */
const redirecting = ref<string | null>(null);

/** „Zurück“ von Amazon stellt die Seite aus dem bfcache wieder her: Buttons wieder freigeben. */
function onPageShow(event: PageTransitionEvent) {
  if (event.persisted) redirecting.value = null;
}
onMounted(() => window.addEventListener('pageshow', onPageShow));
onBeforeUnmount(() => window.removeEventListener('pageshow', onPageShow));
const actionErrorKey = ref<string | null>(null);

function isHttpUrl(value: string) {
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

async function startOAuth(connection?: Connection) {
  actionErrorKey.value = null;
  redirecting.value = connection?.id ?? 'new';
  try {
    const url = await api.startAmazonOAuth(connection ? { connectionId: connection.id } : {});
    if (!isHttpUrl(url)) throw new Error('Unerwartete Weiterleitungs-URL.');
    // Die Seite wird gleich verlassen; der Button bleibt bis dahin im Ladezustand.
    browserNavigation.assign(url);
  } catch (error) {
    redirecting.value = null;
    actionErrorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}

// --- Profile ändern und Clients anlegen ---------------------------------------------------

function patchProfile(profile: Profile, patch: ProfilePatch) {
  actionErrorKey.value = null;
  updateProfile.mutate(
    { profile, patch },
    { onError: () => (actionErrorKey.value = 'connections.profiles.updateFailed') },
  );
}

/** Profil, für das gerade ein neuer Client angelegt wird. */
const clientDialogProfile = ref<Profile | null>(null);

/** Dialog „Profil ohne Connection anlegen“ (Datei-Import, 1.11a). */
const fileProfileDialogOpen = ref(false);

function onClientCreated(client: Client) {
  const profile = clientDialogProfile.value;
  clientDialogProfile.value = null;
  if (profile) patchProfile(profile, { clientId: client.id });
}
</script>

<template>
  <div class="flex flex-col gap-space-xl">
    <PageHeader
      :title="t('nav.connections')"
      :eyebrow="t('connections.eyebrow')"
      :description="t('connections.description')"
    >
      <template v-if="!isEmpty" #actions>
        <Button
          :label="t('connections.connect')"
          icon="pi pi-plus"
          :loading="redirecting === 'new'"
          @click="startOAuth()"
        />
      </template>
    </PageHeader>

    <InlineError v-if="notice?.severity === 'error'" :message="t(notice.messageKey)">
      <template #action>
        <Button
          icon="pi pi-times"
          size="small"
          variant="text"
          severity="danger"
          :aria-label="t('connections.oauth.dismiss')"
          class="-my-1 shrink-0"
          @click="dismissNotice"
        />
      </template>
    </InlineError>
    <div
      v-else-if="notice"
      role="status"
      class="flex items-start gap-space-sm rounded-control bg-violet-wash px-space-md py-space-sm text-body-sm text-ink"
    >
      <i
        :class="[
          'pi mt-0.5 shrink-0',
          notice.severity === 'success'
            ? 'pi-check-circle text-lime-deep'
            : 'pi-info-circle text-warn',
        ]"
        aria-hidden="true"
      />
      <p class="min-w-0 flex-1">{{ t(notice.messageKey) }}</p>
      <Button
        icon="pi pi-times"
        size="small"
        variant="text"
        severity="secondary"
        :aria-label="t('connections.oauth.dismiss')"
        class="-my-1 shrink-0"
        @click="dismissNotice"
      />
    </div>

    <InlineError v-if="actionErrorKey" :message="t(actionErrorKey)" />
    <InlineError
      v-if="clientsQuery.isError.value"
      :message="t('connections.clientsLoadError')"
      retryable
      :retrying="clientsQuery.isFetching.value"
      @retry="clientsQuery.refetch()"
    />

    <div
      v-if="connectionsQuery.isPending.value"
      class="flex flex-col gap-space-lg"
      aria-busy="true"
    >
      <SkeletonBlock shape="tile" height="16rem" />
    </div>

    <InlineError
      v-else-if="connectionsQuery.isError.value"
      :message="t('connections.loadError')"
      retryable
      :retrying="connectionsQuery.isFetching.value"
      @retry="connectionsQuery.refetch()"
    />

    <EmptyState
      v-else-if="isEmpty"
      icon="link"
      :title="t('connections.emptyTitle')"
      :text="t('connections.emptyText')"
    >
      <Button
        :label="t('connections.connect')"
        icon="pi pi-plus"
        :loading="redirecting === 'new'"
        @click="startOAuth()"
      />
    </EmptyState>

    <template v-else>
      <div class="flex items-center justify-end gap-space-sm">
        <ToggleSwitch v-model="showRemoved" input-id="connections-show-removed" />
        <label for="connections-show-removed" class="text-body-sm text-ink">
          {{ t('connections.profiles.showRemoved') }}
        </label>
      </div>
      <ConnectionCard
        v-for="connection in connections"
        :key="connection.id"
        :connection="connection"
        :clients="clients"
        :clients-ready="clientsQuery.isSuccess.value"
        :show-removed="showRemoved"
        :polling="syncPolling.polling.value"
        :reconnecting="redirecting === connection.id"
        @reconnect="startOAuth"
        @synced="onSyncQueued"
        @patch="patchProfile"
        @create-client="(profile) => (clientDialogProfile = profile)"
      />
    </template>

    <!-- Unabhängig von den Connections: auch bei deren Ladefehler sichtbar. -->
    <FileProfilesCard
      v-if="!connectionsQuery.isPending.value"
      :clients="clients"
      :clients-ready="clientsQuery.isSuccess.value"
      :show-removed="showRemoved"
      @create="fileProfileDialogOpen = true"
      @patch="patchProfile"
      @create-client="(profile) => (clientDialogProfile = profile)"
    />

    <ClientsCard v-if="clients.length > 0" :clients="clients" />

    <CreateClientDialog
      :account-name="clientDialogProfile?.accountName ?? null"
      @created="onClientCreated"
      @close="clientDialogProfile = null"
    />
    <CreateFileProfileDialog
      :visible="fileProfileDialogOpen"
      @created="fileProfileDialogOpen = false"
      @close="fileProfileDialogOpen = false"
    />
  </div>
</template>
