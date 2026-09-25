import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAccessTokenProvider, type RefreshTokenStore } from './access-token';
import type { LogEntry } from './logger';
import { AmazonAdsReauthRequiredError } from './errors';
import { createHttpClient } from './http';
import { createLwaClient } from './lwa';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const TOKEN_URL = 'https://api.amazon.co.uk/auth/o2/token';
const connection = { id: 'conn-1', organizationId: 'org-1', region: 'eu' as const };

/** Token-Speicher im Speicher (die DB-Variante mit Sperre liegt in `@profitbash/db`). */
function memoryStore(initial: Record<string, string>) {
  const tokens = new Map(Object.entries(initial));
  const writes: Array<{ connectionId: string; refreshToken: string }> = [];
  const store: RefreshTokenStore = {
    async withRefreshToken({ id: connectionId }, refresh) {
      const current = tokens.get(connectionId);
      if (current === undefined) throw new Error('unbekannte Connection');
      const { result, rotatedRefreshToken } = await refresh(current);
      if (rotatedRefreshToken !== null) {
        tokens.set(connectionId, rotatedRefreshToken);
        writes.push({ connectionId, refreshToken: rotatedRefreshToken });
      }
      return result;
    },
  };
  return { store, tokens, writes };
}

function setup(initial: Record<string, string> = { 'conn-1': 'Atzr|one' }) {
  let nowMs = Date.parse('2026-09-26T10:00:00Z');
  const memory = memoryStore(initial);
  const lwa = createLwaClient({
    credentials: { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://app.test/cb' },
    http: createHttpClient({ sleep: async () => {} }),
  });
  const provider = createAccessTokenProvider({ lwa, store: memory.store, now: () => nowMs });
  return {
    provider,
    memory,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

/** LWA-Token-Endpunkt: nummerierte Access-Tokens, protokolliert die benutzten Refresh-Tokens. */
function tokenEndpoint(options: { rotateTo?: (n: number) => string | undefined } = {}) {
  const usedRefreshTokens: string[] = [];
  server.use(
    http.post(TOKEN_URL, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      const refreshToken = form.get('refresh_token') ?? '';
      usedRefreshTokens.push(refreshToken);
      const n = usedRefreshTokens.length;
      return HttpResponse.json({
        access_token: `Atza|access-${n}`,
        refresh_token: options.rotateTo?.(n) ?? refreshToken,
        token_type: 'bearer',
        expires_in: 3600,
      });
    }),
  );
  return usedRefreshTokens;
}

describe('createAccessTokenProvider', () => {
  it('holt beim ersten Aufruf ein Access-Token und nutzt es danach aus dem Cache', async () => {
    const used = tokenEndpoint();
    const { provider } = setup();
    await expect(provider.getAccessToken(connection)).resolves.toBe('Atza|access-1');
    await expect(provider.getAccessToken(connection)).resolves.toBe('Atza|access-1');
    expect(used).toEqual(['Atzr|one']);
  });

  it('erneuert das Token kurz vor Ablauf (5 Minuten Puffer)', async () => {
    const used = tokenEndpoint();
    const { provider, advance } = setup();
    await provider.getAccessToken(connection);
    advance(54 * 60_000);
    await expect(provider.getAccessToken(connection)).resolves.toBe('Atza|access-1');
    advance(60_000);
    await expect(provider.getAccessToken(connection)).resolves.toBe('Atza|access-2');
    expect(used).toHaveLength(2);
  });

  it('bündelt gleichzeitige Anfragen derselben Connection zu einem Refresh', async () => {
    const used = tokenEndpoint();
    const { provider } = setup();
    const tokens = await Promise.all([
      provider.getAccessToken(connection),
      provider.getAccessToken(connection),
      provider.getAccessToken(connection),
    ]);
    expect(tokens).toEqual(['Atza|access-1', 'Atza|access-1', 'Atza|access-1']);
    expect(used).toHaveLength(1);
  });

  it('cached je Connection getrennt', async () => {
    const used = tokenEndpoint();
    const { provider } = setup({ 'conn-1': 'Atzr|one', 'conn-2': 'Atzr|two' });
    await provider.getAccessToken(connection);
    await provider.getAccessToken({ id: 'conn-2', organizationId: 'org-1', region: 'eu' });
    expect(used).toEqual(['Atzr|one', 'Atzr|two']);
  });

  it('speichert einen rotierten Refresh-Token sofort und nutzt ihn beim nächsten Refresh', async () => {
    const used = tokenEndpoint({ rotateTo: (n) => (n === 1 ? 'Atzr|rotated' : undefined) });
    const { provider, memory, advance } = setup();
    await provider.getAccessToken(connection);
    expect(memory.writes).toEqual([{ connectionId: 'conn-1', refreshToken: 'Atzr|rotated' }]);
    expect(memory.tokens.get('conn-1')).toBe('Atzr|rotated');

    advance(60 * 60_000);
    await provider.getAccessToken(connection);
    expect(used).toEqual(['Atzr|one', 'Atzr|rotated']);
  });

  it('schreibt nichts, wenn Amazon denselben Refresh-Token zurückgibt', async () => {
    tokenEndpoint();
    const { provider, memory } = setup();
    await provider.getAccessToken(connection);
    expect(memory.writes).toEqual([]);
  });

  it('gibt invalid_grant als AmazonAdsReauthRequiredError weiter und cached den Fehler nicht', async () => {
    let calls = 0;
    server.use(
      http.post(TOKEN_URL, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ error: 'invalid_grant' }, { status: 400 })
          : HttpResponse.json({ access_token: 'Atza|ok', token_type: 'bearer', expires_in: 3600 });
      }),
    );
    const { provider } = setup();
    await expect(provider.getAccessToken(connection)).rejects.toBeInstanceOf(
      AmazonAdsReauthRequiredError,
    );
    await expect(provider.getAccessToken(connection)).resolves.toBe('Atza|ok');
  });

  it('invalidate() verwirft das gecachte Token (z. B. nach 401 oder Neu-Verbinden)', async () => {
    const used = tokenEndpoint();
    const { provider } = setup();
    await provider.getAccessToken(connection);
    provider.invalidate(connection.id);
    await expect(provider.getAccessToken(connection)).resolves.toBe('Atza|access-2');
    expect(used).toHaveLength(2);
  });
  it('reicht die Connection mit Organisation an den Store weiter', async () => {
    tokenEndpoint();
    const seen: unknown[] = [];
    const lwa = createLwaClient({
      credentials: { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://app.test/cb' },
      http: createHttpClient({ sleep: async () => {} }),
    });
    const provider = createAccessTokenProvider({
      lwa,
      store: {
        async withRefreshToken(conn, refresh) {
          seen.push(conn);
          return (await refresh('Atzr|x')).result;
        },
      },
    });
    await provider.getAccessToken(connection);
    expect(seen).toEqual([connection]);
  });

  it('cached auch sehr kurzlebige Tokens mindestens die halbe Laufzeit', async () => {
    let calls = 0;
    server.use(
      http.post(TOKEN_URL, () => {
        calls += 1;
        return HttpResponse.json({
          access_token: `Atza|${calls}`,
          token_type: 'bearer',
          expires_in: 120,
        });
      }),
    );
    const { provider, advance } = setup();
    await provider.getAccessToken(connection);
    advance(59_000);
    await expect(provider.getAccessToken(connection)).resolves.toBe('Atza|1');
    advance(1_000);
    await expect(provider.getAccessToken(connection)).resolves.toBe('Atza|2');
  });

  it('loggt einen Fehler, wenn ein rotierter Refresh-Token nicht gespeichert werden konnte', async () => {
    tokenEndpoint({ rotateTo: () => 'Atzr|rotated' });
    const logs: LogEntry[] = [];
    const lwa = createLwaClient({
      credentials: { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://app.test/cb' },
      http: createHttpClient({ sleep: async () => {} }),
    });
    const provider = createAccessTokenProvider({
      lwa,
      logger: (entry) => logs.push(entry),
      store: {
        async withRefreshToken(_conn, refresh) {
          await refresh('Atzr|one');
          throw new Error('commit failed');
        },
      },
    });
    await expect(provider.getAccessToken(connection)).rejects.toThrow('commit failed');
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'error',
        msg: 'amazon_ads.rotated_refresh_token_not_saved',
        connectionId: 'conn-1',
      }),
    );
    expect(JSON.stringify(logs)).not.toContain('Atzr|');
  });
});
