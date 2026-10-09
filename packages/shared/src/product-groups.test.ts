import { describe, expect, it } from 'vitest';
import {
  createProductGroupRequestSchema,
  MAX_PRODUCT_GROUP_ITEMS,
  MAX_PRODUCT_GROUP_NAME_LENGTH,
  MAX_SKU_LENGTH,
  updateProductGroupRequestSchema,
} from './product-groups';

const profileId = '0b6f0c8e-6a40-4a8b-9a43-3f2f9c1d2e10';
const item = (asin: string, sku: string | null = null, isHero = false) => ({ asin, sku, isHero });

describe('createProductGroupRequestSchema', () => {
  it('normalisiert Name, ASIN und SKU', () => {
    const parsed = createProductGroupRequestSchema.parse({
      profileId,
      name: '  Trinkflaschen   Edelstahl ',
      items: [
        { asin: ' b0abc12345 ', sku: '  FL-750-blau ', isHero: true },
        { asin: 'B0ABC12346' },
      ],
    });
    expect(parsed.name).toBe('Trinkflaschen Edelstahl');
    expect(parsed.items).toEqual([
      { asin: 'B0ABC12345', sku: 'FL-750-blau', isHero: true },
      { asin: 'B0ABC12346', sku: null, isHero: false },
    ]);
  });

  it('macht aus einer leeren SKU „keine SKU“', () => {
    const parsed = createProductGroupRequestSchema.parse({
      profileId,
      name: 'Gruppe',
      items: [{ asin: 'B0ABC12345', sku: '   ' }],
    });
    expect(parsed.items[0]!.sku).toBeNull();
  });

  it('lehnt ungültige ASINs, zu lange SKUs und Namen ab', () => {
    const base = { profileId, name: 'Gruppe', items: [item('B0ABC12345')] };
    expect(
      createProductGroupRequestSchema.safeParse({ ...base, items: [item('B0ABC')] }).success,
    ).toBe(false);
    expect(
      createProductGroupRequestSchema.safeParse({ ...base, items: [item('B0ABC1234-')] }).success,
    ).toBe(false);
    expect(
      createProductGroupRequestSchema.safeParse({
        ...base,
        items: [item('B0ABC12345', 'x'.repeat(MAX_SKU_LENGTH + 1))],
      }).success,
    ).toBe(false);
    expect(
      createProductGroupRequestSchema.safeParse({
        ...base,
        name: 'x'.repeat(MAX_PRODUCT_GROUP_NAME_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(createProductGroupRequestSchema.safeParse({ ...base, name: '   ' }).success).toBe(false);
  });

  it('verlangt mindestens ein Produkt und höchstens die Höchstzahl', () => {
    expect(
      createProductGroupRequestSchema.safeParse({ profileId, name: 'Gruppe', items: [] }).success,
    ).toBe(false);
    const many = Array.from({ length: MAX_PRODUCT_GROUP_ITEMS + 1 }, (_, i) =>
      item(`B0${String(i).padStart(8, '0')}`),
    );
    expect(
      createProductGroupRequestSchema.safeParse({ profileId, name: 'Gruppe', items: many }).success,
    ).toBe(false);
  });

  it('erlaubt höchstens einen Hero', () => {
    const result = createProductGroupRequestSchema.safeParse({
      profileId,
      name: 'Gruppe',
      items: [item('B0ABC12345', null, true), item('B0ABC12346', null, true)],
    });
    expect(result.success).toBe(false);
  });

  it('lehnt doppelte Produkte ab (gleiche ASIN und SKU, auch nach dem Normalisieren)', () => {
    const duplicate = createProductGroupRequestSchema.safeParse({
      profileId,
      name: 'Gruppe',
      items: [item('B0ABC12345', 'SKU-1'), item('b0abc12345', ' SKU-1 ')],
    });
    expect(duplicate.success).toBe(false);
    // Dieselbe ASIN mit zwei SKUs ist erlaubt (zwei Angebote eines Händlers).
    const twoSkus = createProductGroupRequestSchema.safeParse({
      profileId,
      name: 'Gruppe',
      items: [item('B0ABC12345', 'SKU-1'), item('B0ABC12345', 'SKU-2')],
    });
    expect(twoSkus.success).toBe(true);
  });
});

describe('updateProductGroupRequestSchema', () => {
  it('verlangt Name oder Produkte', () => {
    expect(updateProductGroupRequestSchema.safeParse({}).success).toBe(false);
    expect(updateProductGroupRequestSchema.parse({ name: ' Neu ' })).toEqual({ name: 'Neu' });
    expect(
      updateProductGroupRequestSchema.parse({ items: [item('B0ABC12345', null, true)] }),
    ).toEqual({ items: [{ asin: 'B0ABC12345', sku: null, isHero: true }] });
  });

  it('nimmt keine Profil-ID an (eine Gruppe wechselt den Marktplatz nicht)', () => {
    expect(updateProductGroupRequestSchema.safeParse({ profileId, name: 'Neu' }).success).toBe(
      false,
    );
  });
});
