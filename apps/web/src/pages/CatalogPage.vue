<script setup lang="ts">
import {
  DEFAULT_STRUCTURE_CATALOG,
  formatDateTime,
  structureCatalogSchema,
  type StructureCatalog,
} from '@profitbash/shared';
import Button from 'primevue/button';
import { computed, provide, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useSessionStore } from '../stores/session';
import CatalogAssignments from '../tools/catalog/CatalogAssignments.vue';
import CatalogBlocks from '../tools/catalog/CatalogBlocks.vue';
import CatalogEdges from '../tools/catalog/CatalogEdges.vue';
import CatalogNaming from '../tools/catalog/CatalogNaming.vue';
import CatalogPresets from '../tools/catalog/CatalogPresets.vue';
import { CATALOG_DRAFT } from '../tools/catalog/draft';
import { useSaveStructureCatalog, useStructureCatalog, useToolRights } from '../tools/queries';
import ToolsTabs from '../tools/ToolsTabs.vue';

/**
 * Seite „Struktur-Katalog“ (`phase-4.md` 4.2, F11, F-S8): Presets, Bausteine, Graduation-Kanten und Namensschema der
 * Organisation als Entwurf bearbeiten (nur Admins) und als Ganzes speichern; Presets je Client (Admins und Editoren).
 */
const { t } = useI18n();
const session = useSessionStore();
const { canEditCatalog } = useToolRights();
const query = useStructureCatalog();
const data = computed(() => query.data.value);

/** Tiefe Kopie (structuredClone scheitert an reaktiven Proxies). */
const clone = (catalog: StructureCatalog): StructureCatalog =>
  JSON.parse(JSON.stringify(catalog)) as StructureCatalog;
const draft = ref<StructureCatalog>(clone(DEFAULT_STRUCTURE_CATALOG));
const loaded = ref(false);
const serialize = (catalog: StructureCatalog) => JSON.stringify(catalog);
const dirty = computed(
  () => data.value !== undefined && serialize(draft.value) !== serialize(data.value.catalog),
);
// Neue Daten vom Server übernehmen, solange der Entwurf nicht geändert ist (sonst ginge Arbeit verloren).
watch(
  data,
  (next, previous) => {
    if (!next) return;
    if (!loaded.value || (previous && serialize(draft.value) === serialize(previous.catalog))) {
      draft.value = clone(next.catalog);
      loaded.value = true;
    }
  },
  { immediate: true },
);
provide(CATALOG_DRAFT, { draft, canEdit: canEditCatalog });

const validation = computed(() => structureCatalogSchema.safeParse(draft.value));
const issues = computed(() =>
  validation.value.success ? [] : [...new Set(validation.value.error.issues.map((i) => i.message))],
);

const TABS = ['presets', 'blocks', 'edges', 'naming', 'assignments'] as const;
const tab = ref<(typeof TABS)[number]>('presets');

const save = useSaveStructureCatalog();
const saveErrorKey = ref<string | null>(null);
const savedNotice = ref(false);
const canSave = computed(
  () => canEditCatalog.value && dirty.value && validation.value.success && !save.isPending.value,
);
async function submit() {
  if (!canSave.value || !data.value || !validation.value.success) return;
  saveErrorKey.value = null;
  savedNotice.value = false;
  try {
    const result = await save.mutateAsync({
      catalog: validation.value.data,
      version: data.value.version,
    });
    draft.value = clone(result.catalog);
    savedNotice.value = true;
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'UNKNOWN';
    saveErrorKey.value =
      code === 'STRUCTURE_CATALOG_VERSION_CONFLICT' ? 'catalog.conflict' : errorMessageKey(code);
  }
}
function discard() {
  if (data.value) draft.value = clone(data.value.catalog);
  saveErrorKey.value = null;
}
function loadDefaults() {
  draft.value = clone(DEFAULT_STRUCTURE_CATALOG);
  savedNotice.value = false;
}
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <PageHeader
      :eyebrow="t('productGroups.eyebrow')"
      :title="t('catalog.title')"
      :description="t('catalog.description')"
    />
    <ToolsTabs current="catalog" />

    <InlineError
      v-if="query.isError.value"
      :message="t('catalog.loadFailed')"
      retryable
      :retrying="query.isFetching.value"
      @retry="query.refetch()"
    />
    <SkeletonBlock v-else-if="!data" shape="tile" height="20rem" />

    <template v-else>
      <div class="flex flex-wrap items-center gap-space-md">
        <span class="font-data text-body-sm text-ink-secondary">
          <template v-if="data.updatedAt">
            {{ t('catalog.version', { version: data.version }) }} ·
            {{ formatDateTime(data.updatedAt, session.preferences.locale) }}
          </template>
          <template v-else>{{ t('catalog.neverSaved') }}</template>
        </span>
        <span v-if="dirty" class="text-body-sm text-warn">{{ t('catalog.dirty') }}</span>
        <span v-else-if="savedNotice" role="status" class="text-body-sm text-lime-deep">
          {{ t('catalog.saved') }}
        </span>
      </div>
      <p v-if="!canEditCatalog" class="text-body-md text-ink-secondary">
        {{ t('catalog.readOnly') }}
      </p>

      <InlineError v-if="saveErrorKey" :message="t(saveErrorKey)" />
      <section
        v-if="issues.length > 0"
        data-catalog-issues
        role="alert"
        class="flex flex-col gap-space-xs rounded-tile bg-loss-wash p-space-md text-body-md text-on-loss-wash"
      >
        <p>{{ t('catalog.issues') }}</p>
        <ul class="list-disc pl-space-lg">
          <li v-for="issue in issues" :key="issue">{{ issue }}</li>
        </ul>
      </section>

      <div
        role="tablist"
        :aria-label="t('catalog.title')"
        class="flex gap-space-xs overflow-x-auto"
      >
        <button
          v-for="name in TABS"
          :key="name"
          type="button"
          role="tab"
          :data-catalog-tab="name"
          :aria-selected="tab === name"
          :class="[
            'whitespace-nowrap rounded-control px-space-md py-space-sm text-body-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-violet',
            tab === name
              ? 'bg-violet-wash font-semibold text-violet'
              : 'text-ink-secondary hover:bg-violet-wash hover:text-ink',
          ]"
          @click="tab = name"
        >
          {{ t(`catalog.tabs.${name}`) }}
        </button>
      </div>

      <div role="tabpanel">
        <CatalogPresets v-if="tab === 'presets'" />
        <CatalogBlocks v-else-if="tab === 'blocks'" />
        <CatalogEdges v-else-if="tab === 'edges'" />
        <CatalogNaming v-else-if="tab === 'naming'" />
        <CatalogAssignments v-else :data="data" />
      </div>

      <div v-if="canEditCatalog" class="flex flex-wrap items-center gap-space-sm">
        <Button
          data-catalog-save
          icon="pi pi-check"
          :label="t('catalog.save')"
          :loading="save.isPending.value"
          :disabled="!canSave"
          @click="submit"
        />
        <Button
          data-catalog-discard
          severity="secondary"
          variant="text"
          :label="t('catalog.discard')"
          :disabled="!dirty || save.isPending.value"
          @click="discard"
        />
        <Button
          data-catalog-defaults
          severity="secondary"
          variant="text"
          :label="t('catalog.defaults')"
          :title="t('catalog.defaultsHint')"
          :disabled="save.isPending.value"
          @click="loadDefaults"
        />
      </div>
    </template>
  </div>
</template>
