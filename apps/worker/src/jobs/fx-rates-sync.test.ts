import { ECB_RATES_URL, fetchEcbRates } from '@profitbash/ecb';
import { schema, upsertFxRates } from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import { asc } from 'drizzle-orm';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FX_RATES_OVERLAP_DAYS, FX_RATES_START_DATE, syncFxRates } from './fx-rates-sync';

const { fxRates } = schema;

const server = setupServer();
let testDb: TestDatabase;

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  testDb = await createTestDatabase();
});
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await testDb.close();
});
beforeEach(async () => {
  await testDb.db.delete(fxRates);
});

const HEADER = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE';
const row = (currency: string, date: string, value: string) =>
  `EXR.D.${currency}.EUR.SP00.A,D,${currency},EUR,SP00,A,${date},${value}`;
const csv = (...rows: string[]) => [HEADER, ...rows].join('\r\n') + '\r\n';

/** EZB-Endpunkt mit festen Zeilen; merkt sich die angefragten Zeiträume. */
function ecb(...rows: string[]) {
  const requested: Array<{ start: string | null; end: string | null }> = [];
  server.use(
    http.get(ECB_RATES_URL, ({ request }) => {
      const url = new URL(request.url);
      requested.push({
        start: url.searchParams.get('startPeriod'),
        end: url.searchParams.get('endPeriod'),
      });
      return new HttpResponse(csv(...rows));
    }),
  );
  return requested;
}

const deps = () => ({
  db: testDb.db,
  fetchRates: (options: Parameters<typeof fetchEcbRates>[0]) =>
    fetchEcbRates({ ...options, sleep: async () => {} }),
});

const stored = () =>
  testDb.db
    .select({ date: fxRates.date, quote: fxRates.quote, rate: fxRates.rate })
    .from(fxRates)
    .orderBy(asc(fxRates.quote), asc(fxRates.date));

describe('syncFxRates', () => {
  it('erster Lauf lädt die Historie ab dem festen Startdatum, alle Währungen', async () => {
    const requested = ecb(
      row('GBP', '2026-01-02', '0.8716'),
      row('PLN', '2026-01-02', '4.2155'),
      row('USD', '2026-01-02', '1.0375'),
    );

    const outcome = await syncFxRates(deps());

    expect(FX_RATES_START_DATE).toBe('2026-01-01');
    expect(requested).toEqual([{ start: '2026-01-01', end: null }]);
    expect(outcome.counters).toEqual({
      fetched: 3,
      inserted: 3,
      updated: 0,
      unchanged: 0,
      currencies: 3,
    });
    expect((await stored()).map((r) => r.quote)).toEqual(['GBP', 'PLN', 'USD']);
  });

  it('danach ab dem letzten gespeicherten Tag minus Überlappung (Korrekturen der EZB)', async () => {
    await upsertFxRates(testDb.db, [{ date: '2026-09-25', quote: 'USD', rate: '1.1403' }]);
    const requested = ecb(row('USD', '2026-09-25', '1.1403'), row('USD', '2026-09-28', '1.1378'));

    const outcome = await syncFxRates(deps());

    expect(FX_RATES_OVERLAP_DAYS).toBe(7);
    expect(requested).toEqual([{ start: '2026-09-18', end: null }]);
    expect(outcome.counters).toMatchObject({ fetched: 2, inserted: 1, unchanged: 1 });
  });

  it('Wiederholung desselben Laufs legt keine Duplikate an', async () => {
    ecb(row('USD', '2026-09-25', '1.1403'), row('USD', '2026-09-28', '1.1378'));
    await syncFxRates(deps());
    const again = await syncFxRates(deps());

    expect(again.counters).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
    expect(await stored()).toHaveLength(2);
  });

  it('Wochenende und Feiertag ohne neue Kurse: Erfolg ohne neue Zeilen', async () => {
    await upsertFxRates(testDb.db, [{ date: '2026-12-24', quote: 'USD', rate: '1.05' }]);
    ecb(row('USD', '2026-12-24', '1.05'));

    // Lauf am 27.12. (Sonntag): 25./26.12. sind TARGET-Feiertage, der 24.12. ist der letzte Kurs.
    const outcome = await syncFxRates(deps());

    expect(outcome.counters).toMatchObject({ fetched: 1, inserted: 0, unchanged: 1 });
  });

  it('Startdatum liegt nie vor dem festen Beginn', async () => {
    await upsertFxRates(testDb.db, [{ date: '2026-01-05', quote: 'USD', rate: '1.04' }]);
    const requested = ecb();
    await syncFxRates(deps());
    expect(requested).toEqual([{ start: '2026-01-01', end: null }]);
  });

  it('eine Währung, die die EZB nicht mehr veröffentlicht, behält ihre alten Kurse', async () => {
    await upsertFxRates(testDb.db, [
      { date: '2026-09-25', quote: 'BGN', rate: '1.95583' },
      { date: '2026-09-25', quote: 'USD', rate: '1.1403' },
    ]);
    ecb(row('USD', '2026-09-28', '1.1378'));
    await syncFxRates(deps());
    expect((await stored()).map((r) => `${r.quote} ${r.date}`)).toEqual([
      'BGN 2026-09-25',
      'USD 2026-09-25',
      'USD 2026-09-28',
    ]);
  });

  it('Fehler der EZB lassen den Lauf scheitern, ohne etwas zu schreiben', async () => {
    server.use(http.get(ECB_RATES_URL, () => new HttpResponse('busy', { status: 503 })));
    await expect(syncFxRates(deps())).rejects.toThrow(/503/);
    expect(await stored()).toEqual([]);
  });

  it('eine ungültige Antwort schreibt keine Teilmenge', async () => {
    ecb(row('USD', '2026-09-25', '1.1403'), row('GBP', '2026-09-25', '-1'));
    await expect(syncFxRates(deps())).rejects.toThrow(/Zeile 3/);
    expect(await stored()).toEqual([]);
  });
});
