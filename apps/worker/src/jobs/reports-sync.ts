import {
  MAX_REPORT_DAYS,
  REPORT_DEFINITIONS,
  reportTypesFor,
  type AmazonAdsReportType,
} from '@profitbash/amazon-ads';
import {
  completeBackfill,
  countFailedAmazonRequestsSince,
  ensureBackfill,
  findPreviousJobRun,
  listReportRanges,
  OPEN_AMAZON_REQUEST_STATUSES,
  type JobProfile,
} from '@profitbash/db';
import {
  addDays,
  splitDateRange,
  subtractDateRanges,
  todayIn,
  type DateRange,
} from '../amazon-requests/date-ranges';
import { submitAmazonRequest } from '../amazon-requests/state-machine';
import { JobFailure, type JobCounters, type JobOutcome } from '../run-job';
import {
  addCounters,
  createAmazonJobContext,
  forEachProfileWithinBudget,
  type AmazonJobContext,
} from './amazon-context';
import { schedulePoll } from './amazon-requests-poll';
import {
  handleAmazonError,
  loadConnection,
  type ConnectionJobData,
  type ConnectionJobDeps,
  type ConnectionJobRun,
  type LoadedConnection,
} from './connection-job';

/** Ad-Typen der Reports (F2: SP zuerst; SB und SD folgen mit 1.9). */
export const REPORT_AD_PRODUCTS = ['SPONSORED_PRODUCTS'] as const;
/** Tage, die der tägliche Import neu lädt (F3), bis einschließlich gestern (F9). */
export const ROLLING_WINDOW_DAYS = 30;
/**
 * Abstand zur Aufbewahrungsgrenze von Amazon (F4): Ein Report, der einen gerade verfallenden Tag enthält,
 * könnte abgelehnt werden (4xx → `failed`).
 */
export const RETENTION_MARGIN_DAYS = 1;

/**
 * `reports-sync` je Connection (1.7): je nicht entferntem Profil (auch ausgeblendete, F14), Ad-Typ und
 * Report-Typ das rollierende Fenster anfordern und die Historie (F4) nachladen, bis ihr Merker
 * (`amazon_ads_backfills`) abgeschlossen ist. Importiert wird im Poll. „Gestern“ gilt in der Zeitzone
 * des Profils.
 *
 * Zähler `failedSinceLastRun`: Aufträge der Connection, die seit dem Ende des letzten Laufs gescheitert
 * sind (meist im Poll, der keinen Healthcheck pingt).
 */
export async function syncConnectionReports(
  deps: ConnectionJobDeps,
  job: ConnectionJobData,
  run: ConnectionJobRun,
): Promise<JobOutcome> {
  const connection = await loadConnection(deps.db, job);
  const context = await createAmazonJobContext(deps, connection, run);
  const profiles = context.profiles.filter((profile) => profile.removedAt === null);
  const counters: JobCounters = {
    profiles: profiles.length,
    requested: 0,
    reused: 0,
    failed: 0,
    backfillsCompleted: 0,
    failedSinceLastRun: await failedSinceLastRun(deps, connection, run),
    profileErrors: 0,
  };

  try {
    await forEachProfileWithinBudget({
      deps,
      queue: 'reports-sync',
      job,
      profiles,
      now: context.now,
      counters,
      handle: (profile) => syncProfile(deps, connection, run, context, profile, counters),
    });
  } catch (err) {
    return handleAmazonError(deps, 'reports-sync', job, connection, err);
  }

  await schedulePoll(deps, job, context.now());
  if (counters.profileErrors) {
    throw new JobFailure(
      `Report-Anforderung für ${counters.profileErrors} von ${counters.profiles} Profilen fehlgeschlagen.`,
      counters,
    );
  }
  return { counters };
}

async function failedSinceLastRun(
  deps: ConnectionJobDeps,
  connection: LoadedConnection,
  run: ConnectionJobRun,
): Promise<number> {
  const previous = await findPreviousJobRun(deps.db, {
    organizationId: connection.organizationId,
    job: 'reports-sync',
    scope: connection.id,
    excludeRunId: run.runId,
  });
  // Ohne vorigen Lauf zählen alle noch vorhandenen gescheiterten Aufträge (höchstens 30 Tage, F5).
  const since = previous ? (previous.finishedAt ?? previous.startedAt) : new Date(0);
  return countFailedAmazonRequestsSince(deps.db, {
    organizationId: connection.organizationId,
    connectionId: connection.id,
    since,
  });
}

