<script setup lang="ts">
import {
  DEFAULT_STRUCTURE_CATALOG,
  formatDateTime,
  structureCatalogSchema,
  type StructureCatalog,
} from '@profitbash/shared';
import Button from 'primevue/button';
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
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
import { describeCatalogIssues } from '../tools/catalog/issues';
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
/** Version, auf der der Entwurf beruht; mit ihr wird gespeichert (409, wenn inzwischen jemand anderes gespeichert hat). */
const baseVersion = ref(0);
/**
 * Vergleich unabhängig von der Reihenfolge der Schlüssel: Vue Query übernimmt beim Aktualisieren unveränderte
 * Teilobjekte aus den alten Daten (samt deren Reihenfolge), der Entwurf hat die des Servers.
 */
const serialize = (catalog: StructureCatalog) =>
  JSON.stringify(catalog, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
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
      baseVersion.value = next.version;
      loaded.value = true;
    }
  },
  { immediate: true },
);
/** Ein geänderter Entwurf, der auf einer älteren Version beruht als der Stand auf dem Server. */
const stale = computed(
  () => data.value !== undefined && dirty.value && data.value.version !== baseVersion.value,
);
const usage = computed(() => {
  const counts = new Map<string, { clients: number; productGroups: number }>();
  const entry = (key: string) => counts.get(key) ?? { clients: 0, productGroups: 0 };
  for (const { presetKey } of data.value?.clientPresets ?? []) {
    counts.set(presetKey, { ...entry(presetKey), clients: entry(presetKey).clients + 1 });
  }
  for (const { presetKey, productGroups } of data.value?.productGroupPresets ?? []) {
    counts.set(presetKey, { ...entry(presetKey), productGroups });
  }
  return counts;
});
provide(CATALOG_DRAFT, { draft, canEdit: canEditCatalog, usage });

// Ungespeicherte Änderungen nicht still verlieren (Tab schließen, neu laden).
const onBeforeUnload = (event: BeforeUnloadEvent) => {
  if (dirty.value) event.preventDefault();
};
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));

const validation = computed(() => structureCatalogSchema.safeParse(draft.value));
const issues = computed(() =>
  validation.value.success
    ? []
    : describeCatalogIssues(validation.value.error.issues, draft.value, (key, params) =>
        t(key, params ?? {}),
      ),
);

const TABS = ['presets', 'blocks', 'edges', 'naming', 'assignments'] as const;
const tab = ref<(typeof TABS)[number]>('presets');
const tabId = (name: string) => `catalog-tab-${name}`;
function moveTab(step: number) {
  const next = TABS[(TABS.indexOf(tab.value) + step + TABS.length) % TABS.length]!;
  tab.value = next;
  document.getElementById(tabId(next))?.focus();
}

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
      version: baseVersion.value,
    });
    draft.value = clone(result.catalog);
    baseVersion.value = result.version;
    savedNotice.value = true;
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'UNKNOWN';
    saveErrorKey.value =
      code === 'STRUCTURE_CATALOG_VERSION_CONFLICT' ? 'catalog.conflict' : errorMessageKey(code);
  }
}
function discard() {
  if (data.value) {
    draft.value = clone(data.value.catalog);
    baseVersion.value = data.value.version;
  }
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
        <Button
          v-if="canEditCatalog"
          data-catalog-defaults
          class="ml-auto"
          severity="secondary"
          variant="text"
          size="small"
          :label="t('catalog.defaults')"
          :title="t('catalog.defaultsHint')"
          :disabled="save.isPending.value"
          @click="loadDefaults"
        />
      </div>
      <p v-if="!canEditCatalog" class="text-body-md text-ink-secondary">
        {{ t('catalog.readOnly') }}
      </p>

      <InlineError v-if="saveErrorKey" :message="t(saveErrorKey)" />
      <p
        v-if="stale"
        role="status"
        class="rounded-tile bg-well p-space-md text-body-md text-warn"
        data-catalog-stale
      >
        {{ t('catalog.staleDraft', { version: data.version, base: baseVersion }) }}
      </p>
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
          :id="tabId(name)"
          :data-catalog-tab="name"
          aria-controls="catalog-tabpanel"
          :aria-selected="tab === name"
          :tabindex="tab === name ? 0 : -1"
          :class="[
            'whitespace-nowrap rounded-control px-space-md py-space-sm text-body-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-violet',
            tab === name
              ? 'bg-violet-wash font-semibold text-violet'
              : 'text-ink-secondary hover:bg-violet-wash hover:text-ink',
          ]"
          @click="tab = name"
          @keydown.right.prevent="moveTab(1)"
          @keydown.left.prevent="moveTab(-1)"
        >
          {{ t(`catalog.tabs.${name}`) }}
        </button>
      </div>

      <div id="catalog-tabpanel" role="tabpanel" :aria-labelledby="tabId(tab)">
        <CatalogPresets v-if="tab === 'presets'" />
        <CatalogBlocks v-else-if="tab === 'blocks'" />
        <CatalogEdges v-else-if="tab === 'edges'" />
        <CatalogNaming v-else-if="tab === 'naming'" />
        <CatalogAssignments v-else :data="data" />
      </div>

      <div
        v-if="canEditCatalog"
        class="sticky bottom-0 z-10 flex flex-nowrap items-center gap-space-sm bg-canvas/85 py-space-sm backdrop-blur-xl"
      >
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
      </div>
    </template>
  </div>
</template>
