<script setup lang="ts">
import type { ICellRendererParams } from 'ag-grid-community';
import { computed } from 'vue';
import type { TagData } from '../api/client';
import type { GridRow } from '../explorer/columns';
import { rowTags } from './row-tags';
import TagChip from './TagChip.vue';

/** Über `cellRendererParams`: die Tags der Organisation nach ID. */
export interface TagsCellParams {
  tags: () => ReadonlyMap<string, TagData>;
}

/**
 * Zelle „Tags“ im Explorer (`phase-3.md` 3.7): eigene Tags mit Farbpunkt, danach die Tags von Amazon (gedämpft, nur
 * Anzeige). Der Wert der Spalte ist der Text aller Namen (Filter, Sortierung, CSV, Neuzeichnen).
 */
const props = defineProps<{ params: ICellRendererParams<GridRow> & TagsCellParams }>();

const tags = computed(() => {
  const row = props.params.data;
  return row && !row.isTotal ? rowTags(row.attributes, props.params.tags()) : null;
});
</script>

<template>
  <span
    v-if="tags"
    class="flex min-w-0 items-center gap-space-xs overflow-hidden"
    :title="typeof params.value === 'string' ? params.value : undefined"
  >
    <TagChip v-for="tag in tags.own" :key="tag.id" :name="tag.name" :color="tag.color" />
    <TagChip v-for="name in tags.amazon" :key="`amazon:${name}`" :name="name" />
  </span>
</template>
