import { ref } from 'vue';

/**
 * Eingabe und Suche des ASIN-Tools über das Schließen des Popovers hinweg (PrimeVue baut dessen Inhalt jedes Mal neu
 * auf); gilt für die Sitzung im Tab.
 */
export const asinToolInput = ref('');
export const asinToolTerms = ref<string[]>([]);

export function resetAsinTool() {
  asinToolInput.value = '';
  asinToolTerms.value = [];
}
