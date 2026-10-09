import type { PlanSetupInput } from '../../api/client';

/**
 * Eingaben des Setup-Assistenten (`phase-4.md` 4.5) als Textfelder (je Zeile ein Eintrag) und zurück. Leere Zeilen
 * fallen weg; Dubletten führt die Plan-Engine zusammen.
 */

export type SetupInputs = PlanSetupInput['inputs'];

export interface SetupTexts {
  keywords: string;
  single: string;
  brandTerms: string;
  productTargets: string;
  singleProducts: string;
  categories: string;
}

export const emptyTexts = (): SetupTexts => ({
  keywords: '',
  single: '',
  brandTerms: '',
  productTargets: '',
  singleProducts: '',
  categories: '',
});

const lines = (text: string) =>
  text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

export function textsToInputs(texts: SetupTexts, unlocks: SetupInputs['unlocks']): SetupInputs {
  return {
    keywords: [
      ...lines(texts.keywords).map((text) => ({ text })),
      ...lines(texts.single).map((text) => ({ text, single: true })),
    ],
    brandTerms: lines(texts.brandTerms),
    productTargets: [
      ...lines(texts.productTargets).map((asin) => ({ asin: asin.toUpperCase() })),
      ...lines(texts.singleProducts).map((asin) => ({ asin: asin.toUpperCase(), single: true })),
    ],
    categories: lines(texts.categories).flatMap((line) => {
      const [id = '', ...name] = line.split(';');
      return /^\d+$/.test(id.trim()) ? [{ id: id.trim(), name: name.join(';').trim() }] : [];
    }),
    unlocks,
  };
}

export function inputsToTexts(inputs: SetupInputs): SetupTexts {
  const join = (values: readonly string[]) => values.join('\n');
  return {
    keywords: join((inputs.keywords ?? []).filter((k) => !k.single).map((k) => k.text)),
    single: join((inputs.keywords ?? []).filter((k) => k.single).map((k) => k.text)),
    brandTerms: join(inputs.brandTerms ?? []),
    productTargets: join((inputs.productTargets ?? []).filter((p) => !p.single).map((p) => p.asin)),
    singleProducts: join((inputs.productTargets ?? []).filter((p) => p.single).map((p) => p.asin)),
    categories: join((inputs.categories ?? []).map((c) => `${c.id};${c.name}`)),
  };
}
