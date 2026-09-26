<script setup lang="ts">
import { ref, watchEffect } from 'vue';
import { isoCountryCode } from './country';

const props = defineProps<{ countryCode: string }>();

/**
 * SVG-Flaggen aus `flag-icons` (MIT) statt Emoji-Flaggen: Emojis sind im Design ausgeschlossen
 * und fehlen unter Windows. Jede Flagge ist eine eigene Datei (`no-inline`) und wird erst geladen,
 * wenn sie angezeigt wird.
 */
const FLAG_DIR = '/node_modules/flag-icons/flags/4x3';
const FLAGS = import.meta.glob<string>('/node_modules/flag-icons/flags/4x3/*.svg', {
  query: '?no-inline',
  import: 'default',
});

const src = ref<string>();

watchEffect((onCleanup) => {
  let cancelled = false;
  onCleanup(() => (cancelled = true));
  const iso = isoCountryCode(props.countryCode);
  const load = iso ? FLAGS[`${FLAG_DIR}/${iso.toLowerCase()}.svg`] : undefined;
  src.value = undefined;
  // Fehlt die Datei (Netzwerkfehler), bleibt der neutrale Platzhalter stehen.
  load?.().then(
    (url) => {
      if (!cancelled) src.value = url;
    },
    () => {},
  );
});
</script>

<template>
  <!-- Dekorativ: Der Landesname steht daneben. -->
  <img
    v-if="src"
    :src="src"
    alt=""
    width="20"
    height="15"
    class="h-[15px] w-5 shrink-0 rounded-[2px] object-cover shadow-tile"
  />
  <span
    v-else
    class="inline-block h-[15px] w-5 shrink-0 rounded-[2px] bg-well"
    aria-hidden="true"
  />
</template>
