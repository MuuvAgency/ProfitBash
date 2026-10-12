<script setup lang="ts">
import type {
  Client,
  ProfilePatch,
  SellerAccount,
  SellerAccountsSync,
  SellerConnection,
} from '@profitbash/shared';
import Button from 'primevue/button';
import Select from 'primevue/select';
import ToggleSwitch from 'primevue/toggleswitch';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { countryName } from './country';
import CountryFlag from './CountryFlag.vue';
import {
  useSellerConnectionsQuery,
  useSyncSellerConnection,
  useUpdateSellerAccount,
} from './queries';
import SellerConnectionDialog from './SellerConnectionDialog.vue';

/** Seller-Konten der SP-API (Phase 7, 7.2): verbinden, abgleichen, Client zuordnen, ausblenden. */
const props = defineProps<{ clients: Client[]; clientsReady: boolean; showRemoved: boolean }>();

const { t } = useI18n();
const connectionsQuery = useSellerConnectionsQuery();
const syncConnection = useSyncSellerConnection();
const updateAccount = useUpdateSellerAccount();

const connections = computed(() => connectionsQuery.data.value ?? []);
const visibleAccounts = (connection: SellerConnection) =>
  props.showRemoved ? connection.accounts : connection.accounts.filter((a) => !a.removedAt);

const clientOptions = computed(() => [
  { id: null, name: t('connections.profiles.noClient') },
  ...props.clients,
]);

const statusDot = (status: SellerConnection['status']) =>
  ({ active: 'bg-lime', reauth_required: 'bg-warn', error: 'bg-loss' })[status];

/** `null` = geschlossen, `'new'` = neue Connection, sonst die Connection, die neu verbunden wird. */
const dialog = ref<SellerConnection | 'new' | null>(null);
const actionErrorKey = ref<string | null>(null);
/** Zahl übersprungener Marktplätze nach dem letzten Verbinden oder Abgleich. */
const skipped = ref(0);
const syncingId = ref<string | null>(null);

function onSynced(result: SellerAccountsSync) {
  skipped.value = result.skippedMarketplaceIds.length;
}

function onSaved(result: SellerAccountsSync) {
  dialog.value = null;
  onSynced(result);
}

async function sync(connection: SellerConnection) {
  actionErrorKey.value = null;
  syncingId.value = connection.id;
  try {
    onSynced(await syncConnection.mutateAsync(connection.id));
  } catch (error) {
    actionErrorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  } finally {
    syncingId.value = null;
  }
}

function patch(account: SellerAccount, change: ProfilePatch) {
  actionErrorKey.value = null;
  updateAccount.mutate(
    { id: account.id, patch: change },
    { onError: () => (actionErrorKey.value = 'connections.sellerAccounts.updateFailed') },
  );
}

const names = (account: SellerAccount) => ({
  store: account.storeName,
  country: countryName(account.countryCode),
});
</script>

