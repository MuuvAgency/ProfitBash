<script setup lang="ts">
import { computed } from 'vue';

/**
 * Text mit bevorzugten Umbruchstellen nach „@“ und „/“ (E-Mail-Adressen, Zeitzonen): In schmalen Spalten bricht er dort
 * um statt mitten im Wort („amazon-ads-mock@“ / „profitbash.test“). Notfalls bricht der Aufrufer im Wort
 * (`wrap-anywhere`).
 */
const props = defineProps<{ text: string }>();
const parts = computed(() => props.text.split(/(?<=[@/])/));
</script>

<template>
  <template v-for="(part, index) in parts" :key="index"
    ><wbr v-if="index > 0" />{{ part }}</template
  >
</template>
