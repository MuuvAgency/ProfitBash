import {
  createRequestMeter,
  MOCK_AMAZON_ADS_IDENTITY,
  type AmazonAdsClient,
} from '@profitbash/amazon-ads';
import { nextAmazonRequestPollAt, recordAuditEvent, schema, type Db } from '@profitbash/db';
import type { Logger } from '@profitbash/shared';
import { connectionTokenAad, encrypt, type Keyring } from '@profitbash/shared/crypto';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
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
import type { JobOutcome } from './run-job';

const { amazonAdsProfiles, clients, connections, organizations } = schema;

/** Organisation aus `pnpm db:seed`, in die die Demo-Daten kommen. */
export const DEMO_ORGANIZATION_SLUG = 'muuv';
/** Refresh-Token, den der Mock-Anbieter annimmt (wie nach der simulierten Einwilligung). */
const DEMO_REFRESH_TOKEN = 'Atzr|mock-refresh-demo';
/** So oft läuft `reports-sync` höchstens: SB/SD fordert er erst an, wenn ihre Kampagnen in der DB sind. */
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
  const run = (): ConnectionJobRun => ({
    meter: createRequestMeter(),
    runId: null,
    extendLease: () => Promise.resolve(),
  });

  /** Führt einen Job und seine Fortsetzungen aus und summiert die Zähler. */
  async function runJob(
    fn: (d: ConnectionJobDeps, j: ConnectionJobData, r: ConnectionJobRun) => Promise<JobOutcome>,
    queue: ConnectionQueue,
  ): Promise<Record<string, number>> {
    const totals: Record<string, number> = {};
    let data: ConnectionJobData | undefined = job;
    while (data) {
      const outcome = await fn(deps, data, run());
      for (const [key, value] of Object.entries(outcome.counters ?? {})) {
        if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
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
      const outcome = await pollAmazonRequests(deps, job, run());
      const done = outcome.counters?.imported;
      if (typeof done === 'number' && done > 0) {
        imported += done;
        progress(`${label}: ${imported} Dateien importiert …`);
      }
    }
  }

  progress('Profile synchronisieren …');
  const profiles = await runJob(syncConnectionProfiles, 'profiles-sync');
  progress('Entities anfordern …');
  await runJob(syncConnectionEntities, 'entities-sync');
  await drain('Entities');

  let reportRounds = 0;
  while (reportRounds < MAX_REPORT_ROUNDS) {
    reportRounds += 1;
    progress(`Reports anfordern (Runde ${reportRounds}) …`);
    const counters = await runJob(syncConnectionReports, 'reports-sync');
    await drain('Reports');
    if ((counters.requested ?? 0) === 0 && (counters.reused ?? 0) === 0) break;
  }

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
    if (row.inserted) {
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: null,
        action: 'connection.create',
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
      if (!row || client.amazonProfileIds.length === 0) continue;
      const changed = await tx
        .update(amazonAdsProfiles)
        .set({ clientId: row.id })
        .where(
          and(
            eq(amazonAdsProfiles.organizationId, organizationId),
            inArray(amazonAdsProfiles.amazonProfileId, [...client.amazonProfileIds]),
            or(isNull(amazonAdsProfiles.clientId), ne(amazonAdsProfiles.clientId, row.id)),
          ),
        )
        .returning({
          id: amazonAdsProfiles.id,
          amazonProfileId: amazonAdsProfiles.amazonProfileId,
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
            after: { clientId: row.id },
            source: 'demo',
          },
        });
      }
    }
  });
}
