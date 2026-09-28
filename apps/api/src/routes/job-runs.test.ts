import { schema } from '@profitbash/db';
import type { ErrorResponse, JobRun } from '@profitbash/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  type TestContext,
} from '../testing';

const { connections, jobRuns, organizations } = schema;

let ctx: TestContext;
let admin: string;
let editor: string;
let orgId: string;
let otherOrgId: string;
let connectionId: string;
let otherOrgConnectionId: string;

function connectionRow(organizationId: string, externalAccountId: string, email: string | null) {
  return {
    organizationId,
    provider: 'amazon_ads' as const,
    region: 'eu' as const,
    externalAccountId,
    externalAccountEmail: email,
    refreshTokenEncrypted: 'v1:k1:nicht-benutzt',
  };
}

/** Startzeit `minutes` Minuten nach einem festen Zeitpunkt (größer = neuer). */
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 26, 8, minutes));

beforeAll(async () => {
  ctx = await createTestContext();
  orgId = ctx.seeded.organizationId;
  await createUser(ctx, { email: 'editor@muuv.test', org: { id: orgId, role: 'editor' } });
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');

  const { db } = ctx.testDb;
  const [other] = await db
    .insert(organizations)
    .values({ name: 'Andere', slug: 'andere', type: 'internal', createdAt: new Date() })
    .returning({ id: organizations.id });
  otherOrgId = other!.id;

  const [connection, otherOrgConnection] = await db
    .insert(connections)
    .values([
      connectionRow(orgId, 'amzn1.account.EINS', 'ads@muuv.test'),
      connectionRow(otherOrgId, 'amzn1.account.FREMD', 'fremd@amazon.test'),
    ])
    .returning({ id: connections.id });
  connectionId = connection!.id;
  otherOrgConnectionId = otherOrgConnection!.id;

  await db.insert(jobRuns).values([
    {
      organizationId: orgId,
      job: 'profiles-sync',
      scope: connectionId,
      status: 'success',
      startedAt: at(1),
      finishedAt: at(2),
      counters: { profiles: 4, created: 1 },
    },
    {
      organizationId: orgId,
      job: 'token-refresh',
      scope: connectionId,
      status: 'failed',
      startedAt: at(3),
      finishedAt: at(4),
      error: 'Amazon hat nicht geantwortet.',
    },
    { organizationId: orgId, job: 'profiles-sync', scope: connectionId, startedAt: at(5) },
    // Plattformweit (Cron-Auslöser, Cleanup): gehören nicht zur Org-Sicht.
    { organizationId: null, job: 'profiles-sync', status: 'success', startedAt: at(6) },
    { organizationId: null, job: 'job-runs-cleanup', status: 'success', startedAt: at(7) },
    // Ausnahme: Der Kursabruf (öffentliche Referenzdaten für alle) erscheint in jeder Organisation.
    {
      organizationId: null,
      job: 'fx-rates-sync',
      status: 'success',
      startedAt: at(9),
      finishedAt: at(10),
      counters: { fetched: 29, inserted: 29 },
    },
    // Fremde Organisation.
    {
      organizationId: otherOrgId,
      job: 'profiles-sync',
      scope: otherOrgConnectionId,
      status: 'failed',
      startedAt: at(8),
    },
    // Scope zeigt auf die Connection einer fremden Org: deren Daten dürfen nicht erscheinen.
    {
      organizationId: orgId,
      job: 'token-refresh',
      scope: otherOrgConnectionId,
      status: 'success',
      startedAt: at(0),
    },
  ]);
});

afterAll(async () => {
  await ctx?.close();
});

async function list(query = '') {
  const res = await request(ctx, `/api/job-runs${query}`, { cookie: admin });
  expect(res.status).toBe(200);
  return (await readJson<{ jobRuns: JobRun[] }>(res)).jobRuns;
}

describe('GET /api/job-runs', () => {
  it('verlangt eine Session und die Rolle admin', async () => {
    expect((await request(ctx, '/api/job-runs')).status).toBe(401);
    expect((await request(ctx, '/api/job-runs', { cookie: editor })).status).toBe(403);
  });

  it('listet die Läufe der aktiven Organisation, neueste zuerst, ohne plattformweite (außer Kursabruf) und fremde', async () => {
    const runs = await list();
    expect(runs.map((run) => [run.job, run.status])).toEqual([
      ['fx-rates-sync', 'success'],
      ['profiles-sync', 'running'],
      ['token-refresh', 'failed'],
      ['profiles-sync', 'success'],
      ['token-refresh', 'success'],
    ]);
    expect(runs[3]).toEqual({
      id: expect.any(String),
      job: 'profiles-sync',
      scope: connectionId,
      connection: {
        id: connectionId,
        externalAccountId: 'amzn1.account.EINS',
        externalAccountEmail: 'ads@muuv.test',
      },
      status: 'success',
      startedAt: '2026-09-26T08:01:00.000Z',
      finishedAt: '2026-09-26T08:02:00.000Z',
      error: null,
      counters: { profiles: 4, created: 1 },
    });
    expect(runs[2]).toMatchObject({ error: 'Amazon hat nicht geantwortet.' });
    expect(runs[1]).toMatchObject({ finishedAt: null, counters: {} });
    expect(runs[0]).toMatchObject({ scope: null, connection: null, counters: { fetched: 29 } });
  });

  it('zeigt Connections fremder Organisationen nie an, auch wenn der Scope darauf zeigt', async () => {
    const runs = await list();
    expect(runs[4]).toMatchObject({ scope: otherOrgConnectionId, connection: null });
    expect(JSON.stringify(runs)).not.toContain('FREMD');
  });

  it('filtert nach Job und Status', async () => {
    expect((await list('?job=token-refresh')).map((run) => run.status)).toEqual([
      'failed',
      'success',
    ]);
    expect((await list('?status=running')).map((run) => run.job)).toEqual(['profiles-sync']);
    expect((await list('?job=fx-rates-sync')).map((run) => run.startedAt)).toEqual([
      '2026-09-26T08:09:00.000Z',
    ]);
    expect((await list('?job=profiles-sync&status=success')).map((run) => run.startedAt)).toEqual([
      '2026-09-26T08:01:00.000Z',
    ]);
  });

  it('lehnt unbekannte Filterwerte ab (400)', async () => {
    for (const query of ['?job=job-runs-cleanup', '?status=done']) {
      const res = await request(ctx, `/api/job-runs${query}`, { cookie: admin });
      expect(res.status, query).toBe(400);
      expect((await readJson<ErrorResponse>(res)).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('liefert höchstens die letzten 100 Läufe', async () => {
    await ctx.testDb.db.insert(jobRuns).values(
      Array.from({ length: 105 }, (_, i) => ({
        organizationId: orgId,
        job: 'token-refresh',
        scope: connectionId,
        status: 'success' as const,
        startedAt: at(100 + i),
      })),
    );
    const runs = await list();
    expect(runs).toHaveLength(100);
    expect(runs[0]!.startedAt).toBe(at(204).toISOString());
    expect(runs[99]!.startedAt).toBe(at(105).toISOString());
  });
});
