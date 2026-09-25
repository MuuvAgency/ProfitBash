import { randomBytes } from 'node:crypto';
import { connectionTokenAad, decrypt, encrypt, parseKeyring } from '@profitbash/shared/crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionNotFoundError, createConnectionTokenStore } from './connection-tokens';
import { amazonAdsProfiles, connections, organizations } from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let connectionId = '';
let organizationId = '';

const keyring = parseKeyring({
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  ENCRYPTION_KEY_ID: 'k1',
});
const ref = () => ({ id: connectionId, organizationId });
const naturalKey = () => ({
  organizationId,
  provider: 'amazon_ads',
  region: 'eu',
  externalAccountId: 'amzn1.account.TEST',
});

async function storedToken(): Promise<{ plaintext: string; lastRefreshedAt: Date | null }> {
  const [row] = await testDb.db
    .select({
      refreshTokenEncrypted: connections.refreshTokenEncrypted,
      lastRefreshedAt: connections.lastRefreshedAt,
    })
    .from(connections)
    .where(eq(connections.id, connectionId));
  if (!row) throw new Error('Connection fehlt');
  return {
    plaintext: decrypt(row.refreshTokenEncrypted, {
      keyring,
      aad: connectionTokenAad(naturalKey()),
    }),
    lastRefreshedAt: row.lastRefreshedAt,
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const [org] = await testDb.db
    .insert(organizations)
    .values({ name: 'Muuv', slug: 'muuv', type: 'internal', createdAt: new Date() })
    .returning({ id: organizations.id });
  organizationId = org?.id ?? '';
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.db.delete(amazonAdsProfiles);
  await testDb.db.delete(connections);
  const [row] = await testDb.db
    .insert(connections)
    .values({
      organizationId,
      provider: 'amazon_ads',
      region: 'eu',
      externalAccountId: 'amzn1.account.TEST',
      refreshTokenEncrypted: encrypt('Atzr|original', {
        keyring,
        aad: connectionTokenAad(naturalKey()),
      }),
    })
    .returning({ id: connections.id });
  connectionId = row?.id ?? '';
});

