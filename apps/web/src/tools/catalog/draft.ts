import type { StructureCatalog } from '@profitbash/shared';
import { inject, type ComputedRef, type InjectionKey, type Ref } from 'vue';

/**
 * Entwurf des Struktur-Katalogs (`phase-4.md` 4.2): die Seite hält ihn, die Reiter ändern ihn direkt. Gespeichert wird
 * erst mit „Katalog speichern“; geprüft wird mit `structureCatalogSchema` (die Meldungen kommen von dort).
 */
export interface CatalogDraftContext {
  draft: Ref<StructureCatalog>;
  /** Org-Admin mit `write` im Feature `tools` (F11). */
  canEdit: Ref<boolean>;
  /** Clients und Produktgruppen je Preset (gespeicherter Stand), für die Warnung beim Löschen. */
  usage: ComputedRef<Map<string, { clients: number; productGroups: number }>>;
}

export const CATALOG_DRAFT: InjectionKey<CatalogDraftContext> = Symbol('catalog-draft');

export function useCatalogDraft(): CatalogDraftContext {
  const context = inject(CATALOG_DRAFT);
  if (!context) throw new Error('useCatalogDraft außerhalb der Katalog-Seite');
  return context;
}

/** Eingabe eines Betrags: Komma wird Punkt, Leerraum fällt weg (geprüft wird beim Speichern). */
export const moneyInput = (value: string) => value.trim().replace(',', '.');

/** Eingabe einer ganzen Zahl; Leer = `undefined`, sonst die Zahl (ungültig bleibt `NaN` und fällt bei der Prüfung auf). */
export function integerInput(value: string): number | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : Number(trimmed);
}

export const inputClass =
  'h-11 min-w-0 rounded-control bg-well px-space-md text-body-md text-ink outline-none focus-visible:ring-2 focus-visible:ring-violet disabled:text-ink-secondary';
export const labelClass = 'text-label-eyebrow uppercase text-ink-tertiary';

/** Zahl für ein Eingabefeld: `NaN` (geleert oder ungültig) zeigt ein leeres Feld. */
export const numberText = (value: number | null | undefined) =>
  value === null || value === undefined || Number.isNaN(value) ? '' : String(value);
