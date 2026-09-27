import { EXPORT_TYPES } from '@profitbash/amazon-ads';
import {
  createAmazonExportBatch,
  errorLogFields,
  markEntitiesRemoved,
  upsertPortfolios,
  type JobProfile,
} from '@profitbash/db';
import { isConnectionError, submitAmazonExportBatch } from '../amazon-requests/state-machine';
import { JobFailure, type JobCounters, type JobOutcome } from '../run-job';
import {
  addCounters,
  createAmazonJobContext,
  exportSlotFree,
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

/** Ad-Typen des Entity-Syncs (F2: SP zuerst; SB und SD folgen mit 1.9). */
export const ENTITY_AD_PRODUCTS = ['SPONSORED_PRODUCTS'] as const;

/**
 * `entities-sync` je Connection (1.7): für jedes nicht entfernte Profil (auch ausgeblendete, F14) die
 * Portfolios lesen und direkt schreiben, dann je Ad-Typ einen Export-Batch (Kampagnen, Ad Groups, Targets,
 * Ads) anfordern. Importiert wird im Poll, sobald der ganze Batch fertig ist. Ohne freien Export-Platz
 * (`MAX_RUNNING_EXPORTS_PER_TYPE`) entsteht der Batch nur als Zeilen; der Poll fordert ihn später an.
 *
 * Scheitert ein Profil (außer an der Connection), laufen die übrigen weiter; der Lauf scheitert am Ende
 * mit den Zählern. Fehler der Connection beenden ihn sofort (`handleAmazonError`).
 */
export async function syncConnectionEntities(
  deps: ConnectionJobDeps,
  job: ConnectionJobData,
  run: ConnectionJobRun,
): Promise<JobOutcome> {
  const connection = await loadConnection(deps.db, job);
  const context = await createAmazonJobContext(deps, connection, run);
  const profiles = context.profiles.filter((profile) => profile.removedAt === null);
  const counters: JobCounters = {
    profiles: profiles.length,
    created: 0,
    updated: 0,
    removed: 0,
    placeholdersFilled: 0,
    requested: 0,
    exportsWaiting: 0,
    profileErrors: 0,
  };

  try {
    for (const profile of profiles) {
      try {
        await syncProfile(deps, connection, run, context, profile, counters);
      } catch (err) {
        if (isConnectionError(err)) throw err;
        counters.profileErrors = (counters.profileErrors ?? 0) + 1;
        deps.logger({
          level: 'warn',
          msg: 'entities_sync.profile_failed',
          connectionId: connection.id,
          profileId: profile.id,
          ...errorLogFields(err),
        });
      }
    }
  } catch (err) {
    return handleAmazonError(deps, 'entities-sync', job, connection, err);
  }

  await schedulePoll(deps, job, context.now());
  if (job.chain) {
    await deps.enqueue('reports-sync', {
      organizationId: job.organizationId,
      connectionId: job.connectionId,
    });
  }
  if (counters.profileErrors) {
    throw new JobFailure(
      `Entity-Sync für ${counters.profileErrors} von ${profiles.length} Profilen fehlgeschlagen.`,
      counters,
    );
  }
  return { counters };
}

async function syncProfile(
  deps: ConnectionJobDeps,
  connection: LoadedConnection,
  run: ConnectionJobRun,
  context: AmazonJobContext,
  profile: JobProfile,
  counters: JobCounters,
): Promise<void> {
  await run.extendLease();
  const listedAt = context.now();
  const portfolios = await deps.amazonAds.listPortfolios(connection, profile.amazonProfileId, {
    meter: run.meter,
  });
  const scope = {
    organizationId: connection.organizationId,
    profileId: profile.id,
    now: listedAt,
  };
  // Die Liste ist vollständig (ein ungültiges Portfolio lässt den Aufruf scheitern, 1.6).
  const portfolioCounts = await deps.db.transaction(async (tx) => {
    const { created, updated, placeholdersFilled } = await upsertPortfolios(tx, scope, portfolios);
    const removed = await markEntitiesRemoved(tx, {
      ...scope,
      entity: 'portfolio',
      adProduct: null,
      existedBefore: listedAt,
      seenAmazonIds: portfolios.map((portfolio) => portfolio.amazonPortfolioId),
    });
    return { created, updated, placeholdersFilled, removed };
  });
  addCounters(counters, portfolioCounts);

  for (const adProduct of ENTITY_AD_PRODUCTS) {
    const batch = {
      organizationId: connection.organizationId,
      profileId: profile.id,
      adProduct,
      exportTypes: EXPORT_TYPES,
    };
    let slotsFree = true;
    for (const exportType of EXPORT_TYPES) {
      if (!(await exportSlotFree(deps, connection, exportType))) slotsFree = false;
    }
    if (slotsFree) {
      const { counters: submitted } = await submitAmazonExportBatch(context.machine, batch);
      addCounters(counters, submitted);
    } else {
      const { created } = await createAmazonExportBatch(deps.db, { ...batch, now: context.now() });
      if (created) counters.exportsWaiting = (counters.exportsWaiting ?? 0) + 1;
    }
  }
}
