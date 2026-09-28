import { z } from 'zod';

/**
 * Euro-Referenzkurse der EZB über die SDMX Data API (Datenfluss `EXR`, täglich, alle Währungen gegen
 * EUR, Referenzkurs `SP00.A`). Geprüft am 2026-09-28:
 * - Die EZB veröffentlicht an TARGET-Arbeitstagen gegen 16:00 MEZ (Konzertation gegen 14:10); an
 *   Wochenenden und TARGET-Feiertagen (Neujahr, Karfreitag, Ostermontag, 1. Mai, 25./26.12.) gibt es
 *   keine Beobachtung.
 * - `format=csvdata&detail=dataonly` liefert `KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,
 *   TIME_PERIOD,OBS_VALUE` mit CRLF; Werte ohne Tausendertrennzeichen, Nullen am Ende gekürzt
 *   (`178.5`, `137`).
 * - Ein Zeitraum ohne Beobachtung ergibt HTTP 200 mit leerem Body (SDMX erlaubt auch 404).
 * - Nicht mehr veröffentlichte Währungen (z. B. RUB seit 03/2022, BGN seit dem Euro-Beitritt 2026)
 *   fehlen ab dann.
 */
export const ECB_RATES_URL = 'https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A';

/** Ein Referenzkurs: 1 EUR = `rate` Einheiten von `currency` am Tag `date`. */
export interface EcbRate {
  /** Kalendertag der Veröffentlichung, `YYYY-MM-DD`. */
  date: string;
  /** ISO-4217-Code, z. B. `USD`. */
  currency: string;
  /** Decimal-String wie von der EZB geliefert, größer 0, ohne Exponent. */
  rate: string;
}

/** Abruf oder Antwort der EZB gescheitert. Meldungen enthalten keine Rohdaten der Antwort. */
export class EcbError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'EcbError';
  }
}

const isoDate = z.iso.date();

const rateRowSchema = z.object({
  date: isoDate,
  currency: z.string().regex(/^[A-Z]{3}$/),
  denominator: z.literal('EUR'),
  // Positiv, ohne Exponent und ohne Trennzeichen; 0 wäre als Divisor sinnlos.
  rate: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .refine((value) => /[1-9]/.test(value)),
});

const REQUIRED_COLUMNS = ['CURRENCY', 'CURRENCY_DENOM', 'TIME_PERIOD', 'OBS_VALUE'] as const;

/** Liest die CSV-Antwort (`csvdata`, `dataonly`). Beobachtungen ohne Wert (leer, `NaN`) fehlen. */
export function parseEcbRatesCsv(text: string): EcbRate[] {
  const lines = text.split(/\r?\n/).filter((line) => line !== '');
  const [header, ...rows] = lines;
  if (header === undefined) return [];

  const columns = header.split(',');
  const index = Object.fromEntries(
    REQUIRED_COLUMNS.map((name) => [name, columns.indexOf(name)]),
  ) as Record<(typeof REQUIRED_COLUMNS)[number], number>;
  const missing = REQUIRED_COLUMNS.filter((name) => index[name] < 0);
  if (missing.length > 0) {
    throw new EcbError(`EZB-Antwort ohne Spalte ${missing.join(', ')}.`);
  }

  const seen = new Set<string>();
  const rates: EcbRate[] = [];
  rows.forEach((line, i) => {
    const lineNo = i + 2;
    // `dataonly` enthält keine Felder mit Komma (Titel und Anmerkungen fehlen), daher kein Quoting.
    const cells = line.split(',');
    if (cells.length !== columns.length) {
      throw new EcbError(`EZB-Antwort ungültig in Zeile ${lineNo} (Anzahl der Spalten).`);
    }
    const value = cells[index.OBS_VALUE] ?? '';
    if (value === '' || value === 'NaN') return;
    const parsed = rateRowSchema.safeParse({
      date: cells[index.TIME_PERIOD],
      currency: cells[index.CURRENCY],
      denominator: cells[index.CURRENCY_DENOM],
      rate: value,
    });
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
      throw new EcbError(`EZB-Antwort ungültig in Zeile ${lineNo} (${fields.join(', ')}).`);
    }
    const { date, currency, rate } = parsed.data;
    const key = `${date}|${currency}`;
    if (seen.has(key)) {
      throw new EcbError(`EZB-Antwort enthält ${currency} am ${date} doppelt (Zeile ${lineNo}).`);
    }
    seen.add(key);
    rates.push({ date, currency, rate });
  });
  return rates;
}

export interface FetchEcbRatesOptions {
  /** Erster Tag, `YYYY-MM-DD`. */
  startDate: string;
  /** Letzter Tag, `YYYY-MM-DD`; ohne Angabe bis zur letzten Veröffentlichung. */
  endDate?: string;
  /** Standard: das globale `fetch` (zur Aufrufzeit gelesen, damit msw es abfangen kann). */
  fetch?: typeof fetch;
  /** Für Tests austauschbar. */
  sleep?: (ms: number) => Promise<void>;
  /** Timeout je Versuch. Standard 60 s (die Historie ab Jahresbeginn sind einige hundert KB). */
  timeoutMs?: number;
  /** Versuche insgesamt. Standard 3. */
  maxAttempts?: number;
}

const RETRY_BASE_DELAY_MS = 2_000;

/** Lädt die Referenzkurse aller Währungen für einen Zeitraum. Wiederholt bei 5xx und Netzwerkfehlern. */
export async function fetchEcbRates(options: FetchEcbRatesOptions): Promise<EcbRate[]> {
  isoDate.parse(options.startDate);
  if (options.endDate !== undefined) isoDate.parse(options.endDate);

  const url = new URL(ECB_RATES_URL);
  url.searchParams.set('startPeriod', options.startDate);
  if (options.endDate !== undefined) url.searchParams.set('endPeriod', options.endDate);
  url.searchParams.set('format', 'csvdata');
  url.searchParams.set('detail', 'dataonly');

  const maxAttempts = options.maxAttempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastError: EcbError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 2));
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(url, {
        headers: { accept: 'text/csv' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
    } catch (error) {
      lastError = new EcbError('EZB nicht erreichbar.', null, { cause: error });
      continue;
    }
    const text = await response.text();
    if (response.status === 404) return [];
    if (response.ok) return parseEcbRatesCsv(text);
    lastError = new EcbError(`EZB antwortet mit HTTP ${response.status}.`, response.status);
    if (response.status < 500) break;
  }
  throw lastError ?? new EcbError('EZB-Abruf ohne Versuch.');
}
