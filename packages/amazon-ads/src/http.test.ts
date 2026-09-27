import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AmazonAdsHttpError, AmazonAdsNetworkError, AmazonAdsResponseError } from './errors';
import { createHttpClient, createRequestMeter, type HttpClientOptions } from './http';
import type { LogEntry } from './logger';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const URL_ = 'https://advertising-api-eu.amazon.com/v2/profiles';
const schema = z.object({ ok: z.boolean() });

function setup(options: Partial<HttpClientOptions> = {}) {
  const logs: LogEntry[] = [];
  const sleeps: number[] = [];
  const client = createHttpClient({
    logger: (entry) => logs.push(entry),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...options,
  });
  return { client, logs, sleeps };
}

function get() {
  return { operation: 'test.get', method: 'GET' as const, url: URL_, schema };
}

describe('createHttpClient', () => {
  it('validiert die Antwort mit zod und gibt die geparsten Daten zurück', async () => {
    server.use(http.get(URL_, () => HttpResponse.json({ ok: true, extra: 1 })));
    const { client } = setup();
    await expect(client.send(get())).resolves.toEqual({ ok: true });
  });

  it('wiederholt 429 mit exponentiellem Backoff und Jitter, bis es klappt', async () => {
    let calls = 0;
    server.use(
      http.get(URL_, () => {
        calls += 1;
        return calls < 3
          ? HttpResponse.json({ code: 'THROTTLED' }, { status: 429 })
          : HttpResponse.json({ ok: true });
      }),
    );
    const { client, sleeps, logs } = setup({ baseDelayMs: 100 });
    await expect(client.send(get())).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
    // Equal Jitter mit random() = 0.5: Basis * 2^(n-1) * 0.75
    expect(sleeps).toEqual([75, 150]);
    expect(logs.filter((l) => l.msg === 'amazon_ads.retry')).toHaveLength(2);
  });

  it('respektiert Retry-After (Sekunden) statt des eigenen Backoffs', async () => {
    let calls = 0;
    server.use(
      http.get(URL_, () => {
        calls += 1;
        return calls === 1
          ? new HttpResponse(null, { status: 429, headers: { 'Retry-After': '7' } })
          : HttpResponse.json({ ok: true });
      }),
    );
    const { client, sleeps } = setup();
    await client.send(get());
    expect(sleeps).toEqual([7000]);
  });

  it('respektiert Retry-After als HTTP-Datum', async () => {
    const now = Date.parse('2026-09-26T10:00:00Z');
    let calls = 0;
    server.use(
      http.get(URL_, () => {
        calls += 1;
        return calls === 1
          ? new HttpResponse(null, {
              status: 503,
              headers: { 'Retry-After': 'Sat, 26 Sep 2026 10:00:03 GMT' },
            })
          : HttpResponse.json({ ok: true });
      }),
    );
    const { client, sleeps } = setup({ now: () => now });
    await client.send(get());
    expect(sleeps).toEqual([3000]);
  });

  it('gibt nach maxAttempts auf und wirft AmazonAdsHttpError mit Status und Code', async () => {
    server.use(
      http.get(URL_, () =>
        HttpResponse.json(
          { code: 'THROTTLED', details: 'Too many requests' },
          { status: 429, headers: { 'x-amz-request-id': 'req-1' } },
        ),
      ),
    );
    const { client, sleeps } = setup({ maxAttempts: 3 });
    const error = await client.send(get()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmazonAdsHttpError);
    expect(error).toMatchObject({ status: 429, code: 'THROTTLED', amazonRequestId: 'req-1' });
    expect(sleeps).toHaveLength(2);
  });

  it('wartet nicht länger als maxRetryAfterMs, sondern gibt den Fehler mit retryAfterMs weiter', async () => {
    server.use(
      http.get(
        URL_,
        () => new HttpResponse(null, { status: 429, headers: { 'Retry-After': '600' } }),
      ),
    );
    const { client, sleeps } = setup({ maxRetryAfterMs: 60_000 });
    const error = await client.send(get()).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 600_000 });
    expect(sleeps).toEqual([]);
  });

  it('gibt Retry-After der letzten Antwort im Fehler weiter, wenn alle Versuche verbraucht sind', async () => {
    server.use(
      http.get(
        URL_,
        () => new HttpResponse(null, { status: 429, headers: { 'Retry-After': '5' } }),
      ),
    );
    const { client } = setup({ maxAttempts: 2 });
    await expect(client.send(get())).rejects.toMatchObject({ status: 429, retryAfterMs: 5000 });
  });

  it('loggt auch den Abbruch wegen zu langem Retry-After', async () => {
    server.use(
      http.get(
        URL_,
        () => new HttpResponse(null, { status: 429, headers: { 'Retry-After': '600' } }),
      ),
    );
    const { client, logs } = setup({ maxRetryAfterMs: 60_000 });
    await client.send(get()).catch(() => {});
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: 'amazon_ads.request_failed',
        status: 429,
        retryAfterMs: 600_000,
      }),
    );
  });

  it('wiederholt 5xx bei GET', async () => {
    let calls = 0;
    server.use(
      http.get(URL_, () => {
        calls += 1;
        return calls === 1
          ? new HttpResponse(null, { status: 502 })
          : HttpResponse.json({ ok: true });
      }),
    );
    const { client } = setup();
    await expect(client.send(get())).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('wiederholt 5xx bei POST nur, wenn der Aufruf es ausdrücklich erlaubt (sonst Doppel-Writes)', async () => {
    let calls = 0;
    server.use(
      http.post(URL_, () => {
        calls += 1;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const { client } = setup({ maxAttempts: 3 });
    const request = { operation: 'test.post', method: 'POST' as const, url: URL_, schema };
    await expect(client.send(request)).rejects.toMatchObject({ status: 500 });
    expect(calls).toBe(1);

    calls = 0;
    await expect(client.send({ ...request, retryServerErrors: true })).rejects.toMatchObject({
      status: 500,
    });
    expect(calls).toBe(3);
  });

  it('wiederholt 429 auch bei POST (die Anfrage wurde nicht verarbeitet)', async () => {
    let calls = 0;
    server.use(
      http.post(URL_, () => {
        calls += 1;
        return calls === 1
          ? new HttpResponse(null, { status: 429 })
          : HttpResponse.json({ ok: true });
      }),
    );
    const { client } = setup();
    await client.send({ operation: 'test.post', method: 'POST', url: URL_, schema });
    expect(calls).toBe(2);
  });

  it('wiederholt andere 4xx nicht', async () => {
    let calls = 0;
    server.use(
      http.get(URL_, () => {
        calls += 1;
        return HttpResponse.json({ code: 'BAD', details: 'nope' }, { status: 400 });
      }),
    );
    const { client } = setup();
    await expect(client.send(get())).rejects.toMatchObject({ status: 400, code: 'BAD' });
    expect(calls).toBe(1);
  });

  it('bricht nach dem Timeout ab und wirft AmazonAdsNetworkError', async () => {
    server.use(
      http.get(URL_, async () => {
        await delay('infinite');
        return HttpResponse.json({ ok: true });
      }),
    );
    const { client } = setup({ timeoutMs: 20, maxAttempts: 1 });
    const error = await client.send(get()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmazonAdsNetworkError);
    expect((error as AmazonAdsNetworkError).timedOut).toBe(true);
  });

  it('wiederholt Timeouts bei GET', async () => {
    let calls = 0;
    server.use(
      http.get(URL_, async () => {
        calls += 1;
        if (calls === 1) await delay('infinite');
        return HttpResponse.json({ ok: true });
      }),
    );
    const { client } = setup({ timeoutMs: 20 });
    await expect(client.send(get())).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('wirft AmazonAdsResponseError, wenn die Antwort nicht zum Schema passt (ohne Rohdaten in der Meldung)', async () => {
    server.use(http.get(URL_, () => HttpResponse.json({ ok: 'secret-ish-value' })));
    const { client } = setup();
    const error = await client.send(get()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmazonAdsResponseError);
    expect((error as Error).message).toContain('ok');
    expect((error as Error).message).not.toContain('secret-ish-value');
  });

  it('wirft AmazonAdsResponseError bei kaputtem JSON', async () => {
    server.use(http.get(URL_, () => new HttpResponse('{"ok":', { status: 200 })));
    const { client } = setup();
    await expect(client.send(get())).rejects.toBeInstanceOf(AmazonAdsResponseError);
  });

  it('parst Antworten verlustfrei (große IDs bleiben Strings)', async () => {
    server.use(
      http.get(
        URL_,
        () =>
          new HttpResponse('{"id": 9007199254740993}', {
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const { client } = setup();
    const result = await client.send({ ...get(), schema: z.object({ id: z.string() }) });
    expect(result.id).toBe('9007199254740993');
  });

  it('loggt Operation, Host, Pfad und Status, aber nie Header, Query-Strings oder Bodies', async () => {
    let calls = 0;
    server.use(
      http.post('https://api.amazon.co.uk/auth/o2/token', () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ error: 'server_error' }, { status: 500 })
          : HttpResponse.json({ ok: true, access_token: 'Atza|SECRET-ACCESS' });
      }),
    );
    const { client, logs } = setup();
    await client.send({
      operation: 'lwa.refresh',
      method: 'POST',
      url: 'https://api.amazon.co.uk/auth/o2/token?leak=Atzr|SECRET-QUERY',
      headers: { Authorization: 'Bearer Atza|SECRET-HEADER' },
      body: new URLSearchParams({
        refresh_token: 'Atzr|SECRET-BODY',
        client_secret: 'SECRET-CLIENT',
      }),
      retryServerErrors: true,
      schema,
    });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toMatch(/SECRET/);
    expect(logs.at(-1)).toMatchObject({
      level: 'info',
      msg: 'amazon_ads.request',
      operation: 'lwa.refresh',
      method: 'POST',
      host: 'api.amazon.co.uk',
      path: '/auth/o2/token',
      status: 200,
      attempts: 2,
    });
  });

  it('kürzt lange Fehlerdetails in der Meldung', async () => {
    server.use(
      http.get(URL_, () =>
        HttpResponse.json({ code: 'X', details: 'a'.repeat(2000) }, { status: 400 }),
      ),
    );
    const { client } = setup();
    const error = (await client.send(get()).catch((e: unknown) => e)) as Error;
    expect(error.message.length).toBeLessThan(500);
  });
});

describe('Zähler und Anfrage-Budget', () => {
  it('zählt jede gesendete Anfrage, jedes 429 und jede Wiederholung im Meter', async () => {
    let calls = 0;
    server.use(
      http.get(URL_, () => {
        calls += 1;
        if (calls === 1) return HttpResponse.json({ code: 'THROTTLED' }, { status: 429 });
        if (calls === 2) return HttpResponse.json({ code: 'INTERNAL' }, { status: 500 });
        return HttpResponse.json({ ok: true });
      }),
    );
    const { client } = setup();
    const meter = createRequestMeter();
    await client.send({ ...get(), meter });
    expect(meter).toEqual({ requests: 3, throttled: 1, retries: 2 });
  });

  it('zählt auch, wenn der Aufruf am Ende scheitert', async () => {
    server.use(http.get(URL_, () => HttpResponse.json({ code: 'THROTTLED' }, { status: 429 })));
    const { client } = setup({ maxAttempts: 2 });
    const meter = createRequestMeter();
    await expect(client.send({ ...get(), meter })).rejects.toBeInstanceOf(AmazonAdsHttpError);
    expect(meter).toEqual({ requests: 2, throttled: 2, retries: 1 });
  });

  it('fragt vor jedem Versuch das Budget und meldet 429 (mit Retry-After) und Erfolg', async () => {
    let calls = 0;
    server.use(
      http.get(URL_, () => {
        calls += 1;
        return calls === 1
          ? new HttpResponse(null, { status: 429, headers: { 'Retry-After': '7' } })
          : HttpResponse.json({ ok: true });
      }),
    );
    const events: string[] = [];
    const pacing = {
      acquire: async () => {
        events.push('acquire');
        return null;
      },
      onThrottled: (retryAfterMs: number | null) => events.push(`throttled:${retryAfterMs}`),
      onSuccess: () => events.push('success'),
    };
    const { client } = setup();
    await client.send({ ...get(), pacing });
    expect(events).toEqual(['acquire', 'throttled:7000', 'acquire', 'success']);
  });

  it('sendet nicht, solange das Profil länger pausiert als abgewartet wird, und nennt die Restdauer', async () => {
    let calls = 0;
    server.use(
      http.get(URL_, () => {
        calls += 1;
        return HttpResponse.json({ ok: true });
      }),
    );
    const maxPauses: number[] = [];
    const pacing = {
      acquire: async (maxPauseMs: number) => {
        maxPauses.push(maxPauseMs);
        return { pausedForMs: 90_000 };
      },
      onThrottled: () => {},
      onSuccess: () => {},
    };
    const { client } = setup({ maxRetryAfterMs: 60_000 });
    const meter = createRequestMeter();
    const error = await client.send({ ...get(), pacing, meter }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmazonAdsHttpError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 90_000 });
    expect(calls).toBe(0);
    expect(maxPauses).toEqual([60_000]);
    expect(meter).toEqual({ requests: 0, throttled: 0, retries: 0 });
  });

  it('meldet dem Budget keinen Erfolg bei anderen Fehlern (z. B. 400)', async () => {
    server.use(http.get(URL_, () => HttpResponse.json({ code: 'BAD' }, { status: 400 })));
    const events: string[] = [];
    const pacing = {
      acquire: async () => {
        events.push('acquire');
        return null;
      },
      onThrottled: () => events.push('throttled'),
      onSuccess: () => events.push('success'),
    };
    const { client } = setup();
    await expect(client.send({ ...get(), pacing })).rejects.toBeInstanceOf(AmazonAdsHttpError);
    expect(events).toEqual(['acquire']);
  });
});
