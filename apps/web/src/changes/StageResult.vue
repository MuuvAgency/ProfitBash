<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { StageAdChangesData } from '../api/client';

/**
 * Ergebnis eines Vormerkens (`POST /api/ads/changes/pending`): wie viele Änderungen im Warenkorb gelandet sind, was
 * unverändert blieb, was zurückgenommen wurde und was der Server mit welchem Grund abgelehnt hat.
 */
const props = defineProps<{ result: StageAdChangesData }>();
const { t } = useI18n();

const staged = computed(() => props.result.counts.created + props.result.counts.updated);
const rejected = computed(() => {
  const byReason = new Map<string, number>();
  for (const result of props.result.results) {
    if (result.outcome !== 'rejected') continue;
    byReason.set(result.reason, (byReason.get(result.reason) ?? 0) + 1);
  }
  return [...byReason].map(([reason, count]) => ({ reason, count }));
});
</script>

<template>
  <div data-stage-result role="status" class="flex flex-col gap-space-xs text-body-sm text-ink">
    <p class="font-semibold">
      <i class="pi pi-check-circle mr-space-xs text-lime-deep" aria-hidden="true" />{{
        t('changes.stage.staged', { count: staged }, staged)
      }}
    </p>
    <p v-if="result.counts.removed > 0" class="text-ink-secondary">
      {{ t('changes.stage.removed', { count: result.counts.removed }, result.counts.removed) }}
    </p>
    <p v-if="result.counts.unchanged > 0" class="text-ink-secondary">
      {{
        t('changes.stage.unchanged', { count: result.counts.unchanged }, result.counts.unchanged)
      }}
    </p>
    <p v-for="item in rejected" :key="item.reason" class="text-on-loss-wash">
      <i class="pi pi-exclamation-triangle mr-space-xs" aria-hidden="true" />{{
        t('changes.stage.rejected', {
          count: item.count,
          reason: t(`changes.rejection.${item.reason}`),
        })
      }}
    </p>
  </div>
</template>
