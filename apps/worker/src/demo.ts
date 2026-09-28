import {
  createRequestMeter,
  MOCK_AMAZON_ADS_IDENTITY,
  type AmazonAdsClient,
} from '@profitbash/amazon-ads';
import {
  assignProfilesToClient,
  countOpenBackfills,
  nextAmazonRequestPollAt,
  recordAuditEvent,
  schema,
  type Db,
} from '@profitbash/db';
import type { Logger } from '@profitbash/shared';
import { connectionTokenAad, encrypt, type Keyring } from '@profitbash/shared/crypto';
import { and, eq, sql } from 'drizzle-orm';
import { pollAmazonRequests } from './jobs/amazon-requests-poll';
import type {
  ConnectionJobData,
  ConnectionJobDeps,
  ConnectionJobRun,
  ConnectionQueue,
} from './jobs/connection-job';
import { syncConnectionEntities } from './jobs/entities-sync';
import { syncConnectionProfiles } from './jobs/profiles-sync';
import { syncConnectionReports } from './jobs/reports-sync';
import { createJobRunner, type JobOutcome } from './run-job';

const { clients, connections, organizations } = schema;

/** Organisation aus `pnpm db:seed`, in die die Demo-Daten kommen. */
export const DEMO_ORGANIZATION_SLUG = 'muuv';
/** Refresh-Token, den der Mock-Anbieter annimmt (wie nach der simulierten Einwilligung). */
const DEMO_REFRESH_TOKEN = 'Atzr|mock-refresh-demo';
/** So oft läuft `reports-sync` höchstens (normal 2 Runden: anfordern, dann Historie abschließen). */
const MAX_REPORT_ROUNDS = 4;

export interface DemoClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface DemoClient {
  name: string;
  slug: string;
  amazonProfileIds: readonly string[];
}

export interface DemoLoadResult {
  connectionId: string;
  profiles: number;
  reportRounds: number;
}

/**
 * Füllt die lokale Datenbank mit Demo-Daten (`pnpm demo:load`, `phase-2.md` 2.3): legt die Mock-Connection
 * in der Organisation „muuv“ an (wie die simulierte Einwilligung), führt dieselben Jobs aus wie im Betrieb
 * (`profiles-sync`, `entities-sync`, `reports-sync` samt Historie, `amazon-requests-poll`) und legt danach die
 * Clients mit ihrer Zuordnung an (Clients kommen nicht von Amazon). Kein Direkt-Insert von Entities oder
 * Kennzahlen. Wiederholbar: Connection und Clients werden per Schlüssel wiederverwendet.
 *
 * Die Jobs laufen ohne pg-boss und ohne Lease direkt nacheinander; der Entwicklungsserver sollte dabei
 * nicht laufen, sonst synchronisiert sein Worker parallel.
 */
export async function loadDemoData(input: {
  db: Db;
  keyring: Keyring;
  amazonAds: AmazonAdsClient;
  clients: readonly DemoClient[];
  clock: DemoClock;
  logger: Logger;
  /** Fortschritt für die Konsole. */
  progress?: (message: string) => void;
}): Promise<DemoLoadResult> {
  const { db, clock } = input;
  const progress = input.progress ?? (() => {});
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, DEMO_ORGANIZATION_SLUG))
    .limit(1);
  if (!org) {
    throw new Error(
      `Organisation „${DEMO_ORGANIZATION_SLUG}“ fehlt. Zuerst pnpm db:migrate und pnpm db:seed ausführen.`,
    );
  }
  const organizationId = org.id;
  const connectionId = await upsertDemoConnection(db, input.keyring, organizationId, clock.now());
  const job: ConnectionJobData = { organizationId, connectionId };

  // Folgejobs (Fortsetzung nach dem Zeitbudget) sammeln und selbst ausführen; Polls übernimmt `drain`.
  const followUps: Array<{ queue: ConnectionQueue; job: ConnectionJobData }> = [];
  const deps: ConnectionJobDeps = {
    db,
    logger: input.logger,
    amazonAds: input.amazonAds,
    scheduleRetry: () => Promise.resolve(false),
    enqueue: (queue, data) => {
      if (queue !== 'amazon-requests-poll') followUps.push({ queue, job: data });
      return Promise.resolve(true);
    },
    now: () => new Date(clock.now()),
  };
  const jobRunner = createJobRunner({ db, logger: input.logger });
  const scope = { organizationId, scope: connectionId };

  /**
   * Führt einen Job samt Fortsetzungen über `runJob` aus (schreibt `job_runs` wie im Betrieb) und summiert
   * die Zähler. Ein gescheiterter Lauf bricht das Laden mit seiner Meldung ab.
   */
  async function runJob(
    fn: (d: ConnectionJobDeps, j: ConnectionJobData, r: ConnectionJobRun) => Promise<JobOutcome>,
    queue: ConnectionQueue,
  ): Promise<Record<string, number>> {
    const totals: Record<string, number> = {};
    let data: ConnectionJobData | undefined = job;
    while (data) {
      const current: ConnectionJobData = data;
      const meter = createRequestMeter();
      const result = await jobRunner(
        queue,
        scope,
        async ({ runId }) => {
          const outcome = await fn(deps, current, {
            meter,
            runId,
            extendLease: () => Promise.resolve(),
          });
          for (const [key, value] of Object.entries(outcome.counters ?? {})) {
            if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
          }
          return outcome;
        },
        {
          counters: () => ({
            requests: meter.requests,
            throttled: meter.throttled,
            retries: meter.retries,
          }),
        },
      );
      if (result.status === 'failed') {
        throw new Error(`${queue} gescheitert: ${result.error}`);
      }
      const next = followUps.findIndex((f) => f.queue === queue && f.job.resumeFromProfileId);
      data = next >= 0 ? followUps.splice(next, 1)[0]!.job : undefined;
    }
    followUps.length = 0;
    return totals;
  }

  /** Pollt, bis kein Auftrag mehr offen ist; wartet jeweils bis zum nächsten Termin. */
  async function drain(label: string) {
    let imported = 0;
    for (;;) {
      const next = await nextAmazonRequestPollAt(db, job);
      if (next === null) break;
      const wait = next.getTime() - clock.now();
      if (wait > 0) await clock.sleep(wait);
      const counters = await runJob(pollAmazonRequests, 'amazon-requests-poll');
      if ((counters.imported ?? 0) > 0) {
        imported += counters.imported!;
        progress(`${label}: ${imported} Dateien importiert …`);
      }
    }
  }

  progress('Profile synchronisieren …');
  const profiles = await runJob(syncConnectionProfiles, 'profiles-sync');
  progress('Entities anfordern …');
  await runJob(syncConnectionEntities, 'entities-sync');
  await drain('Entities');

  // Runde 1 fordert das Fenster und die Historie an; den Merker der Historie setzt erst der nächste
  // `reports-sync`, wenn alle Stücke importiert sind.
  let reportRounds = 0;
  do {
    reportRounds += 1;
    progress(`Reports anfordern (Runde ${reportRounds}) …`);
    await runJob(syncConnectionReports, 'reports-sync');
    await drain('Reports');
  } while (
    reportRounds < MAX_REPORT_ROUNDS &&
    (await countOpenBackfills(db, { organizationId, connectionId })) > 0
  );

  await upsertDemoClients(db, organizationId, input.clients);
  progress('Clients angelegt und Profile zugeordnet.');
  return { connectionId, profiles: profiles.profiles ?? 0, reportRounds };
}

