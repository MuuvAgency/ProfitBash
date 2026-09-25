import { createDb, type Db } from '@profitbash/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';
import type { LogEntry } from './logger';
import { createTestContext, readJson, request, TEST_APP_URL, type TestContext } from './testing';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx?.close();
});

describe('GET /api/health', () => {
  it('meldet DB-Verbindung und Version', async () => {
    const res = await request(ctx, '/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok', version: 'test-version' });
  });

  it('antwortet mit 503, wenn die Datenbank nicht erreichbar ist', async () => {
    const broken = createDb('postgres://profitbash@127.0.0.1:1/gibt_es_nicht', { max: 1 });
    const app = createApp({
      db: broken.db,
      auth: ctx.auth,
      appUrl: TEST_APP_URL,
      version: 'test-version',
      logger: () => {},
    });
    try {
      const res = await app.request('/api/health');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'error', db: 'error', version: 'test-version' });
    } finally {
      await broken.close();
    }
  });

  it('antwortet mit 503, wenn die Datenbank nicht rechtzeitig antwortet', async () => {
    const hangingDb = { execute: () => new Promise(() => {}) } as unknown as Db;
    const app = createApp({
      db: hangingDb,
      auth: ctx.auth,
      appUrl: TEST_APP_URL,
      version: 'test-version',
      logger: () => {},
      healthTimeoutMs: 50,
    });
    const res = await app.request('/api/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'error', db: 'error', version: 'test-version' });
  });
});

describe('Fehlerformat', () => {
  it('unbekannte Routen liefern 404 im Fehlerformat', async () => {
    const res = await request(ctx, '/api/gibt-es-nicht');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
  });

  it('unerwartete Fehler liefern 500 ohne interne Details und werden geloggt', async () => {
    const logs: LogEntry[] = [];
    const app = createApp({
      db: ctx.testDb.db,
      auth: ctx.auth,
      appUrl: TEST_APP_URL,
      version: 'test-version',
      logger: (entry) => logs.push(entry),
    });
    app.get('/test-unerwarteter-fehler', () => {
      throw new Error('geheimes internes Detail');
    });

    const res = await app.request('/api/test-unerwarteter-fehler');

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: expect.any(String) } });
    expect(JSON.stringify(body)).not.toContain('geheimes internes Detail');

    const requestId = res.headers.get('x-request-id');
    const errorLog = logs.find((entry) => entry.level === 'error');
    expect(errorLog).toMatchObject({ requestId, error: 'geheimes internes Detail' });
  });
});

describe('Request-ID und Logging', () => {
  it('setzt eine Request-ID und loggt Methode, Pfad, Status und Dauer', async () => {
    const res = await request(ctx, '/api/health');
    const requestId = res.headers.get('x-request-id');
    expect(requestId).toMatch(/^[\w-]{8,}$/);

    const entry = ctx.logs.find((e) => e.msg === 'request' && e.requestId === requestId);
    expect(entry).toMatchObject({
      level: 'info',
      method: 'GET',
      path: '/api/health',
      status: 200,
      durationMs: expect.any(Number),
    });
  });

  it('loggt den Pfad ohne Query-String (OAuth-Codes gehören nicht ins Log)', async () => {
    const res = await request(ctx, '/api/health?code=geheimer-oauth-code');
    const requestId = res.headers.get('x-request-id');
    const entry = ctx.logs.find((e) => e.msg === 'request' && e.requestId === requestId);
    expect(entry?.path).toBe('/api/health');
    expect(JSON.stringify(ctx.logs)).not.toContain('geheimer-oauth-code');
  });
});

describe('GET /api/openapi.json', () => {
  it('beschreibt die eigenen Endpunkte und Schemas', async () => {
    const res = await request(ctx, '/api/openapi.json');
    expect(res.status).toBe(200);
    const doc = await readJson<{
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    }>(res);
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/health',
        '/api/me',
        '/api/settings',
        '/api/settings/ui-state/{scope}/{key}',
      ]),
    );
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['Me', 'Settings', 'ErrorResponse']),
    );
  });
});
