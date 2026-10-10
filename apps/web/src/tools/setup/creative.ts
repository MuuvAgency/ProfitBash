import { SB_AD_TITLE_MAX_LENGTH, SB_BRAND_NAME_MAX_LENGTH } from '@profitbash/shared';
import type { SetupInputs } from './inputs';

/**
 * Werbemittel für Sponsored Brands im Assistenten (`docs/tasks/phase-4.md` 4.10): ein Satz je Entwurf (Marke,
 * optional Logo und Titel der Kollektion, Video). Die Asset-IDs kopiert man aus der Asset-Bibliothek der
 * Werbekonsole; die Marke kommt aus dem Blatt „Brand Assets Data“ des Bulk-Imports.
 */

export type SbCreativeInput = NonNullable<SetupInputs['creative']>;

export interface CreativeForm {
  /** Leer: keine Marke gewählt (Vendoren). */
  brandEntityId: string;
  brandName: string;
  logoAssetId: string;
  videoAssetId: string;
  adTitle: string;
}

export const emptyCreativeForm = (): CreativeForm => ({
  brandEntityId: '',
  brandName: '',
  logoAssetId: '',
  videoAssetId: '',
  adTitle: '',
});

const ASSET_ID = /^amzn1\.assetlibrary\.[A-Za-z0-9.:_-]{1,200}$/;
const optional = (value: string) => (value.trim() === '' ? null : value.trim());
const length = (value: string) => [...value.trim()].length;

/** Felder → Eingabe des Entwurfs; ein ganz leeres Formular heißt „keine Werbemittel“. */
export function formToCreative(form: CreativeForm): SbCreativeInput | null {
  if (Object.values(form).every((value) => value.trim() === '')) return null;
  return {
    brandEntityId: optional(form.brandEntityId),
    brandName: form.brandName.trim(),
    logoAssetId: optional(form.logoAssetId),
    videoAssetId: optional(form.videoAssetId),
    adTitle: optional(form.adTitle),
  };
}

export function creativeToForm(creative: SetupInputs['creative'] | undefined): CreativeForm {
  if (!creative) return emptyCreativeForm();
  return {
    brandEntityId: creative.brandEntityId ?? '',
    brandName: creative.brandName,
    logoAssetId: creative.logoAssetId ?? '',
    videoAssetId: creative.videoAssetId ?? '',
    adTitle: creative.adTitle ?? '',
  };
}

/** Felder, die so nicht gespeichert werden können (leer: alles gut oder gar nichts eingetragen). */
export function creativeFormIssues(form: CreativeForm): (keyof CreativeForm)[] {
  if (formToCreative(form) === null) return [];
  const issues: (keyof CreativeForm)[] = [];
  if (length(form.brandName) === 0 || length(form.brandName) > SB_BRAND_NAME_MAX_LENGTH) {
    issues.push('brandName');
  }
  for (const key of ['logoAssetId', 'videoAssetId'] as const) {
    const value = optional(form[key]);
    if (value !== null && !ASSET_ID.test(value)) issues.push(key);
  }
  if (length(form.adTitle) > SB_AD_TITLE_MAX_LENGTH) issues.push('adTitle');
  return issues;
}
