<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import EmptyState from '../components/common/EmptyState.vue';
import PageHeader from '../components/common/PageHeader.vue';
import { NAVIGATION } from '../navigation/navigation';

const props = withDefaults(defineProps<{ itemId?: string; phase?: number }>(), {
  itemId: undefined,
  phase: undefined,
});

const { t } = useI18n();

const item = computed(() =>
  NAVIGATION.flatMap((group) => group.items).find((entry) => entry.id === props.itemId),
);
const title = computed(() =>
  props.itemId ? t(item.value?.labelKey ?? `nav.${props.itemId}`) : '',
);
const soon = computed(() => props.phase === 0);
</script>

<template>
  <div v-if="itemId" class="flex flex-col gap-space-xl">
    <PageHeader :title="title" :eyebrow="t('placeholder.eyebrow')" />
    <EmptyState
      :icon="item?.icon ?? 'cog'"
      :title="soon ? t('placeholder.titleSoon') : t('placeholder.title', { phase: phase ?? 0 })"
      :text="soon ? t('placeholder.textSoon') : t(`placeholder.description.${itemId}`)"
    >
      <p v-if="soon" class="text-body-sm text-ink-secondary">
        {{ t(`placeholder.description.${itemId}`) }}
      </p>
    </EmptyState>
  </div>
</template>
