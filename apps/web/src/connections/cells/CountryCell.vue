<script setup lang="ts">
import { computed } from 'vue';
import { countryName } from '../country';
import CountryFlag from '../CountryFlag.vue';
import type { ProfileCellParams } from './types';

const props = defineProps<{ params: ProfileCellParams }>();
const code = computed(() => props.params.data?.countryCode ?? '');
</script>

<template>
  <span class="flex items-center gap-space-sm">
    <CountryFlag :country-code="code" />
    <span class="truncate">{{ countryName(code) }}</span>
    <span class="font-data text-data-sm text-ink-tertiary">{{ code }}</span>
  </span>
</template>