describe('createConnectionTokenStore', () => {
  it('reicht den entschlüsselten Refresh-Token durch und merkt sich den Zeitpunkt', async () => {
    const store = createConnectionTokenStore({ db: testDb.db, keyring });
    const seen: string[] = [];
    const result = await store.withRefreshToken(ref(), async (refreshToken) => {
      seen.push(refreshToken);
      return { result: 'access', rotatedRefreshToken: null };
    });
    expect(result).toBe('access');
    expect(seen).toEqual(['Atzr|original']);
    const stored = await storedToken();
    expect(stored.plaintext).toBe('Atzr|original');
    expect(stored.lastRefreshedAt).toBeInstanceOf(Date);
  });

  it('speichert einen rotierten Refresh-Token verschlüsselt an derselben Stelle', async () => {
    const store = createConnectionTokenStore({ db: testDb.db, keyring });
    await store.withRefreshToken(ref(), async () => ({
      result: null,
      rotatedRefreshToken: 'Atzr|rotated',
    }));
    const [row] = await testDb.db
      .select({ value: connections.refreshTokenEncrypted })
      .from(connections)
      .where(eq(connections.id, connectionId));
    expect(row?.value).not.toContain('Atzr');
    expect((await storedToken()).plaintext).toBe('Atzr|rotated');
  });

  it('ändert nichts, wenn der Refresh scheitert, und gibt den Fehler weiter', async () => {
    const store = createConnectionTokenStore({ db: testDb.db, keyring });
    await expect(
      store.withRefreshToken(ref(), async () => {
        throw new Error('invalid_grant');
      }),
    ).rejects.toThrow('invalid_grant');
    const stored = await storedToken();
    expect(stored.plaintext).toBe('Atzr|original');
    expect(stored.lastRefreshedAt).toBeNull();
  });

  it('serialisiert gleichzeitige Refreshes: der zweite sieht den rotierten Token des ersten', async () => {
    // Zwei Stores = zwei Prozesse (API und Worker) mit eigener Verbindung.
    const storeA = createConnectionTokenStore({ db: testDb.db, keyring });
    const storeB = createConnectionTokenStore({ db: testDb.db, keyring });

    let releaseA!: () => void;
    const aMayFinish = new Promise<void>((resolve) => (releaseA = resolve));
    let aEntered!: () => void;
    const aHasLock = new Promise<void>((resolve) => (aEntered = resolve));
    const order: string[] = [];

    const a = storeA.withRefreshToken(ref(), async (token) => {
      order.push(`A:start:${token}`);
      aEntered();
      await aMayFinish;
      order.push('A:end');
      return { result: 'A', rotatedRefreshToken: 'Atzr|from-A' };
    });
    await aHasLock;

    const b = storeB.withRefreshToken(ref(), async (token) => {
      order.push(`B:start:${token}`);
      return { result: 'B', rotatedRefreshToken: null };
    });
    // B darf nicht starten, solange A die Sperre hält.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(order).toEqual(['A:start:Atzr|original']);

    releaseA();
    await expect(Promise.all([a, b])).resolves.toEqual(['A', 'B']);
    expect(order).toEqual(['A:start:Atzr|original', 'A:end', 'B:start:Atzr|from-A']);
  });

  it('wirft ConnectionNotFoundError für unbekannte Connections', async () => {
    const store = createConnectionTokenStore({ db: testDb.db, keyring });
    await expect(
      store.withRefreshToken(
        { id: '00000000-0000-4000-8000-000000000000', organizationId },
        async () => ({
          result: null,
          rotatedRefreshToken: null,
        }),
      ),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });

  it('lehnt leere rotierte Tokens ab, statt sie zu speichern', async () => {
    const store = createConnectionTokenStore({ db: testDb.db, keyring });
    await expect(
      store.withRefreshToken(ref(), async () => ({ result: null, rotatedRefreshToken: '' })),
    ).rejects.toThrow(TypeError);
    expect((await storedToken()).plaintext).toBe('Atzr|original');
  });
  it('findet keine Connection einer fremden Organisation', async () => {
    const store = createConnectionTokenStore({ db: testDb.db, keyring });
    const [other] = await testDb.db
      .insert(organizations)
      .values({
        name: 'Fremd',
        slug: `fremd-${randomBytes(4).toString('hex')}`,
        type: 'internal',
        createdAt: new Date(),
      })
      .returning({ id: organizations.id });
    await expect(
      store.withRefreshToken({ id: connectionId, organizationId: other?.id ?? '' }, async () => ({
        result: null,
        rotatedRefreshToken: null,
      })),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });

  it('blockiert keine Profil-Inserts, die per Fremdschlüssel auf die Connection zeigen', async () => {
    const store = createConnectionTokenStore({ db: testDb.db, keyring });
    let release!: () => void;
    const mayFinish = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const hasLock = new Promise<void>((resolve) => (entered = resolve));

    const refresh = store.withRefreshToken(ref(), async () => {
      entered();
      await mayFinish;
      return { result: null, rotatedRefreshToken: null };
    });
    await hasLock;

    // Ein Profil-Upsert (z. B. profiles-sync) nimmt FOR KEY SHARE auf die Connection.
    // Drizzle-Queries laufen bei jedem await erneut: genau einmal starten.
    const insert = testDb.db
      .insert(amazonAdsProfiles)
      .values({
        organizationId,
        connectionId,
        amazonProfileId: '9007199254740993',
        accountName: 'Test',
        countryCode: 'DE',
        currencyCode: 'EUR',
        timezone: 'Europe/Berlin',
        accountType: 'seller',
      })
      .then(() => 'inserted');
    const outcome = await Promise.race([
      insert,
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 500)),
    ]);
    release();
    await refresh;
    await insert;
    expect(outcome).toBe('inserted');
  });

  it('wartet höchstens lockTimeoutMs auf eine gehaltene Sperre', async () => {
    const holder = createConnectionTokenStore({ db: testDb.db, keyring });
    const waiter = createConnectionTokenStore({ db: testDb.db, keyring, lockTimeoutMs: 100 });
    let release!: () => void;
    const mayFinish = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const hasLock = new Promise<void>((resolve) => (entered = resolve));

    const held = holder.withRefreshToken(ref(), async () => {
      entered();
      await mayFinish;
      return { result: null, rotatedRefreshToken: null };
    });
    await hasLock;

    const started = Date.now();
    await expect(
      waiter.withRefreshToken(ref(), async () => ({ result: null, rotatedRefreshToken: null })),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    release();
    await held;
  });
});