/** Connection wie nach der simulierten Einwilligung (Schlüssel: Organisation, Anbieter, Region, Konto). */
async function upsertDemoConnection(
  db: Db,
  keyring: Keyring,
  organizationId: string,
  now: number,
): Promise<string> {
  const naturalKey = {
    organizationId,
    provider: 'amazon_ads' as const,
    region: 'eu' as const,
    externalAccountId: MOCK_AMAZON_ADS_IDENTITY.userId,
  };
  const refreshTokenEncrypted = encrypt(DEMO_REFRESH_TOKEN, {
    keyring,
    aad: connectionTokenAad(naturalKey),
  });
  const consentedAt = new Date(now);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(connections)
      .values({
        ...naturalKey,
        externalAccountEmail: MOCK_AMAZON_ADS_IDENTITY.email,
        refreshTokenEncrypted,
        status: 'active',
        lastRefreshedAt: consentedAt,
        consentedAt,
      })
      .onConflictDoUpdate({
        target: [
          connections.organizationId,
          connections.provider,
          connections.region,
          connections.externalAccountId,
        ],
        set: { refreshTokenEncrypted, status: 'active', lastRefreshedAt: consentedAt, consentedAt },
      })
      .returning({ id: connections.id, inserted: sql<boolean>`(xmax = 0)` });
    if (!row) throw new Error('Upsert der Connection lieferte keine Zeile.');
    {
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: null,
        action: row.inserted ? 'connection.create' : 'connection.reconnect',
        target: {
          type: 'connection',
          id: row.id,
          provider: naturalKey.provider,
          region: naturalKey.region,
          externalAccountId: naturalKey.externalAccountId,
          source: 'demo',
        },
      });
    }
    return row.id;
  });
}

/** Legt fehlende Clients an und ordnet ihnen die Profile zu (nur Profile dieser Organisation). */
async function upsertDemoClients(
  db: Db,
  organizationId: string,
  demoClients: readonly DemoClient[],
) {
  await db.transaction(async (tx) => {
    for (const client of demoClients) {
      const [created] = await tx
        .insert(clients)
        .values({ organizationId, name: client.name, slug: client.slug })
        .onConflictDoNothing({ target: [clients.organizationId, clients.slug] })
        .returning({ id: clients.id });
      if (created) {
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: null,
          action: 'client.create',
          target: { type: 'client', id: created.id, name: client.name, source: 'demo' },
        });
      }
      const [row] = await tx
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.organizationId, organizationId), eq(clients.slug, client.slug)));
      if (!row) continue;
      const changed = await assignProfilesToClient(tx, {
        organizationId,
        clientId: row.id,
        amazonProfileIds: client.amazonProfileIds,
      });
      for (const profile of changed) {
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: null,
          action: 'profile.update',
          target: {
            type: 'amazon_ads_profile',
            id: profile.id,
            amazonProfileId: profile.amazonProfileId,
            before: { clientId: profile.previousClientId },
            after: { clientId: row.id },
            source: 'demo',
          },
        });
      }
    }
  });
}
