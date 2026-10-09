<script setup lang="ts">
import { formatNumber } from '@profitbash/shared';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api';
import type { ProductGroupData } from '../api/client';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useSessionStore } from '../stores/session';
import ProductGroupDialog from '../tools/ProductGroupDialog.vue';
import { useDeleteProductGroup, useProductGroups, useToolRights } from '../tools/queries';

/**
 * Seite „Produktgruppen“ (`phase-4.md` 4.1, F2): Gruppen der sichtbaren Profile, nach Profil filterbar; anlegen,
 * ändern und löschen mit dem Recht `write` im Feature `tools`.
 */
const { t } = useI18n();
const id = useId();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);
const { canWrite } = useToolRights();
const query = useProductGroups();
const data = computed(() => query.data.value);
const count = (value: number) => formatNumber(String(value), locale.value);

const profileFilter = ref<string | null>(null);
const profilesById = computed(() => new Map((data.value?.profiles ?? []).map((p) => [p.id, p])));
const clientsById = computed(() => new Map((data.value?.clients ?? []).map((c) => [c.id, c])));
const groups = computed(() =>
  (data.value?.groups ?? []).filter(
    (group) => profileFilter.value === null || group.profileId === profileFilter.value,
  ),
);
function profileLabel(profileId: string) {
  const profile = profilesById.value.get(profileId);
  return profile ? `${profile.accountName} (${profile.countryCode})` : '';
}
function clientLabel(profileId: string) {
  const clientId = profilesById.value.get(profileId)?.clientId;
  return (clientId && clientsById.value.get(clientId)?.name) || t('productGroups.noClient');
}
const hero = (group: ProductGroupData) => group.items.find((item) => item.isHero) ?? null;

// --- Anlegen und Ändern ------------------------------------------------------------------

const editOpen = ref(false);
const editing = ref<ProductGroupData | null>(null);
function openEdit(group: ProductGroupData | null) {
  editing.value = group;
  editOpen.value = true;
}

// --- Löschen -----------------------------------------------------------------------------

const remove = useDeleteProductGroup();
const deleting = ref<ProductGroupData | null>(null);
const deleteErrorKey = ref<string | null>(null);
function openDelete(group: ProductGroupData) {
  deleting.value = group;
  deleteErrorKey.value = null;
  remove.reset();
}
async function confirmDelete() {
  if (!deleting.value || remove.isPending.value) return;
  deleteErrorKey.value = null;
  try {
    await remove.mutateAsync(deleting.value.id);
    deleting.value = null;
  } catch (error) {
    deleteErrorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <PageHeader
      :eyebrow="t('productGroups.eyebrow')"
      :title="t('productGroups.title')"
      :description="t('productGroups.description')"
    />

    <InlineError
      v-if="query.isError.value"
      :message="t('productGroups.loadFailed')"
      retryable
      :retrying="query.isFetching.value"
      @retry="query.refetch()"
    />
    <SkeletonBlock v-else-if="!data" shape="tile" height="14rem" />

    <template v-else>
      <div class="flex flex-wrap items-end gap-space-md">
        <div v-if="data.profiles.length > 1" class="flex min-w-0 flex-col gap-space-xs">
          <label :for="`${id}-filter`" class="text-label-eyebrow uppercase text-ink-tertiary">
            {{ t('productGroups.filter.label') }}
          </label>
          <select
            :id="`${id}-filter`"
            v-model="profileFilter"
            data-profile-filter
            class="h-11 min-w-0 max-w-full rounded-control bg-well px-space-md text-body-md text-ink outline-none focus-visible:ring-2 focus-visible:ring-violet"
          >
            <option :value="null">{{ t('productGroups.filter.all') }}</option>
            <option v-for="profile in data.profiles" :key="profile.id" :value="profile.id">
              {{ profile.accountName }} ({{ profile.countryCode }})
            </option>
          </select>
        </div>
        <Button
          v-if="canWrite && data.profiles.length > 0"
          icon="pi pi-plus"
          data-group-new
          :label="t('productGroups.create')"
          @click="openEdit(null)"
        />
      </div>

      <EmptyState
        v-if="groups.length === 0"
        icon="box"
        :title="t('productGroups.empty.title')"
        :text="
          t(
            data.groups.length > 0
              ? 'productGroups.empty.filtered'
              : canWrite
                ? 'productGroups.empty.text'
                : 'productGroups.empty.textViewer',
          )
        "
      />
      <section
        v-else
        class="flex min-w-0 flex-col rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
      >
        <ul class="flex flex-col" data-group-list>
          <li
            v-for="group in groups"
            :key="group.id"
            :data-group="group.id"
            class="flex flex-wrap items-center gap-x-space-md gap-y-space-xs border-b border-line py-space-sm last:border-b-0"
          >
            <div class="flex min-w-0 flex-1 basis-64 flex-col">
              <span class="text-body-md font-semibold text-ink">{{ group.name }}</span>
              <span class="text-body-sm text-ink-secondary">
                {{ profileLabel(group.profileId) }} · {{ clientLabel(group.profileId) }}
              </span>
            </div>
            <span class="flex min-w-0 basis-48 flex-col">
              <span class="font-data text-body-sm tabular-nums text-ink">
                <template v-if="hero(group)"
                  >{{ t('productGroups.hero') }}: {{ hero(group)!.asin }}</template
                >
                <template v-else>{{ t('productGroups.noHero') }}</template>
              </span>
              <span class="font-data text-body-sm tabular-nums text-ink-secondary">
                {{
                  t('productGroups.items', { count: count(group.items.length) }, group.items.length)
                }}
              </span>
            </span>
            <span v-if="canWrite" class="flex gap-space-xs">
              <Button
                icon="pi pi-pencil"
                severity="secondary"
                variant="text"
                size="small"
                :aria-label="t('productGroups.edit.action', { name: group.name })"
                @click="openEdit(group)"
              />
              <Button
                icon="pi pi-trash"
                severity="secondary"
                variant="text"
                size="small"
                :aria-label="t('productGroups.delete.action', { name: group.name })"
                @click="openDelete(group)"
              />
            </span>
          </li>
        </ul>
      </section>

      <ProductGroupDialog
        v-if="editOpen"
        :group="editing"
        :profiles="data.profiles"
        :clients="data.clients"
        :groups="data.groups"
        :max-items="data.maxItems"
        :initial-profile-id="profileFilter"
        @close="editOpen = false"
      />
    </template>

    <Dialog
      :visible="deleting !== null"
      modal
      :closable="!remove.isPending.value"
      :close-on-escape="!remove.isPending.value"
      :header="t('productGroups.delete.title')"
      :style="{ width: 'min(28rem, calc(100vw - 2rem))' }"
      @update:visible="(next) => !next && (deleting = null)"
    >
      <div v-if="deleting" class="flex flex-col gap-space-lg">
        <InlineError v-if="deleteErrorKey" :message="t(deleteErrorKey)" />
        <p class="text-body-md text-ink">
          {{ t('productGroups.delete.text', { name: deleting.name }) }}
        </p>
        <div class="flex justify-end gap-space-sm">
          <Button
            type="button"
            :label="t('common.cancel')"
            severity="secondary"
            variant="text"
            :disabled="remove.isPending.value"
            @click="deleting = null"
          />
          <Button
            type="button"
            data-group-delete
            severity="danger"
            :label="t('productGroups.delete.confirm')"
            :loading="remove.isPending.value"
            @click="confirmDelete"
          />
        </div>
      </div>
    </Dialog>
  </div>
</template>
