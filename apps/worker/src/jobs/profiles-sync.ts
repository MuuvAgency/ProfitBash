import type { AmazonAdsProfile, ConnectionRef } from '@profitbash/amazon-ads';
import {
  findUnseenProfiles,
  listOtherActiveConnections,
  markProfilesRemoved,
  reassignProfiles,
  upsertSyncedProfiles,
} from '@profitbash/db';
import type { JobOutcome } from '../run-job';
import {
  enqueueFollowUp,
  handleAmazonError,
  loadConnection,
  type ConnectionJobData,
  type ConnectionJobDeps,
  type ConnectionJobRun,
} from './connection-job';

/**
 * `profiles-sync` für eine Connection: Profile von Amazon upserten, verschwundene Profile auflösen.
 * Ein Profil gilt erst als entfernt, wenn es keine aktive Connection der Organisation mehr liefert;
 * liefert es eine andere noch, hängt es danach an dieser. Lässt sich eine andere Connection nicht
 * abfragen, bleibt alles unverändert (nächster Lauf).
 */
export async function syncConnectionProfiles(
  deps: ConnectionJobDeps,
  job: ConnectionJobData,
  run: ConnectionJobRun,
): Promise<JobOutcome> {
  const { db } = deps;
  const connection = await loadConnection(db, job);

  let listed: AmazonAdsProfile[];
  try {
    listed = await deps.amazonAds.listProfiles(connection, { meter: run.meter });
  } catch (err) {
    return handleAmazonError(deps, 'profiles-sync', job, connection, err);
  }
  // Doppelte IDs würden den Upsert sprengen (dieselbe Zeile zweimal in einer Anweisung).
  const profiles = [...new Map(listed.map((p) => [p.amazonProfileId, p])).values()];

  const unseen = await findUnseenProfiles(db, {
    organizationId: connection.organizationId,
    connectionId: connection.id,
    seenAmazonProfileIds: profiles.map((p) => p.amazonProfileId),
  });
  // Amazon-Aufrufe vor der Transaktion, damit sie keine Sperren hält.
  const resolution = unseen.length > 0 ? await resolveUnseen(deps, run, connection, unseen) : null;

  const now = new Date();
  const counters = await db.transaction(async (tx) => {
    const { created } = await upsertSyncedProfiles(tx, {
      organizationId: connection.organizationId,
      connectionId: connection.id,
      profiles,
      now,
    });
    let reassigned = 0;
    let removed = 0;
    if (resolution && !resolution.deferred) {
      for (const [toConnectionId, amazonProfileIds] of resolution.reassign) {
        reassigned += await reassignProfiles(tx, {
          organizationId: connection.organizationId,
          fromConnectionId: connection.id,
          toConnectionId,
          amazonProfileIds,
        });
      }
      removed = await markProfilesRemoved(tx, {
        organizationId: connection.organizationId,
        connectionId: connection.id,
        amazonProfileIds: resolution.remove,
        now,
      });
    }
    return {
      profiles: profiles.length,
      created,
      reassigned,
      removed,
      removalDeferred: resolution?.deferred ? unseen.length : 0,
    };
  });
  // Kette von „Jetzt synchronisieren“: Profile → Entities → Reports.
  if (job.chain) {
    await enqueueFollowUp(deps, 'profiles-sync', 'entities-sync', {
      organizationId: job.organizationId,
      connectionId: job.connectionId,
      chain: true,
    });
  }
  return { counters };
}

type UnseenResolution =
  { deferred: true } | { deferred: false; reassign: Map<string, string[]>; remove: string[] };

/** Fragt die übrigen aktiven Connections der Organisation, ob sie die verschwundenen Profile liefern. */
async function resolveUnseen(
  deps: ConnectionJobDeps,
  run: ConnectionJobRun,
  connection: ConnectionRef,
  unseen: string[],
): Promise<UnseenResolution> {
  const others = await listOtherActiveConnections(deps.db, {
    organizationId: connection.organizationId,
    exceptConnectionId: connection.id,
  });
  const seenBy = new Map<string, string>();
  for (const other of others) {
    if (!other.region) continue;
    let listed: AmazonAdsProfile[];
    try {
      listed = await deps.amazonAds.listProfiles(
        { id: other.id, organizationId: connection.organizationId, region: other.region },
        { meter: run.meter },
      );
    } catch (err) {
      deps.logger({
        level: 'warn',
        msg: 'profiles_sync.removal_deferred',
        connectionId: connection.id,
        organizationId: connection.organizationId,
        otherConnectionId: other.id,
        error: err instanceof Error ? err.name : 'unknown',
        profiles: unseen.length,
      });
      return { deferred: true };
    }
    for (const profile of listed) {
      if (!seenBy.has(profile.amazonProfileId)) seenBy.set(profile.amazonProfileId, other.id);
    }
  }

  const reassign = new Map<string, string[]>();
  const remove: string[] = [];
  for (const amazonProfileId of unseen) {
    const otherId = seenBy.get(amazonProfileId);
    if (otherId) reassign.set(otherId, [...(reassign.get(otherId) ?? []), amazonProfileId]);
    else remove.push(amazonProfileId);
  }
  return { deferred: false, reassign, remove };
}
