<script setup lang="ts">
import Button from 'primevue/button';
import { useI18n } from 'vue-i18n';
import EmptyState from '../components/common/EmptyState.vue';

const { t } = useI18n();
</script>

<template>
  <EmptyState icon="lock" :title="t('forbidden.title')" :text="t('forbidden.text')">
    <RouterLink v-slot="{ navigate }" :to="{ name: 'home' }" custom>
      <Button
        :label="t('common.backHome')"
        icon="pi pi-arrow-right"
        icon-pos="right"
        @click="navigate"
      />
    </RouterLink>
  </EmptyState>
</template>
