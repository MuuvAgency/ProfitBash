import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fxRatesOnOrBefore, latestFxRateDate, upsertFxRates } from './fx-rates';
import { fxRates } from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb?.close();
});
beforeEach(async () => {
  await testDb.db.delete(fxRates);
});

const rows = () =>
  testDb.db
    .select({ date: fxRates.date, quote: fxRates.quote, rate: fxRates.rate, base: fxRates.base })
    .from(fxRates)
    .orderBy(asc(fxRates.quote), asc(fxRates.date));

describe('upsertFxRates', () => {
  it('speichert Kurse mit Basis EUR und zählt neue Zeilen', async () => {
    const result = await upsertFxRates(testDb.db, [
      { date: '2026-09-25', quote: 'USD', rate: '1.1403' },
      { date: '2026-09-25', quote: 'GBP', rate: '0.8712' },
    ]);
    expect(result).toEqual({ inserted: 2, updated: 0, unchanged: 0 });
    expect(await rows()).toEqual([
      { date: '2026-09-25', quote: 'GBP', rate: '0.8712', base: 'EUR' },
      { date: '2026-09-25', quote: 'USD', rate: '1.1403', base: 'EUR' },
    ]);
  });

  it('Wiederholung legt keine Duplikate an; Korrekturen der EZB überschreiben', async () => {
    const first = [
      { date: '2026-09-25', quote: 'USD', rate: '1.1403' },
      { date: '2026-09-28', quote: 'USD', rate: '1.1378' },
    ];
    await upsertFxRates(testDb.db, first);
    const again = await upsertFxRates(testDb.db, [
      ...first.slice(0, 1),
      { date: '2026-09-28', quote: 'USD', rate: '1.1379' },
    ]);
    expect(again).toEqual({ inserted: 0, updated: 1, unchanged: 1 });
    expect((await rows()).map((r) => [r.date, r.rate])).toEqual([
      ['2026-09-25', '1.1403'],
      ['2026-09-28', '1.1379'],
    ]);
  });

  it('gleicher Wert in anderer Schreibweise gilt als unverändert', async () => {
    await upsertFxRates(testDb.db, [{ date: '2026-09-28', quote: 'JPY', rate: '178.50' }]);
    const again = await upsertFxRates(testDb.db, [
      { date: '2026-09-28', quote: 'JPY', rate: '178.5' },
    ]);
    expect(again).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
  });

  it('leere Liste schreibt nichts', async () => {
    await expect(upsertFxRates(testDb.db, [])).resolves.toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
    });
  });

  it('schreibt große Mengen in Teilen (Historie ab Jahresbeginn)', async () => {
    const many = Array.from({ length: 12_000 }, (_, i) => ({
      date: new Date(Date.UTC(2000, 0, 1 + (i % 4000))).toISOString().slice(0, 10),
      quote: ['USD', 'GBP', 'SEK'][Math.floor(i / 4000)]!,
      rate: '1.5',
    }));
    await expect(upsertFxRates(testDb.db, many)).resolves.toMatchObject({ inserted: 12_000 });
  });

  it.each([
    ['EUR als Kurswährung', { date: '2026-09-28', quote: 'EUR', rate: '1' }],
    ['Kurs 0', { date: '2026-09-28', quote: 'USD', rate: '0' }],
    ['kleingeschrieben', { date: '2026-09-28', quote: 'usd', rate: '1.1' }],
  ])('die Datenbank lehnt ungültige Kurse ab: %s', async (_name, rate) => {
    await expect(upsertFxRates(testDb.db, [rate])).rejects.toThrow();
  });
});

describe('latestFxRateDate', () => {
  it('liefert den letzten gespeicherten Tag oder null', async () => {
    expect(await latestFxRateDate(testDb.db)).toBeNull();
    await upsertFxRates(testDb.db, [
      { date: '2026-09-25', quote: 'USD', rate: '1.1403' },
      { date: '2026-09-28', quote: 'GBP', rate: '0.85785' },
    ]);
    expect(await latestFxRateDate(testDb.db)).toBe('2026-09-28');
  });
});

describe('fxRatesOnOrBefore', () => {
  beforeEach(async () => {
    await upsertFxRates(testDb.db, [
      // Karfreitag (03.04.) und Ostermontag (06.04.) 2026: TARGET geschlossen, kein Kurs.
      { date: '2026-04-02', quote: 'USD', rate: '1.1525' },
      { date: '2026-04-07', quote: 'USD', rate: '1.1557' },
      { date: '2026-04-02', quote: 'GBP', rate: '0.87253' },
      { date: '2026-04-07', quote: 'GBP', rate: '0.87258' },
      // Freitag und Montag um ein Wochenende.
      { date: '2026-09-25', quote: 'USD', rate: '1.1403' },
      { date: '2026-09-28', quote: 'USD', rate: '1.1378' },
    ]);
  });

  it('Veröffentlichungstag: der Kurs dieses Tages', async () => {
    const rates = await fxRatesOnOrBefore(testDb.db, '2026-09-28', ['USD']);
    expect(rates.get('USD')).toEqual({ date: '2026-09-28', rate: '1.1378' });
  });

  it('Wochenende: der Kurs vom Freitag', async () => {
    const rates = await fxRatesOnOrBefore(testDb.db, '2026-09-27', ['USD']);
    expect(rates.get('USD')).toEqual({ date: '2026-09-25', rate: '1.1403' });
  });

  it('Feiertage (Ostern): der letzte Kurs davor, für jede Währung', async () => {
    const rates = await fxRatesOnOrBefore(testDb.db, '2026-04-06', ['USD', 'GBP']);
    expect(rates.get('USD')).toEqual({ date: '2026-04-02', rate: '1.1525' });
    expect(rates.get('GBP')).toEqual({ date: '2026-04-02', rate: '0.87253' });
  });

  it('fehlende Währung und Tage vor dem ersten Kurs fehlen in der Antwort (nie 1 oder 0)', async () => {
    const rates = await fxRatesOnOrBefore(testDb.db, '2026-09-28', ['USD', 'PLN']);
    expect(rates.has('PLN')).toBe(false);
    const early = await fxRatesOnOrBefore(testDb.db, '2026-04-01', ['USD']);
    expect(early.size).toBe(0);
  });

  it('EUR hat immer den Kurs 1 (Basis)', async () => {
    const rates = await fxRatesOnOrBefore(testDb.db, '2026-09-28', ['EUR']);
    expect(rates.get('EUR')).toEqual({ date: '2026-09-28', rate: '1' });
  });

  it('ohne Währungen keine Abfrage und keine Kurse', async () => {
    expect((await fxRatesOnOrBefore(testDb.db, '2026-09-28', [])).size).toBe(0);
  });
});
