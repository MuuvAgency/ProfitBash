<script setup lang="ts">
import Button from 'primevue/button';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useJobRunLabels } from '../labels';
import type { JobRunCellParams } from './types';

const props = defineProps<{ params: JobRunCellParams }>();
const { t } = useI18n();
const labels = useJobRunLabels();

const run = computed(() => props.params.data);
const counters = computed(() => (run.value ? labels.counterParts(run.value) : []));
/** Vollständig im Tooltip, wenn die Zeile gekürzt ist. */
const countersText = computed(() => (run.value ? labels.counters(run.value) : ''));
const expanded = computed(() =>
  run.value ? props.params.context.expanded.has(run.value.id) : false,
);
const detailsId = computed(() => `job-run-error-${run.value?.id}`);
/** Eingeklappt steht nur die erste Zeile da (gekürzt). */
const firstLine = computed(() => run.value?.error?.split('\n', 1)[0] ?? '');

const toggleLabel = computed(() => (expanded.value ? t('sync.hideError') : t('sync.showError')));
const accessibleLabel = computed(() =>
  run.value
    ? t('sync.errorToggleLabel', {
        action: toggleLabel.value,
        job: labels.job(run.value.job),
        startedAt: labels.startedAt(run.value),
      })
    : toggleLabel.value,
);
</script>

<!-- Zähler des Laufs; bei Fehlern darunter der Schalter mit der ersten Zeile, aufgeklappt der ganze Text. -->
<template>
  <div v-if="run" class="flex min-h-[52px] w-full min-w-0 flex-col justify-center gap-1 py-2">
    <span v-if="counters.length > 0" class="truncate" :title="countersText">
      <template v-for="(part, index) in counters" :key="part.key">
        <template v-if="index > 0"> · </template>
        <span class="font-data">{{ part.value }}</span> {{ part.label }}
      </template>
    </span>
    <template v-if="run.error">
      <div class="flex min-w-0 items-center gap-space-sm">
        <!-- Links, damit der Schalter beim Auf- und Zuklappen an seiner Stelle bleibt. -->
        <Button
          :label="toggleLabel"
          :aria-label="accessibleLabel"
          :aria-expanded="expanded"
          :aria-controls="expanded ? detailsId : undefined"
          :icon="expanded ? 'pi pi-chevron-up' : 'pi pi-chevron-down'"
          size="small"
          variant="text"
          severity="danger"
          class="-ml-2 shrink-0"
          @click="params.context.toggleError(run.id)"
        />
        <span v-if="!expanded" class="min-w-0 flex-1 truncate text-ink-secondary">
          {{ firstLine }}
        </span>
      </div>
      <!-- `v-text`: Leerraum aus dem Template zeigte `pre-wrap` sonst mit an. -->
      <p
        v-if="expanded"
        :id="detailsId"
        class="whitespace-pre-wrap break-words text-body-sm leading-normal text-ink"
        v-text="run.error"
      />
    </template>
  </div>
</template>
