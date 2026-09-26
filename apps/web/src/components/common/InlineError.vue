<script setup lang="ts">
import Button from 'primevue/button';
import { useI18n } from 'vue-i18n';

defineProps<{
  message: string;
  /** Zeigt „Erneut versuchen“ an. */
  retryable?: boolean;
  retrying?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();
const { t } = useI18n();
</script>

<template>
  <div
    role="alert"
    class="flex items-start gap-space-sm rounded-control bg-loss-wash px-space-md py-space-sm text-body-sm text-on-loss-wash"
  >
    <i class="pi pi-exclamation-triangle mt-0.5 shrink-0" aria-hidden="true" />
    <p class="min-w-0 flex-1">{{ message }}</p>
    <Button
      v-if="retryable"
      :label="t('common.retry')"
      :loading="retrying"
      size="small"
      variant="text"
      severity="danger"
      class="-my-1 shrink-0"
      @click="emit('retry')"
    />
    <slot name="action" />
  </div>
</template>
