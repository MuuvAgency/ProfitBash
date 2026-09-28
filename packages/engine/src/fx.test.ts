import { describe, expect, it } from 'vitest';
import { convertAmount } from './fx';

/** Kurse eines Tages: 1 EUR = x Einheiten (EZB, 28.09.2026). */
const rates = new Map([
  ['EUR', '1'],
  ['USD', '1.1378'],
  ['GBP', '0.85785'],
  ['SEK', '11.3205'],
]);

describe('convertAmount', () => {
  it('gleiche Währung bleibt unverändert, auch ohne Kurs', () => {
    expect(convertAmount('12.50', 'PLN', 'PLN', new Map())).toBe('12.50');
  });

  it('EUR in eine andere Währung: Betrag × Kurs', () => {
    expect(convertAmount('100', 'EUR', 'USD', rates)).toBe('113.78');
  });

  it('andere Währung in EUR: Betrag ÷ Kurs', () => {
    expect(convertAmount('85.785', 'GBP', 'EUR', rates)).toBe('100');
  });

  it('zwischen zwei Nicht-EUR-Währungen über EUR mit den Kursen desselben Tages', () => {
    // 113.205 SEK = 10 EUR = 8.5785 GBP
    expect(convertAmount('113.205', 'SEK', 'GBP', rates)).toBe('8.5785');
  });

  it('rechnet mit 34 Stellen und rundet nicht auf Cent', () => {
    // 1 GBP = 1 / 0.85785 EUR (bc: 1.16570496007460511744477472751646558…)
    expect(convertAmount('1', 'GBP', 'EUR', rates)).toBe('1.165704960074605117444774727516466');
  });

  it('negative Beträge (Korrekturen) werden umgerechnet', () => {
    expect(convertAmount('-100', 'EUR', 'USD', rates)).toBe('-113.78');
  });

  it('fehlt ein Kurs, ist das Ergebnis null statt einer falschen Zahl', () => {
    expect(convertAmount('10', 'PLN', 'EUR', rates)).toBeNull();
    expect(convertAmount('10', 'EUR', 'PLN', rates)).toBeNull();
    expect(convertAmount('10', 'PLN', 'USD', rates)).toBeNull();
  });

  it('EUR braucht keinen Eintrag in den Kursen', () => {
    expect(convertAmount('10', 'EUR', 'USD', new Map([['USD', '1.1378']]))).toBe('11.378');
  });

  it('ein Kurs von 0 oder darunter ist ein Programmfehler', () => {
    expect(() => convertAmount('10', 'USD', 'EUR', new Map([['USD', '0']]))).toThrow(RangeError);
  });
});
