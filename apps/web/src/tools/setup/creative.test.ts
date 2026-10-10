import { describe, expect, it } from 'vitest';
import { creativeFormIssues, creativeToForm, emptyCreativeForm, formToCreative } from './creative';

/** Werbemittel für Sponsored Brands im Assistenten (`phase-4.md` 4.10): Felder ↔ Eingabe des Entwurfs. */

describe('Werbemittel für Sponsored Brands', () => {
  it('lässt leere Felder weg und macht aus einem leeren Formular keine Werbemittel', () => {
    expect(formToCreative(emptyCreativeForm())).toBeNull();
    expect(
      formToCreative({
        ...emptyCreativeForm(),
        brandEntityId: 'ENTITY1',
        brandName: '  Waldkauz ',
        videoAssetId: ' amzn1.assetlibrary.asset1.video:version_v1 ',
      }),
    ).toEqual({
      brandEntityId: 'ENTITY1',
      brandName: 'Waldkauz',
      logoAssetId: null,
      videoAssetId: 'amzn1.assetlibrary.asset1.video:version_v1',
      adTitle: null,
    });
  });

  it('liest gespeicherte Werbemittel zurück ins Formular', () => {
    const creative = {
      brandEntityId: null,
      brandName: 'Lumen',
      logoAssetId: 'amzn1.assetlibrary.asset1.logo',
      videoAssetId: null,
      adTitle: 'Licht für jeden Raum',
    };
    expect(formToCreative(creativeToForm(creative))).toEqual(creative);
    expect(creativeToForm(null)).toEqual(emptyCreativeForm());
  });

  it('meldet fehlende Marke, zu lange Texte und Asset-IDs in falscher Form', () => {
    expect(creativeFormIssues(emptyCreativeForm())).toEqual([]);
    expect(
      creativeFormIssues({
        brandEntityId: '',
        brandName: '',
        logoAssetId: 'logo.png',
        videoAssetId: '',
        adTitle: 'x'.repeat(33),
      }),
    ).toEqual(['brandName', 'logoAssetId', 'adTitle']);
    expect(creativeFormIssues({ ...emptyCreativeForm(), brandName: 'x'.repeat(31) })).toEqual([
      'brandName',
    ]);
  });
});
