import { describe, expect, it } from 'vitest';
import { countryName, isoCountryCode } from './country';

describe('isoCountryCode', () => {
  it('übersetzt Amazons „UK“ in den ISO-Code GB', () => {
    expect(isoCountryCode('UK')).toBe('GB');
  });

  it('normalisiert auf Großbuchstaben und lässt ISO-Codes sonst unverändert', () => {
    expect(isoCountryCode('de')).toBe('DE');
    expect(isoCountryCode('SE')).toBe('SE');
  });

  it('liefert null für Werte, die kein Ländercode sind', () => {
    expect(isoCountryCode('')).toBeNull();
    expect(isoCountryCode('DEU')).toBeNull();
    expect(isoCountryCode('1A')).toBeNull();
  });
});

describe('countryName', () => {
  it('nennt das Land auf Deutsch', () => {
    expect(countryName('DE')).toBe('Deutschland');
    expect(countryName('UK')).toBe('Vereinigtes Königreich');
  });

  it('zeigt unbekannte Werte unverändert', () => {
    expect(countryName('DEU')).toBe('DEU');
  });
});
