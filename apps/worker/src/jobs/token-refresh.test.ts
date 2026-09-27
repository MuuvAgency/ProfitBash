import { createAmazonAdsClient } from '@profitbash/amazon-ads';
import { createConnectionTokenStore, schema } from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import { eq } from 'drizzle-orm';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobFailure } from '../run-job';
import { connectionTokenAad, encrypt } from '@profitbash/shared/crypto';
import { createConnection, createOrganization, testKeyring } from '../testing';
import type { ConnectionJobDeps, ScheduledRetry } from './connection-job';
import { refreshConnectionToken } from './token-refresh';

const { auditEvents, connections } = schema;
const LWA_TOKEN_URL = 'https://api.amazon.co.uk/auth/o2/token';

const refreshTokensSeen: string[] = [];
const server = setupServer(
  http.post(LWA_TOKEN_URL, async ({ request }) => {
    const form = new URLSearchParams(await request.text());
    refreshTokensSeen.push(form.get('refresh_token') ?? '');
    return HttpResponse.json({
      access_token: 'Atza|neu',
      refresh_token: form.get('refresh_token'),
      token_type: 'bearer',
      expires_in: 3600,
    });
  }),
);

let testDb: TestDatabase;
let organizationId = '';
let connectionId = '';
const retries: ScheduledRetry[] = [];

function deps(): ConnectionJobDeps {
  const client = createAmazonAdsClient({
    credentials: {
      clientId: 'amzn1.application-oa2-client.test',
      clientSecret: 'secret',
      redirectUri: 'http://localhost:5173/api/amazon/oauth/callback',
    },
    store: createConnectionTokenStore({ db: testDb.db, keyring: testKeyring }),
    http: { sleep: () => Promise.resolve() },
  });
  return {
    db: testDb.db,
    logger: () => {},
    amazonAds: client,
    scheduleRetry(retry) {
      retries.push(retry);
      return Promise.resolve(true);
    },
    enqueue: () => Promise.reject(new Error('nicht benutzt')),
  };
}

async function connectionRow() {
  const [row] = await testDb.db.select().from(connections).where(eq(connections.id, connectionId));
  if (!row) throw new Error('Connection fehlt');
  return row;
}

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  testDb = await createTestDatabase();
  organizationId = await createOrganization(testDb.db, 'muuv');
});

afterAll(async () => {
  server.close();
  await testDb.close();
});

beforeEach(async () => {
  await testDb.db.delete(auditEvents);
  await testDb.db.delete(connections);
  connectionId = await createConnection(testDb.db, {
    organizationId,
    externalAccountId: 'amzn1.account.A',
    refreshToken: 'Atzr|gespeichert',
  });
  refreshTokensSeen.length = 0;
  retries.length = 0;
});

afterEach(() => {
  server.resetHandlers();
});

describe('refreshConnectionToken', () => {
  it('erneuert den Token bei LWA, auch wenn noch einer im Cache liegt', async () => {
    const d = deps();
    await refreshConnectionToken(d, { organizationId, connectionId });
    const outcome = await refreshConnectionToken(d, { organizationId, connectionId });

    expect(refreshTokensSeen).toEqual(['Atzr|gespeichert', 'Atzr|gespeichert']);
    expect(outcome.counters).toEqual({ refreshed: 1 });
    expect((await connectionRow()).lastRefreshedAt).toBeInstanceOf(Date);
  });

  it('markiert die Connection bei invalid_grant als reauth_required', async () => {
    server.use(
      http.post(LWA_TOKEN_URL, () =>
        HttpResponse.json({ error: 'invalid_grant', error_description: 'x' }, { status: 400 }),
      ),
    );

    const error = await refreshConnectionToken(deps(), { organizationId, connectionId }).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(JobFailure);
    expect(await connectionRow()).toMatchObject({
      status: 'reauth_required',
      lastRefreshedAt: null,
    });
    const audit = await testDb.db.select().from(auditEvents);
    expect(audit.map((event) => event.action)).toEqual(['connection.reauth_required']);
  });

  it('lässt eine während des Refreshes neu verbundene Connection aktiv', async () => {
    let reconnect: Promise<unknown> = Promise.resolve();
    server.use(
      http.post(LWA_TOKEN_URL, async () => {
        // Das Neu-Verbinden (Upsert im OAuth-Callback) wartet auf die Zeilensperre des Refreshes
        // und committet direkt nach dessen Rollback, also vor dem Markieren.
        reconnect = testDb.db
          .update(connections)
          .set({
            status: 'active',
            refreshTokenEncrypted: encrypt('Atzr|neu-verbunden', {
              keyring: testKeyring,
              aad: connectionTokenAad({
                organizationId,
                provider: 'amazon_ads',
                region: 'eu',
                externalAccountId: 'amzn1.account.A',
              }),
            }),
          })
          .where(eq(connections.id, connectionId))
          .then(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 100));
        return HttpResponse.json(
          { error: 'invalid_grant', error_description: 'x' },
          { status: 400 },
        );
      }),
    );

    await expect(refreshConnectionToken(deps(), { organizationId, connectionId })).rejects.toThrow(
      JobFailure,
    );
    await reconnect;

    expect((await connectionRow()).status).toBe('active');
    expect(await testDb.db.select().from(auditEvents)).toEqual([]);
  });

  it('ruft LWA für Connections mit reauth_required nicht mehr auf', async () => {
    await testDb.db
      .update(connections)
      .set({ status: 'reauth_required' })
      .where(eq(connections.id, connectionId));

    await expect(refreshConnectionToken(deps(), { organizationId, connectionId })).rejects.toThrow(
      /neu verbunden/,
    );
    expect(refreshTokensSeen).toEqual([]);
  });

  it('plant bei langem Retry-After von LWA einen neuen Versuch ein', async () => {
    server.use(
      http.post(
        LWA_TOKEN_URL,
        () => new HttpResponse(null, { status: 429, headers: { 'Retry-After': '120' } }),
      ),
    );

    await expect(refreshConnectionToken(deps(), { organizationId, connectionId })).rejects.toThrow(
      /120 s/,
    );
    expect(retries).toEqual([
      {
        queue: 'token-refresh',
        job: { organizationId, connectionId, retryAttempt: 1 },
        startAfterSeconds: 120,
      },
    ]);
    expect((await connectionRow()).status).toBe('active');
  });
});
