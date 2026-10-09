<script setup lang="ts">
import { formatNumber } from '@profitbash/shared';
import Button from 'primevue/button';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api';
import type { SetupDraftData } from '../api/client';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useSessionStore } from '../stores/session';
import {
  useProductGroups,
  useSetupDrafts,
  useStructureCatalog,
  useToolRights,
} from '../tools/queries';
import SetupEditor from '../tools/setup/SetupEditor.vue';
import ToolsTabs from '../tools/ToolsTabs.vue';

/**
 * Seite „Kampagnen-Setup“ (`phase-4.md` 4.5): Entwürfe des Teams (F13) und der Assistent zum Planen, Speichern und
 * Übermitteln. Übermittelte Entwürfe verweisen auf die Seite „Änderungen“.
 */
const { t } = useI18n();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);
const { canWrite } = useToolRights();
const drafts = useSetupDrafts();
const groups = useProductGroups();
const catalog = useStructureCatalog();
const ready = computed(() => drafts.data.value && groups.data.value && catalog.data.value);
const failed = computed(
  () => drafts.isError.value || groups.isError.value || catalog.isError.value,
);
function retry() {
  void drafts.refetch();
  void groups.refetch();
  void catalog.refetch();
}

const profileLabel = (profileId: string) => {
  const profile = groups.data.value?.profiles.find((p) => p.id === profileId);
  return profile ? `${profile.accountName} (${profile.countryCode})` : '';
};
const dateLabel = (iso: string) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

// --- Editor ------------------------------------------------------------------------------

/** `undefined`: kein Editor; `null`: neues Setup; sonst der geöffnete Entwurf. */
const editing = ref<SetupDraftData | null | undefined>(undefined);
const editorKey = ref(0);
const openErrorKey = ref<string | null>(null);
const opening = ref<string | null>(null);
function openNew() {
  editing.value = null;
  editorKey.value += 1;
}
async function openDraft(id: string) {
  openErrorKey.value = null;
  opening.value = id;
  try {
    editing.value = await api.tools.setup.get(id);
    editorKey.value += 1;
  } catch (error) {
    openErrorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  } finally {
    opening.value = null;
  }
}
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <PageHeader
      :eyebrow="t('setup.eyebrow')"
      :title="t('setup.title')"
      :description="t('setup.description')"
    />
    <ToolsTabs current="setup" />

    <InlineError
      v-if="failed"
      :message="t('setup.loadFailed')"
      retryable
      :retrying="drafts.isFetching.value"
      @retry="retry"
    />
    <SkeletonBlock v-else-if="!ready" shape="tile" height="14rem" />

    <template v-else>
      <SetupEditor
        v-if="editing !== undefined"
        :key="editorKey"
        :draft="editing"
        :groups="groups.data.value!"
        :catalog="catalog.data.value!.catalog"
        :client-presets="catalog.data.value!.clientPresets"
        @close="editing = undefined"
      />
      <div v-else-if="canWrite">
        <Button data-setup-new icon="pi pi-plus" :label="t('setup.create')" @click="openNew" />
      </div>

      <InlineError v-if="openErrorKey" :message="t(openErrorKey)" />
      <section
        class="flex min-w-0 flex-col gap-space-sm rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
      >
        <h2 class="text-label-eyebrow uppercase text-ink-tertiary">
          {{ t('setup.drafts.title') }}
        </h2>
        <EmptyState
          v-if="drafts.data.value!.drafts.length === 0"
          data-setup-empty
          icon="sitemap"
          :title="t('setup.drafts.title')"
          :text="t(canWrite ? 'setup.drafts.empty' : 'setup.drafts.emptyViewer')"
        />
        <ul v-else class="flex flex-col">
          <li
            v-for="draft in drafts.data.value!.drafts"
            :key="draft.id"
            :data-draft="draft.id"
            class="flex flex-wrap items-center gap-x-space-md gap-y-space-xs border-b border-line py-space-sm last:border-b-0"
          >
            <div class="flex min-w-0 flex-1 basis-64 flex-col">
              <span class="text-body-md font-semibold text-ink">{{ draft.name }}</span>
              <span class="text-body-sm text-ink-secondary">
                {{ profileLabel(draft.profileId) }} ·
                {{
                  t(
                    'setup.drafts.campaigns',
                    { count: formatNumber(String(draft.campaigns), locale) },
                    draft.campaigns,
                  )
                }}
                <template v-if="draft.createdByName">
                  · {{ t('setup.drafts.by', { name: draft.createdByName }) }}</template
                >
                · {{ dateLabel(draft.updatedAt) }}
              </span>
            </div>
            <span
              :class="[
                'rounded-control px-space-sm py-space-xs text-body-sm',
                draft.status === 'draft' ? 'bg-violet-wash text-ink' : 'bg-well text-ink-secondary',
              ]"
            >
              {{ t(`setup.drafts.status.${draft.status}`) }}
            </span>
            <RouterLink
              v-if="draft.status === 'submitted' && draft.submissionId"
              :to="{
                path: '/ads/changes',
                query: { tab: 'submissions', submission: draft.submissionId },
              }"
              class="text-body-sm font-semibold text-violet underline"
            >
              {{ t('setup.drafts.toChanges') }}
            </RouterLink>
            <Button
              data-draft-open
              severity="secondary"
              variant="text"
              size="small"
              :label="t('setup.drafts.open')"
              :aria-label="t('setup.drafts.openAria', { name: draft.name })"
              :loading="opening === draft.id"
              @click="openDraft(draft.id)"
            />
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
