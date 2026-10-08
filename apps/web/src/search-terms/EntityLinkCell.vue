<script setup lang="ts">
import { MISSING_VALUE } from '@profitbash/shared';
import type { ICellRendererParams } from 'ag-grid-community';
import { computed } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import type { TermGridRow } from './columns';

/** Über `cellRendererParams`: Ziel im Explorer, `null` ohne Link (Entity fehlt im Profil). */
export interface EntityLinkCellParams {
  linkFor: (row: TermGridRow) => RouteLocationRaw | null;
}

/**
 * Name von Kampagne bzw. Ad Group einer Suchbegriff-Zeile (2b.2e): Link in den Explorer, wenn die Entity im Profil
 * bekannt ist, sonst reiner Text. Der volle Name steht im `title` (die Spalte schneidet lange Namen ab).
 */
const props = defineProps<{
  params: ICellRendererParams<TermGridRow, string | null> & EntityLinkCellParams;
}>();

/** Leer zählt wie fehlend: kein Link ohne Text. */
const name = computed(() => props.params.value || null);
const link = computed(() => {
  const row = props.params.data;
  return row && name.value ? props.params.linkFor(row) : null;
});
</script>

<template>
  <RouterLink
    v-if="link"
    :to="link"
    :title="name ?? undefined"
    class="truncate font-medium text-violet hover:underline"
    >{{ name }}</RouterLink
  >
  <span v-else class="truncate" :title="name ?? undefined">{{ name ?? MISSING_VALUE }}</span>
</template>
