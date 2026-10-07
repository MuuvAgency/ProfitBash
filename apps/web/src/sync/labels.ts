import {
  formatDateTime,
  formatDuration,
  formatNumber,
  MISSING_VALUE,
  SHARED_PLATFORM_JOB_NAMES,
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
  // Datei-Import (1.11c): Dateien, davon importiert (`imported`) bzw. nicht importiert.
  'files',
  // Amazon-Aufträge (1.7): anfordern, abholen, importieren.
  'requested',
  'reused',
  'imported',
  'filesFailed',
  'superseded',
  'rows',
  // Bulk-Datei (1.11d): Entities je Ebene, dann wie beim Entity-Sync neu/geändert.
  'portfolios',
  'campaigns',
  'adGroups',
  'targets',
  'negatives',
  'productAds',
  // Suchbegriff-Blätter der Bulk-Datei (2b.1): Summen je Download-Zeitraum.
  'searchTerms',
  'searchTermsWithoutPeriod',
  'invalidRows',
  'invalidSearchTermRows',
  // Wechselkurse (2.2): geladen, davon neu, geändert, unverändert.
  'fetched',
  'currencies',
  'inserted',
  'created',
  'updated',
  'unchanged',
  'placeholdersFilled',
  'placeholdersCreated',
  'reassigned',
  'removed',
  // Bulk-Import (1.11d): Kampagnen der Datei, von denen keine zum Profil passt (Hinweis).
  'unmatchedCampaigns',
  'removalDeferred',
  'backfillsCompleted',
  'exportsWaiting',
  'failed',
  'failedSinceLastRun',
  'profileErrors',
  'continued',
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

/**
 * Dauer in ms: abgeschlossen bis zum Ende, laufend bis jetzt. `null` für Läufe ohne Ende, die nicht
 * laufen (dürfte es nicht geben).
 */
export function elapsedMs(run: JobRun, now = Date.now()): number | null {
  if (run.finishedAt) return Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  // Geht die Uhr des Browsers etwas nach, wäre ein gerade gestarteter Lauf sonst negativ („–“).
  return run.status === 'running' ? Math.max(0, now - Date.parse(run.startedAt)) : null;
}

/** Plattformweiter Lauf, den jede Organisation sieht (bisher nur der Kursabruf der EZB). */
function isSharedPlatformJob(job: string) {
  return (SHARED_PLATFORM_JOB_NAMES as readonly string[]).includes(job);
}

/** Takt, in dem die Dauer laufender Jobs weiterzählt. */
export const RUNNING_DURATION_TICK_MS = 1_000;

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

  /** Spalte „Amazon-Konto“: Connection, bei Jobs je Profil das Profil, beim Kursabruf die Quelle. */
  function connection(run: JobRun) {
    if (isSharedPlatformJob(run.job)) return t('sync.ecbSource');
    if (run.profile) return `${run.profile.accountName} (${run.profile.countryCode})`;
    return (
      run.connection?.externalAccountEmail ?? run.connection?.externalAccountId ?? MISSING_VALUE
    );
  }

  function startedAt(run: JobRun) {
    return formatDateTime(run.startedAt, locale.value);
  }

  /**
   * Dauer abgeschlossener Läufe; laufende zeigen, wie lange sie schon laufen (hängende Jobs erkennen).
   * Ohne „seit“: Der Status daneben sagt „Läuft“, und die Spalte bleibt schmal.
   */
  function duration(run: JobRun, now = Date.now()) {
    return formatDuration(elapsedMs(run, now), locale.value);
  }

  /** Zähler als Zahl (formatiert) und Bezeichnung, z. B. `{ value: '4', label: 'Profile' }`. */
  function counterParts(run: Pick<JobRun, 'counters'>) {
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
  function counters(run: Pick<JobRun, 'counters'>) {
    return counterParts(run)
      .map(({ value, label }) => `${value} ${label}`)
      .join(' · ');
  }

  return { job, connection, startedAt, duration, counterParts, counters };
}
