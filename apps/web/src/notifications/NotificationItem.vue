<script setup lang="ts">
import { formatDateTime, type Notification } from '@profitbash/shared';
import Button from 'primevue/button';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSessionStore } from '../stores/session';
import { notificationTexts } from './labels';

/** Eine Benachrichtigung in der Liste der Seite und der Glocke (5.2b). */
const props = defineProps<{ notification: Notification; compact?: boolean }>();
const emit = defineEmits<{ read: []; navigate: [] }>();

const { t } = useI18n();
const session = useSessionStore();
const texts = computed(() => notificationTexts(props.notification));
const unread = computed(() => props.notification.readAt === null);
const time = computed(() =>
  formatDateTime(props.notification.createdAt, session.preferences.locale),
);
const DOT: Record<Notification['severity'], string> = {
  info: 'bg-violet',
  success: 'bg-lime',
  warning: 'bg-warn',
  error: 'bg-loss',
};

function open() {
  if (unread.value) emit('read');
  emit('navigate');
}
</script>

<template>
  <article
    data-notification
    :data-unread="unread"
    :class="[
      'flex items-start gap-space-sm rounded-control',
      compact ? 'p-space-sm' : 'p-space-md',
      unread ? 'bg-violet-wash/60' : '',
    ]"
  >
    <span
      :class="['mt-1.5 size-2.5 shrink-0 rounded-full', DOT[notification.severity]]"
      role="img"
      :aria-label="t(`notifications.severity.${notification.severity}`)"
    />
    <div class="flex min-w-0 flex-1 flex-col gap-space-xs">
      <div class="flex flex-wrap items-baseline justify-between gap-x-space-sm">
        <component
          :is="compact ? 'h3' : 'h2'"
          :class="['text-body-md text-ink', unread ? 'font-bold' : 'font-medium']"
        >
          {{ texts.title }}
          <span v-if="unread" class="sr-only">({{ t('notifications.unread') }})</span>
        </component>
        <time
          :datetime="notification.createdAt"
          class="font-mono text-body-sm text-ink-tertiary tabular-nums"
          >{{ time }}</time
        >
      </div>
      <p class="text-body-sm wrap-break-word text-ink-secondary">{{ texts.text }}</p>
      <div v-if="notification.link" class="flex flex-wrap gap-space-xs">
        <RouterLink
          :to="notification.link"
          class="rounded-control text-body-sm font-medium text-violet outline-none hover:underline focus-visible:ring-2 focus-visible:ring-violet"
          @click="open"
          >{{ t('notifications.open') }}</RouterLink
        >
      </div>
    </div>
    <Button
      v-if="unread"
      icon="pi pi-check"
      variant="text"
      severity="secondary"
      size="small"
      :aria-label="t('notifications.markRead')"
      v-tooltip.left="t('notifications.markRead')"
      class="shrink-0"
      @click="emit('read')"
    />
  </article>
</template>