<template>
  <section
    class="flex flex-col gap-space-lg rounded-tile bg-tile p-space-lg shadow-tile"
    :aria-label="t('connections.sellerAccounts.title')"
  >
    <header class="flex flex-col gap-space-md lg:flex-row lg:items-start lg:justify-between">
      <div class="flex min-w-0 items-start gap-space-md">
        <span
          class="flex size-12 shrink-0 items-center justify-center rounded-control bg-panel text-on-panel"
          aria-hidden="true"
        >
          <i class="pi pi-shop text-headline-sm" />
        </span>
        <div class="flex min-w-0 flex-col gap-space-xs">
          <h2 class="text-headline-sm text-ink">{{ t('connections.sellerAccounts.title') }}</h2>
          <p class="text-body-sm text-ink-secondary">
            {{ t('connections.sellerAccounts.description') }}
          </p>
        </div>
      </div>
      <Button
        :label="t('connections.sellerAccounts.connect')"
        icon="pi pi-plus"
        severity="secondary"
        variant="outlined"
        class="shrink-0"
        @click="dialog = 'new'"
      />
    </header>

    <InlineError v-if="actionErrorKey" :message="t(actionErrorKey)" />
    <p v-if="skipped > 0" role="status" class="text-body-sm text-ink-secondary">
      {{ t('connections.sellerAccounts.skipped', { count: skipped }, skipped) }}
    </p>

    <div
      v-if="connectionsQuery.isPending.value"
      class="flex flex-col gap-space-sm"
      aria-busy="true"
    >
      <SkeletonBlock v-for="n in 2" :key="n" height="2.5rem" />
    </div>
    <InlineError
      v-else-if="connectionsQuery.isError.value"
      :message="t('connections.sellerAccounts.loadError')"
      retryable
      :retrying="connectionsQuery.isFetching.value"
      @retry="connectionsQuery.refetch()"
    />
    <p v-else-if="connections.length === 0" class="text-body-md text-ink-secondary">
      {{ t('connections.sellerAccounts.empty') }}
    </p>

    <div
      v-for="connection in connections"
      v-else
      :key="connection.id"
      class="flex flex-col gap-space-md border-t border-line pt-space-lg first-of-type:border-t-0 first-of-type:pt-0"
    >
      <div class="flex flex-col gap-space-sm md:flex-row md:items-center md:justify-between">
        <div class="flex min-w-0 flex-wrap items-center gap-space-sm">
          <h3 class="font-data text-body-md text-ink">
            {{ t('connections.sellerAccounts.sellerId', { id: connection.amazonSellerId }) }}
          </h3>
          <span
            class="inline-flex items-center gap-1.5 rounded-full bg-well px-2.5 py-0.5 text-body-sm text-ink"
          >
            <span
              :class="['size-2 rounded-full', statusDot(connection.status)]"
              aria-hidden="true"
            />
            {{ t(`connections.status.${connection.status}`) }}
          </span>
          <span class="text-body-sm text-ink-secondary">
            {{ t(`connections.region.${connection.region}`) }}
          </span>
        </div>
        <div class="flex shrink-0 flex-wrap gap-space-sm">
          <Button
            :label="t('connections.reconnect')"
            icon="pi pi-refresh"
            size="small"
            :severity="connection.status === 'reauth_required' ? undefined : 'secondary'"
            :variant="connection.status === 'reauth_required' ? undefined : 'text'"
            @click="dialog = connection"
          />
          <Button
            :label="t('connections.sellerAccounts.sync')"
            icon="pi pi-sync"
            size="small"
            severity="secondary"
            variant="outlined"
            :loading="syncingId === connection.id"
            :disabled="connection.status === 'reauth_required'"
            @click="sync(connection)"
          />
        </div>
      </div>

      <p v-if="visibleAccounts(connection).length === 0" class="text-body-sm text-ink-secondary">
        {{
          connection.accounts.length === 0
            ? t('connections.sellerAccounts.noAccounts')
            : t('connections.sellerAccounts.noAccountsFiltered')
        }}
      </p>
      <div
        v-else
        class="-mx-space-lg overflow-x-auto px-space-lg"
        role="region"
        tabindex="0"
        :aria-label="t('connections.sellerAccounts.tableLabel', { id: connection.amazonSellerId })"
      >
        <table class="w-full min-w-[40rem] text-left text-body-sm text-ink">
          <thead class="text-ink-secondary">
            <tr>
              <th scope="col" class="py-space-sm pr-space-md font-semibold">
                {{ t('connections.profiles.column.country') }}
              </th>
              <th scope="col" class="py-space-sm pr-space-md font-semibold">
                {{ t('connections.sellerAccounts.store') }}
              </th>
              <th scope="col" class="py-space-sm pr-space-md font-semibold">
                {{ t('connections.profiles.column.currency') }}
              </th>
              <th scope="col" class="py-space-sm pr-space-md font-semibold">
                {{ t('connections.profiles.column.client') }}
              </th>
              <th scope="col" class="py-space-sm font-semibold">
                {{ t('connections.profiles.column.hidden') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="account in visibleAccounts(connection)"
              :key="account.id"
              class="border-t border-line"
            >
              <td class="py-space-sm pr-space-md">
                <span class="flex items-center gap-space-sm">
                  <CountryFlag :country-code="account.countryCode" />
                  {{ countryName(account.countryCode) }}
                  <span
                    v-if="account.removedAt"
                    v-tooltip.top="t('connections.sellerAccounts.removedHint')"
                    class="rounded-full bg-well px-2 py-0.5 text-ink-secondary"
                  >
                    {{ t('connections.profiles.removed') }}
                  </span>
                </span>
              </td>
              <td class="py-space-sm pr-space-md">{{ account.storeName }}</td>
              <td class="py-space-sm pr-space-md">
                <span class="font-data">{{ account.currencyCode }}</span>
              </td>
              <td class="py-space-sm pr-space-md">
                <Select
                  :model-value="account.clientId"
                  :options="clientOptions"
                  option-label="name"
                  option-value="id"
                  size="small"
                  class="w-48"
                  :disabled="!clientsReady"
                  :aria-label="t('connections.sellerAccounts.clientFor', names(account))"
                  @update:model-value="(clientId) => patch(account, { clientId })"
                />
              </td>
              <td class="py-space-sm">
                <ToggleSwitch
                  :model-value="account.isHidden"
                  :aria-label="t('connections.sellerAccounts.hideFor', names(account))"
                  @update:model-value="(isHidden) => patch(account, { isHidden })"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <SellerConnectionDialog
      :visible="dialog !== null"
      :connection="dialog === 'new' ? null : dialog"
      @saved="onSaved"
      @close="dialog = null"
    />
  </section>
</template>
