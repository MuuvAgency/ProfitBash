<script setup lang="ts">
import { MAX_CATALOG_EDGES } from '@profitbash/shared';
import Button from 'primevue/button';
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { inputClass, labelClass, useCatalogDraft } from './draft';

/** Graduation-Kanten: „Gewinner aus A kommen nach B“ (Ideen-Dokument C.2b); Vorschläge dazu erst in Phase 5. */
const { t } = useI18n();
const id = useId();
const { draft, canEdit } = useCatalogDraft();
const labels = computed(
  () =>
    new Map(draft.value.blocks.map((block) => [block.key, `${block.label} (${block.adProduct})`])),
);
const label = (key: string) => labels.value.get(key) ?? key;

const from = ref('');
const to = ref('');
const canAdd = computed(
  () =>
    from.value !== '' &&
    to.value !== '' &&
    draft.value.edges.length < MAX_CATALOG_EDGES &&
    !draft.value.edges.some((edge) => edge.from === from.value && edge.to === to.value),
);
function add() {
  if (!canAdd.value) return;
  draft.value.edges.push({ from: from.value, to: to.value });
  to.value = '';
}
function remove(index: number) {
  draft.value.edges.splice(index, 1);
}
</script>

<template>
  <section
    class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
  >
    <p class="max-w-prose text-body-sm text-ink-secondary">{{ t('catalog.edges.description') }}</p>
    <p v-if="draft.edges.length === 0" class="text-body-md text-ink-secondary">
      {{ t('catalog.edges.empty') }}
    </p>
    <ul v-else class="flex flex-col">
      <li
        v-for="(edge, index) in draft.edges"
        :key="`${edge.from}>${edge.to}`"
        :data-edge="`${edge.from}>${edge.to}`"
        class="flex min-h-11 items-center gap-space-sm border-b border-line py-space-xs last:border-b-0"
      >
        <span class="min-w-0 flex-1 text-body-md text-ink">
          {{ label(edge.from) }} <span aria-hidden="true">→</span> {{ label(edge.to) }}
        </span>
        <Button
          v-if="canEdit"
          icon="pi pi-times"
          severity="secondary"
          variant="text"
          size="small"
          :aria-label="t('catalog.edges.remove', { from: label(edge.from), to: label(edge.to) })"
          @click="remove(index)"
        />
      </li>
    </ul>
    <div v-if="canEdit" class="flex flex-wrap items-end gap-space-sm">
      <div class="flex min-w-0 flex-1 basis-56 flex-col gap-space-xs">
        <label :for="`${id}-from`" :class="labelClass">{{ t('catalog.edges.from') }}</label>
        <select :id="`${id}-from`" v-model="from" data-edge-from :class="inputClass">
          <option value="" disabled />
          <option v-for="block in draft.blocks" :key="block.key" :value="block.key">
            {{ label(block.key) }}
          </option>
        </select>
      </div>
      <div class="flex min-w-0 flex-1 basis-56 flex-col gap-space-xs">
        <label :for="`${id}-to`" :class="labelClass">{{ t('catalog.edges.to') }}</label>
        <select :id="`${id}-to`" v-model="to" data-edge-to :class="inputClass">
          <option value="" disabled />
          <option v-for="block in draft.blocks" :key="block.key" :value="block.key">
            {{ label(block.key) }}
          </option>
        </select>
      </div>
      <Button
        icon="pi pi-plus"
        severity="secondary"
        data-edge-add
        :label="t('catalog.edges.add')"
        :disabled="!canAdd"
        @click="add"
      />
    </div>
  </section>
</template>
