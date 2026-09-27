import {
  formatDateTime,
  formatDuration,
  formatNumber,
  MISSING_VALUE,
  type JobRun,
} from '@profitbash/shared';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSessionStore } from '../stores/session';

/**
 * Reihenfolge der bekannten Zähler. Postgres (`jsonb`) liefert die Keys nach Länge sortiert, nicht in
 * der Reihenfolge, in der der Job sie geschrieben hat.
 */
const COUNTER_ORDER = [
  'refreshed',
  'profiles',
  // Amazon-Aufträge (1.7): anfordern, abholen, importieren.
  'requested',
  'reused',
  'imported',
  'superseded',
  'rows',
  'created',
  'updated',
  'placeholdersFilled',
  'placeholdersCreated',
  'reassigned',
  'removed',
  'removalDeferred',
  'backfillsCompleted',
  'exportsWaiting',
  'failed',
  'failedSinceLastRun',
  'profileErrors',
  // Anfragen an Amazon und Lease der Connection (1.3), nach den fachlichen Zählern.
  'requests',
  'throttled',
  'retries',
  'deferred',
];

/** Immer zeigen, auch bei 0 (ein Sync ohne Profile ist eine Aussage). Andere Zähler nur ungleich 0. */
const ALWAYS_SHOWN = new Set(['profiles']);

function counterRank(key: string) {
  const index = COUNTER_ORDER.indexOf(key);
  return index === -1 ? COUNTER_ORDER.length : index;
}

/** Texte einer Zeile des Sync-Status (Grid und Zellen nutzen dieselben). */
export function useJobRunLabels() {
  const { t, te } = useI18n();
  const session = useSessionStore();
  const locale = computed(() => session.preferences.locale);

  /** Neue Jobs erscheinen mit ihrem Namen. */
  function job(name: string) {
    const key = `sync.job.${name}`;
    return te(key) ? t(key) : name;
  }

  function connection(run: JobRun) {
    return (
      run.connection?.externalAccountEmail ?? run.connection?.externalAccountId ?? MISSING_VALUE
    );
  }

  function startedAt(run: JobRun) {
    return formatDateTime(run.startedAt, locale.value);
  }

  function duration(run: JobRun) {
    if (!run.finishedAt) return MISSING_VALUE;
    return formatDuration(Date.parse(run.finishedAt) - Date.parse(run.startedAt), locale.value);
  }

  /** Zähler als Zahl (formatiert) und Bezeichnung, z. B. `{ value: '4', label: 'Profile' }`. */
  function counterParts(run: JobRun) {
    return Object.entries(run.counters)
      .filter(([key, value]) => value !== 0 || ALWAYS_SHOWN.has(key))
      .sort(([a], [b]) => counterRank(a) - counterRank(b) || a.localeCompare(b))
      .map(([key, value]) => {
        const labelKey = `sync.counter.${key}`;
        return {
          key,
          value: formatNumber(value, locale.value),
          label: te(labelKey) ? t(labelKey, value) : key,
        };
      });
  }

  /** z. B. „4 Profile · 1 neu“. */
  function counters(run: JobRun) {
    return counterParts(run)
      .map(({ value, label }) => `${value} ${label}`)
      .join(' · ');
  }

  return { job, connection, startedAt, duration, counterParts, counters };
}