async function syncProfile(
  deps: ConnectionJobDeps,
  connection: LoadedConnection,
  run: ConnectionJobRun,
  context: AmazonJobContext,
  profile: JobProfile,
  counters: JobCounters,
): Promise<void> {
  const today = todayIn(profile.timezone, context.now());
  const yesterday = addDays(today, -1);
  const window: DateRange = {
    startDate: addDays(yesterday, -(ROLLING_WINDOW_DAYS - 1)),
    endDate: yesterday,
  };

  for (const adProduct of REPORT_AD_PRODUCTS) {
    for (const reportType of reportTypesFor(adProduct)) {
      const key = {
        organizationId: connection.organizationId,
        profileId: profile.id,
        adProduct,
        reportType,
      };
      const submit = async (range: DateRange) => {
        await run.extendLease();
        const result = await submitAmazonRequest(context.machine, {
          ...key,
          kind: 'report',
          ...range,
        });
        addCounters(counters, result.counters);
      };

      await submit(window);
      for (const range of await missingHistory(deps, key, reportType, today, window)) {
        for (const chunk of splitDateRange(range, MAX_REPORT_DAYS)) await submit(chunk);
      }
      if (await completeHistoryIfDone(deps, context, key, reportType, today, window)) {
        counters.backfillsCompleted = (counters.backfillsCompleted ?? 0) + 1;
      }
    }
  }
}

interface ReportKey {
  organizationId: string;
  profileId: string;
  adProduct: string;
  reportType: AmazonAdsReportType;
}

/**
 * Zeitraum der Historie, den Amazon noch vorhält (`retentionDays` je Report-Typ), vom festen Beginn
 * des Merkers bis zum Tag vor dem Fenster. `null`, wenn die Historie abgeschlossen oder leer ist.
 */
async function historyRange(
  deps: ConnectionJobDeps,
  key: ReportKey,
  reportType: AmazonAdsReportType,
  today: string,
  window: DateRange,
): Promise<{ id: string; range: DateRange | null } | null> {
  const oldestAvailable = addDays(
    today,
    -(REPORT_DEFINITIONS[reportType].retentionDays - 1 - RETENTION_MARGIN_DAYS),
  );
  const marker = await ensureBackfill(deps.db, { ...key, fromDate: oldestAvailable });
  if (marker.completedAt !== null) return null;
  const startDate = marker.fromDate > oldestAvailable ? marker.fromDate : oldestAvailable;
  const endDate = addDays(window.startDate, -1);
  return { id: marker.id, range: startDate <= endDate ? { startDate, endDate } : null };
}

/** Tage der Historie, die weder importiert noch in Arbeit sind (gescheiterte und verlorene Stücke). */
async function missingHistory(
  deps: ConnectionJobDeps,
  key: ReportKey,
  reportType: AmazonAdsReportType,
  today: string,
  window: DateRange,
): Promise<DateRange[]> {
  const history = await historyRange(deps, key, reportType, today, window);
  if (!history?.range) return [];
  const covered = await listReportRanges(deps.db, {
    ...key,
    statuses: ['imported', ...OPEN_AMAZON_REQUEST_STATUSES],
  });
  return subtractDateRanges(history.range, covered);
}

/**
 * Setzt den Merker, sobald alle Tage der Historie importiert sind (auch als `superseded`, 1.4) bzw.
 * nichts mehr nachzuladen ist. Tage, die Amazon inzwischen nicht mehr vorhält, sind verloren.
 */
async function completeHistoryIfDone(
  deps: ConnectionJobDeps,
  context: AmazonJobContext,
  key: ReportKey,
  reportType: AmazonAdsReportType,
  today: string,
  window: DateRange,
): Promise<boolean> {
  const history = await historyRange(deps, key, reportType, today, window);
  if (history === null) return false;
  if (history.range !== null) {
    const imported = await listReportRanges(deps.db, { ...key, statuses: ['imported'] });
    if (subtractDateRanges(history.range, imported).length > 0) return false;
  }
  await completeBackfill(deps.db, {
    organizationId: key.organizationId,
    id: history.id,
    now: context.now(),
  });
  return true;
}
