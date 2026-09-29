import { describe, expect, it } from 'vitest';
import { AMAZON_MARKETPLACES, fileProfileCreateSchema, marketplaceFor } from './marketplaces';

describe('AMAZON_MARKETPLACES', () => {
  it('nennt je Land Währung, Zeitzone und Marktplatz-ID wie die Profile von Amazon', () => {
    expect(marketplaceFor('DE')).toEqual({
      countryCode: 'DE',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      marketplaceId: 'A1PA6795UKMFR9',
    });
    // Amazon schreibt Großbritannien als `UK`, nicht `GB`.
    expect(marketplaceFor('UK')?.currencyCode).toBe('GBP');
    expect(marketplaceFor('SE')?.timezone).toBe('Europe/Stockholm');
    expect(marketplaceFor('GB')).toBeUndefined();
  });

  it('hat jedes Land genau einmal und nur gültige Zeitzonen', () => {
    const codes = AMAZON_MARKETPLACES.map((m) => m.countryCode);
    expect(new Set(codes).size).toBe(codes.length);
    for (const m of AMAZON_MARKETPLACES) {
      expect(() => new Intl.DateTimeFormat('de-DE', { timeZone: m.timezone })).not.toThrow();
    }
  });
});

describe('fileProfileCreateSchema', () => {
  const valid = {
    accountName: '  Beispielmarke  ',
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    accountType: 'seller',
  };

  it('nimmt ein Profil ohne Connection an und kürzt den Namen', () => {
    expect(fileProfileCreateSchema.parse(valid)).toEqual({
      ...valid,
      accountName: 'Beispielmarke',
    });
  });

  it('lehnt unbekannte Länder, Zeitzonen, Kontotypen und leere Namen ab', () => {
    expect(fileProfileCreateSchema.safeParse({ ...valid, countryCode: 'XX' }).success).toBe(false);
    expect(fileProfileCreateSchema.safeParse({ ...valid, timezone: 'Mars/Olympus' }).success).toBe(
      false,
    );
    expect(fileProfileCreateSchema.safeParse({ ...valid, accountType: 'reseller' }).success).toBe(
      false,
    );
    expect(fileProfileCreateSchema.safeParse({ ...valid, accountName: '   ' }).success).toBe(false);
    expect(fileProfileCreateSchema.safeParse({ ...valid, currencyCode: 'eur' }).success).toBe(
      false,
    );
  });

  it('verlangt kanonische IANA-Zeitzonen (Postgres liest Offsets mit umgekehrtem Vorzeichen)', () => {
    for (const timezone of ['+01:00', 'EST', 'CET', 'europe/berlin', 'UTC+1']) {
      expect(fileProfileCreateSchema.safeParse({ ...valid, timezone }).success, timezone).toBe(
        false,
      );
    }
    expect(fileProfileCreateSchema.safeParse({ ...valid, timezone: 'Europe/London' }).success).toBe(
      true,
    );
  });

  it('verlangt die Währung des Marktplatzes (Amazon legt sie je Marktplatz fest)', () => {
    expect(fileProfileCreateSchema.safeParse({ ...valid, currencyCode: 'USD' }).success).toBe(
      false,
    );
    expect(
      fileProfileCreateSchema.safeParse({ ...valid, countryCode: 'SE', currencyCode: 'SEK' })
        .success,
    ).toBe(true);
  });

  it('lässt keine weiteren Felder zu (etwa eine Connection)', () => {
    expect(
      fileProfileCreateSchema.safeParse({ ...valid, connectionId: crypto.randomUUID() }).success,
    ).toBe(false);
  });
});
