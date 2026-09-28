import { latestFxRateDate, upsertFxRates, type Db } from '@profitbash/db';
import { fetchEcbRates, type EcbRate, type FetchEcbRatesOptions } from '@profitbash/ecb';
import type { JobOutcome } from '../run-job';

/**
 * Beginn der Historie beim ersten Lauf (fest, 2.2): Der Job liest nicht über Organisationen hinweg,
 * welche Tage gebraucht werden. Mock-Daten und der erste echte Sync liegen danach.
 */
export const FX_RATES_START_DATE = '2026-01-01';
/** So viele Tage vor dem letzten gespeicherten Kurs lädt jeder Lauf erneut (Korrekturen der EZB). */
export const FX_RATES_OVERLAP_DAYS = 7;

export interface FxRatesSyncDeps {
  db: Db;
  /** Standard: `fetchEcbRates` (Tests setzen msw davor). */
  fetchRates?: (options: FetchEcbRatesOptions) => Promise<EcbRate[]>;
}

function minusDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

/**
 * `fx-rates-sync` (plattformweit): lädt die EZB-Referenzkurse aller Währungen ab dem letzten
 * gespeicherten Tag minus Überlappung (beim ersten Lauf ab `FX_RATES_START_DATE`) bis zur letzten
 * Veröffentlichung und speichert sie per Upsert in einer Transaktion (kein Teilstand bei Fehlern).
 * Fehlende Tage nach einem Ausfall holt der nächste Lauf nach.
 */
export async function syncFxRates(deps: FxRatesSyncDeps): Promise<JobOutcome> {
  const latest = await latestFxRateDate(deps.db);
  const overlapStart =
    latest === null ? FX_RATES_START_DATE : minusDays(latest, FX_RATES_OVERLAP_DAYS);
  const startDate = overlapStart < FX_RATES_START_DATE ? FX_RATES_START_DATE : overlapStart;

  const rates = await (deps.fetchRates ?? fetchEcbRates)({ startDate });
  const result = await deps.db.transaction((tx) =>
    upsertFxRates(
      tx,
      rates.map(({ date, currency, rate }) => ({ date, quote: currency, rate })),
    ),
  );
  return {
    counters: {
      fetched: rates.length,
      ...result,
      currencies: new Set(rates.map((rate) => rate.currency)).size,
    },
  };
}
