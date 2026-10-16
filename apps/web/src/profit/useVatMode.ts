import { useMutation, useQuery } from '@tanstack/vue-query';
import { computed, ref, watch } from 'vue';
import { api } from '../api';

export type VatMode = 'net' | 'gross';

/**
 * Umsatz netto oder brutto (`phase-7.md` F6): persönliche Einstellung im UI-State des Nutzers, Standard netto. Gilt
 * für Umsatz und Erstattungen; Werbekosten, Gebühren und TACoS bleiben netto.
 */
export function useVatMode() {
  const mode = ref<VatMode>('net');
  const stored = useQuery({
    queryKey: ['ui-state', 'profit', 'vat'],
    queryFn: () => api.getUiState('profit', 'vat'),
    staleTime: Infinity,
  });
  watch(
    stored.data,
    (value) => {
      if (typeof value === 'object' && value !== null && 'mode' in value) {
        mode.value = value.mode === 'gross' ? 'gross' : 'net';
      }
    },
    { immediate: true },
  );
  // Fehler beim Speichern sind unkritisch (die Wahl gilt in dieser Sitzung trotzdem).
  const save = useMutation({
    mutationFn: (value: VatMode) => api.putUiState('profit', 'vat', { mode: value }),
  });
  return {
    mode: computed({
      get: () => mode.value,
      set: (value: VatMode) => {
        mode.value = value;
        save.mutate(value);
      },
    }),
  };
}
