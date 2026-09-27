<script setup lang="ts">
import { computed } from 'vue';
import { useJobRunLabels } from '../labels';
import type { JobRunCellParams } from './types';

const props = defineProps<{ params: JobRunCellParams }>();
const labels = useJobRunLabels();

/** Laufende Jobs rechnen mit der Uhr aus dem Kontext: So zählt die Dauer ohne neue Daten weiter. */
const text = computed(() =>
  props.params.data ? labels.duration(props.params.data, props.params.context.now) : '',
);
</script>

<template>
  <span>{{ text }}</span>
</template>
