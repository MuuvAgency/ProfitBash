import {
  formatCurrency,
  formatDateTime,
  formatNumber,
  formatPercent,
  type Locale,
} from '@profitbash/shared';

/** Fester Beispielzeitpunkt der Formatvorschau (in der Zeitzone des Browsers angezeigt). */
export const PREVIEW_DATE = '2026-09-26T08:15:03.000Z';

/** Beispiele der Formatvorschau: i18n-Key der Bezeichnung und der formatierte Wert. */
export function formatPreview(locale: Locale) {
  return [
    { key: 'number', value: formatNumber('1234567.89', locale) },
    { key: 'currencyEur', value: formatCurrency('1234.5', 'EUR', locale) },
    { key: 'currencyGbp', value: formatCurrency('1234.5', 'GBP', locale) },
    { key: 'percent', value: formatPercent('0.1234', locale) },
    { key: 'dateTime', value: formatDateTime(PREVIEW_DATE, locale) },
  ];
}
