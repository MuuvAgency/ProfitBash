<script setup lang="ts">
import type { Client, Connection, Profile, ProfilePatch } from '@profitbash/shared';
import Button from 'primevue/button';
import ToggleSwitch from 'primevue/toggleswitch';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError } from '../api';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { browserNavigation } from '../connections/browser-navigation';
import ConnectionCard from '../connections/ConnectionCard.vue';
import CreateClientDialog from '../connections/CreateClientDialog.vue';
import { oauthNotice } from '../connections/oauth-notice';
import { useClientsQuery, useConnectionsQuery, useUpdateProfile } from '../connections/queries';
import { errorMessageKey } from '../i18n';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const connectionsQuery = useConnectionsQuery();
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
        :show-removed="showRemoved"
        :reconnecting="redirecting === connection.id"
        @reconnect="startOAuth"
        @patch="patchProfile"
        @create-client="(profile) => (clientDialogProfile = profile)"
      />
    </template>

    <CreateClientDialog
      :account-name="clientDialogProfile?.accountName ?? null"
      @created="onClientCreated"
      @close="clientDialogProfile = null"
    />
  </div>
</template>
