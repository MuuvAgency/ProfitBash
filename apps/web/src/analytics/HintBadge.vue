<script setup lang="ts">
import Popover from 'primevue/popover';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { MetricHint } from './hints';

/**
 * Hinweis an einer Kennzahl als kleiner Schalter mit Erklärung im Popover. Per Klick statt Tooltip, damit der Text
 * auch auf Touch-Geräten lesbar ist (`phase-2.md` F14).
 */
const props = defineProps<{ hint: MetricHint }>();

const { t } = useI18n();
const popover = ref<InstanceType<typeof Popover>>();
const open = ref(false);

const content = computed(() => {
  const hint = props.hint;
  switch (hint.kind) {
    case 'approx':
      return {
        icon: 'pi-sync',
        tone: 'info',
        label: t('analytics.hint.approx'),
        text: t('analytics.hint.approxText'),
      };
    case 'missingFx':
      return {
        icon: 'pi-exclamation-triangle',
        tone: 'warn',
        label: t('analytics.hint.missingFx', { currencies: hint.currencies.join(', ') }),
        text: t('analytics.hint.missingFxText'),
      };
    case 'mixedAttribution':
      return {
        icon: 'pi-info-circle',
        tone: 'info',
        label: t('analytics.hint.mixedAttribution'),
        text: t('analytics.hint.mixedAttributionText'),
      };
    case 'missingValue':
      return {
        icon: 'pi-question-circle',
        tone: 'info',
        label: t('analytics.hint.missingValue'),
        text: t('analytics.hint.missingValueText'),
      };
    case 'partialValue':
      return {
        icon: 'pi-exclamation-circle',
        tone: 'warn',
        label: t('analytics.hint.partialValue'),
        text: t('analytics.hint.partialValueText'),
      };
  }
});
</script>

<template>
  <button
    type="button"
    :aria-label="t('analytics.hint.showHint', { label: content.label })"
    :aria-expanded="open"
    :class="[
      'inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-violet-wash focus-visible:outline-2 focus-visible:outline-violet',
      content.tone === 'warn' ? 'text-warn' : 'text-ink-tertiary',
    ]"
    @click="popover?.toggle($event)"
  >
    <i :class="['pi', content.icon, 'text-body-sm']" aria-hidden="true" />
  </button>
  <Popover ref="popover" @show="open = true" @hide="open = false">
    <div class="flex max-w-xs flex-col gap-space-xs">
      <p class="text-body-sm font-semibold text-ink">{{ content.label }}</p>
      <p class="text-body-sm text-ink-secondary">{{ content.text }}</p>
    </div>
  </Popover>
</template>
