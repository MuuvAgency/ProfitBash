import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EcbError, ECB_RATES_URL, fetchEcbRates, parseEcbRatesCsv } from './rates';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const HEADER = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE';
const row = (currency: string, date: string, value: string) =>
  `EXR.D.${currency}.EUR.SP00.A,D,${currency},EUR,SP00,A,${date},${value}`;
/** Wie die EZB: CRLF, nach Währung und Datum sortiert. */
const csv = (...rows: string[]) => [HEADER, ...rows].join('\r\n') + '\r\n';

const noSleep = { sleep: async () => {} };

describe('fetchEcbRates', () => {
  it('fragt den Zeitraum als SDMX-CSV ab und liefert Kurse als Decimal-String', async () => {
    let requested: URL | undefined;
    server.use(
      http.get(ECB_RATES_URL, ({ request }) => {
        requested = new URL(request.url);
        return new HttpResponse(
          csv(
            row('GBP', '2026-09-25', '0.8712'),
            row('GBP', '2026-09-28', '0.85785'),
            row('USD', '2026-09-25', '1.1403'),
            row('USD', '2026-09-28', '1.1378'),
          ),
          { headers: { 'content-type': 'text/csv' } },
        );
      }),
    );

    const rates = await fetchEcbRates({ startDate: '2026-09-25', endDate: '2026-09-28' });

    expect(requested?.searchParams.get('startPeriod')).toBe('2026-09-25');
    expect(requested?.searchParams.get('endPeriod')).toBe('2026-09-28');
    expect(requested?.searchParams.get('format')).toBe('csvdata');
    expect(requested?.searchParams.get('detail')).toBe('dataonly');
    // Das Wochenende (26./27.) fehlt: Die EZB veröffentlicht nur an TARGET-Arbeitstagen.
    expect(rates).toEqual([
      { date: '2026-09-25', currency: 'GBP', rate: '0.8712' },
      { date: '2026-09-28', currency: 'GBP', rate: '0.85785' },
      { date: '2026-09-25', currency: 'USD', rate: '1.1403' },
      { date: '2026-09-28', currency: 'USD', rate: '1.1378' },
    ]);
  });

  it('ohne Enddatum fragt es bis zum letzten veröffentlichten Tag', async () => {
    let requested: URL | undefined;
    server.use(
      http.get(ECB_RATES_URL, ({ request }) => {
        requested = new URL(request.url);
        return new HttpResponse(csv(row('USD', '2026-09-28', '1.1378')));
      }),
    );
    await fetchEcbRates({ startDate: '2026-09-28' });
    expect(requested?.searchParams.has('endPeriod')).toBe(false);
  });

  it('leere Antwort (nur Feiertage oder Wochenende im Zeitraum) ergibt keine Kurse', async () => {
    server.use(http.get(ECB_RATES_URL, () => new HttpResponse('')));
    await expect(
      fetchEcbRates({ startDate: '2026-12-25', endDate: '2026-12-26' }),
    ).resolves.toEqual([]);
  });

  it('404 (SDMX „No results found“) ergibt keine Kurse', async () => {
    server.use(
      http.get(ECB_RATES_URL, () => new HttpResponse('No results found', { status: 404 })),
    );
    await expect(fetchEcbRates({ startDate: '2026-12-25' })).resolves.toEqual([]);
  });

  it('wiederholt bei 5xx und Netzwerkfehlern', async () => {
    let calls = 0;
    server.use(
      http.get(ECB_RATES_URL, () => {
        calls += 1;
        if (calls === 1) return new HttpResponse('busy', { status: 503 });
        if (calls === 2) return HttpResponse.error();
        return new HttpResponse(csv(row('USD', '2026-09-28', '1.1378')));
      }),
    );
    const rates = await fetchEcbRates({ startDate: '2026-09-28', ...noSleep });
    expect(calls).toBe(3);
    expect(rates).toHaveLength(1);
  });

  it('gibt nach der letzten Wiederholung mit Status auf', async () => {
    server.use(http.get(ECB_RATES_URL, () => new HttpResponse('busy', { status: 503 })));
    const error = await fetchEcbRates({ startDate: '2026-09-28', ...noSleep }).catch((e) => e);
    expect(error).toBeInstanceOf(EcbError);
    expect(error.message).toContain('503');
  });

  it('wiederholt 4xx nicht (außer 404)', async () => {
    let calls = 0;
    server.use(
      http.get(ECB_RATES_URL, () => {
        calls += 1;
        return new HttpResponse('bad', { status: 400 });
      }),
    );
    await expect(fetchEcbRates({ startDate: '2026-09-28', ...noSleep })).rejects.toThrow(EcbError);
    expect(calls).toBe(1);
  });
});

describe('parseEcbRatesCsv', () => {
  it('findet die Spalten über den Kopf, nicht über die Position', () => {
    const text = 'TIME_PERIOD,OBS_VALUE,CURRENCY_DENOM,CURRENCY\n2026-09-28,11.3205,EUR,SEK\n';
    expect(parseEcbRatesCsv(text)).toEqual([
      { date: '2026-09-28', currency: 'SEK', rate: '11.3205' },
    ]);
  });

  it('übernimmt ganze Zahlen und Kurse mit vielen Stellen exakt', () => {
    const text = csv(row('ISK', '2026-09-28', '137'), row('IDR', '2026-09-28', '20453.78'));
    expect(parseEcbRatesCsv(text).map((r) => r.rate)).toEqual(['137', '20453.78']);
  });

  it('überspringt Beobachtungen ohne Wert (leer oder NaN)', () => {
    const text = csv(row('USD', '2026-09-25', ''), row('USD', '2026-09-28', 'NaN'));
    expect(parseEcbRatesCsv(text)).toEqual([]);
  });

  it.each([
    ['negativer Kurs', row('USD', '2026-09-28', '-1.1')],
    ['Kurs 0', row('USD', '2026-09-28', '0')],
    ['Exponent', row('USD', '2026-09-28', '1e3')],
    ['Tausendertrennzeichen', row('USD', '2026-09-28', '1.137,8')],
    ['Datum', row('USD', '28.09.2026', '1.1378')],
    ['Währungscode', row('usd', '2026-09-28', '1.1378')],
    ['Basis nicht EUR', 'EXR.D.USD.GBP.SP00.A,D,USD,GBP,SP00,A,2026-09-28,1.3'],
  ])('lehnt ungültige Zeilen ab: %s', (_name, line) => {
    expect(() => parseEcbRatesCsv(csv(line))).toThrow(EcbError);
  });

  it('lehnt einen Kopf ohne die nötigen Spalten ab', () => {
    expect(() => parseEcbRatesCsv('KEY,VALUE\r\nx,1\r\n')).toThrow(/OBS_VALUE/);
  });

  it('lehnt doppelte Kurse für denselben Tag und dieselbe Währung ab', () => {
    const text = csv(row('USD', '2026-09-28', '1.1378'), row('USD', '2026-09-28', '1.2'));
    expect(() => parseEcbRatesCsv(text)).toThrow(/doppelt/);
  });

  it('nimmt keine Rohdaten der Antwort in die Fehlermeldung', () => {
    const secretish = 'x'.repeat(500);
    const error = (() => {
      try {
        parseEcbRatesCsv(csv(row('USD', '2026-09-28', secretish)));
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).not.toContain(secretish);
    expect(error?.message).toContain('Zeile 2');
  });
});
