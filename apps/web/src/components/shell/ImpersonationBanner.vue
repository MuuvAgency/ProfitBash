<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import Button from 'primevue/button';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { api } from '../../api';
import { useSessionStore } from '../../stores/session';

/**
 * Banner während „Als Nutzer ansehen“ (`phase-6.md` 6.5, F4): Der Superadmin handelt mit den vollen Rechten des
 * Nutzers, das Audit-Log nennt ihn selbst. „Beenden“ stellt seine eigene Session wieder her.
 */
const { t } = useI18n();
const session = useSessionStore();
const router = useRouter();
const queryClient = useQueryClient();

const stop = useMutation({
  mutationFn: () => api.platform.stopImpersonation(),
  onSuccess: async () => {
    // Alles Geladene gehörte dem angesehenen Nutzer.
    queryClient.clear();
    await session.reload();
    await router.replace('/admin/platform');
  },
});
</script>

<template>
  <div
    v-if="session.me?.impersonatedBy"
    data-impersonation-banner
    role="status"
    class="flex flex-wrap items-center gap-x-space-md gap-y-space-sm rounded-control bg-panel px-space-md py-space-sm text-body-sm text-on-panel"
  >
    <i class="pi pi-eye shrink-0 text-warn" aria-hidden="true" />
    <p class="min-w-0 flex-1 basis-48">
      <strong class="font-semibold">
        {{ t('impersonation.banner', { name: session.me.user.name }) }}
      </strong>
      {{ t('impersonation.hint') }}
      <span v-if="stop.isError.value" role="alert">{{ t('impersonation.stopFailed') }}</span>
    </p>
    <Button
      :label="t('impersonation.stop')"
      icon="pi pi-sign-out"
      size="small"
      :loading="stop.isPending.value"
      @click="stop.mutate()"
    />
  </div>
</template>
