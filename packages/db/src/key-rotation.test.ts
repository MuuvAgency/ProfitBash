import { randomBytes } from 'node:crypto';
import {
  connectionTokenAad,
  decrypt,
  encrypt,
  needsReencryption,
  parseKeyring,
} from '@profitbash/shared/crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reencryptConnectionTokens } from './key-rotation';
import { auditEvents, connections, organizations } from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let nordwindId = '';
let lindenhofId = '';

const oldKey = randomBytes(32).toString('base64');
const newKey = randomBytes(32).toString('base64');
/** Vor der Rotation: nur der alte Schlüssel. */
const oldKeyring = parseKeyring({ ENCRYPTION_KEY: oldKey, ENCRYPTION_KEY_ID: 'k1' });
/** Nach dem Deploy der Rotation: neuer Schlüssel, alter nur zum Entschlüsseln. */
const keyring = parseKeyring({
  ENCRYPTION_KEY: newKey,
  ENCRYPTION_KEY_ID: 'k2',
  ENCRYPTION_KEYS_PREVIOUS: `k1:${oldKey}`,
});

interface NaturalKey {
  organizationId: string;
  provider: 'amazon_ads';
  region: 'eu' | 'na' | 'fe' | null;
  externalAccountId: string;
}

async function insertConnection(
  key: NaturalKey,
  refreshTokenEncrypted: string,
  status: 'active' | 'reauth_required' = 'active',
): Promise<string> {
  const [row] = await testDb.db
    .insert(connections)
    .values({ ...key, refreshTokenEncrypted, status })
    .returning({ id: connections.id });
  if (!row) throw new Error('Connection fehlt');
  return row.id;
}

async function storedCiphertext(connectionId: string): Promise<string> {
  const [row] = await testDb.db
    .select({ value: connections.refreshTokenEncrypted })
    .from(connections)
    .where(eq(connections.id, connectionId));
  if (!row) throw new Error('Connection fehlt');
  return row.value;
}

const key = (organizationId: string, externalAccountId: string): NaturalKey => ({
  organizationId,
  provider: 'amazon_ads',
  region: 'eu',
  externalAccountId,
});

beforeAll(async () => {
  testDb = await createTestDatabase();
  const orgs = await testDb.db
    .insert(organizations)
    .values([
      { name: 'Nordwind', slug: 'nordwind', type: 'internal', createdAt: new Date() },
      { name: 'Lindenhof', slug: 'lindenhof', type: 'internal', createdAt: new Date() },
    ])
    .returning({ id: organizations.id });
  nordwindId = orgs[0]?.id ?? '';
  lindenhofId = orgs[1]?.id ?? '';
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.db.delete(auditEvents);
  await testDb.db.delete(connections);
});

describe('reencryptConnectionTokens', () => {
  it('verschlüsselt Tokens mit einem früheren Schlüssel mit dem aktuellen neu', async () => {
    const natural = key(nordwindId, 'amzn1.account.NORDWIND');
    const aad = connectionTokenAad(natural);
    const id = await insertConnection(
      natural,
      encrypt('Atzr|nordwind', { keyring: oldKeyring, aad }),
    );

    const result = await reencryptConnectionTokens({ db: testDb.db, keyring });

    expect(result).toEqual({ checked: 1, reencrypted: 1, failed: [] });
    const stored = await storedCiphertext(id);
    expect(needsReencryption(stored, keyring)).toBe(false);
    expect(decrypt(stored, { keyring, aad })).toBe('Atzr|nordwind');
  });

  it('lässt Tokens mit dem aktuellen Schlüssel unverändert', async () => {
    const natural = key(nordwindId, 'amzn1.account.NORDWIND');
    const ciphertext = encrypt('Atzr|nordwind', { keyring, aad: connectionTokenAad(natural) });
    const id = await insertConnection(natural, ciphertext);

    const result = await reencryptConnectionTokens({ db: testDb.db, keyring });

    expect(result).toEqual({ checked: 1, reencrypted: 0, failed: [] });
    expect(await storedCiphertext(id)).toBe(ciphertext);
  });

  it('erfasst alle Organisationen, Regionen und Status', async () => {
    const naturals = [
      key(nordwindId, 'amzn1.account.NORDWIND'),
      { ...key(lindenhofId, 'amzn1.account.LINDENHOF'), region: 'na' as const },
      { ...key(lindenhofId, 'amzn1.account.KRANICH'), region: null },
    ];
    const ids: string[] = [];
    for (const [index, natural] of naturals.entries()) {
      ids.push(
        await insertConnection(
          natural,
          encrypt(`Atzr|${index}`, { keyring: oldKeyring, aad: connectionTokenAad(natural) }),
          index === 2 ? 'reauth_required' : 'active',
        ),
      );
    }

    const result = await reencryptConnectionTokens({ db: testDb.db, keyring });

    expect(result).toEqual({ checked: 3, reencrypted: 3, failed: [] });
    for (const [index, natural] of naturals.entries()) {
      const stored = await storedCiphertext(ids[index] ?? '');
      expect(decrypt(stored, { keyring, aad: connectionTokenAad(natural) })).toBe(`Atzr|${index}`);
      expect(needsReencryption(stored, keyring)).toBe(false);
    }
  });

  it('meldet kaputte Werte, überspringt sie und macht mit den übrigen weiter', async () => {
    const unknownKeyring = parseKeyring({
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      ENCRYPTION_KEY_ID: 'k0',
    });
    const broken = [
      // kein gültiges Format
      { natural: key(nordwindId, 'amzn1.account.KAPUTT'), value: 'kein-ciphertext' },
      // unbekannte Schlüssel-ID
      {
        natural: key(nordwindId, 'amzn1.account.UNBEKANNT'),
        value: encrypt('Atzr|x', {
          keyring: unknownKeyring,
          aad: connectionTokenAad(key(nordwindId, 'amzn1.account.UNBEKANNT')),
        }),
      },
      // an einen anderen Ort gebunden (falsche AAD)
      {
        natural: key(lindenhofId, 'amzn1.account.KOPIERT'),
        value: encrypt('Atzr|x', {
          keyring: oldKeyring,
          aad: connectionTokenAad(key(nordwindId, 'amzn1.account.KOPIERT')),
        }),
      },
    ];
    const brokenIds: string[] = [];
    for (const { natural, value } of broken) {
      brokenIds.push(await insertConnection(natural, value));
    }
    const good = key(lindenhofId, 'amzn1.account.LINDENHOF');
    const goodId = await insertConnection(
      good,
      encrypt('Atzr|lindenhof', { keyring: oldKeyring, aad: connectionTokenAad(good) }),
    );

    const result = await reencryptConnectionTokens({ db: testDb.db, keyring });

    expect(result.checked).toBe(4);
    expect(result.reencrypted).toBe(1);
    expect(result.failed).toHaveLength(3);
    expect(result.failed.map((entry) => entry.connectionId).sort()).toEqual([...brokenIds].sort());
    for (const entry of result.failed) {
      expect(entry.reason).not.toContain('kein-ciphertext');
      expect(entry.organizationId).toMatch(/^[0-9a-f-]{36}$/);
    }
    for (const [index, { value }] of broken.entries()) {
      expect(await storedCiphertext(brokenIds[index] ?? '')).toBe(value);
    }
    expect(
      decrypt(await storedCiphertext(goodId), { keyring, aad: connectionTokenAad(good) }),
    ).toBe('Atzr|lindenhof');
  });

  it('schreibt je neu verschlüsselter Connection ein Audit-Event ohne Nutzer und ohne Token', async () => {
    const rotated = key(nordwindId, 'amzn1.account.NORDWIND');
    const rotatedId = await insertConnection(
      rotated,
      encrypt('Atzr|nordwind', { keyring: oldKeyring, aad: connectionTokenAad(rotated) }),
    );
    const current = key(lindenhofId, 'amzn1.account.LINDENHOF');
    await insertConnection(
      current,
      encrypt('Atzr|lindenhof', { keyring, aad: connectionTokenAad(current) }),
    );
    await insertConnection(key(lindenhofId, 'amzn1.account.KAPUTT'), 'kein-ciphertext');

    await reencryptConnectionTokens({ db: testDb.db, keyring });

    const events = await testDb.db.select().from(auditEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: nordwindId,
      actorUserId: null,
      action: 'connection.token_reencrypt',
      target: { type: 'connection', id: rotatedId, fromKeyId: 'k1', toKeyId: 'k2' },
    });
    expect(JSON.stringify(events[0])).not.toContain('Atzr');
  });

  // Fängt: fehlende Zeilensperre → die Rotation überschreibt einen Token, den ein paralleler Refresh
  // gerade rotiert hat, mit dem alten Token (verlorenes Update, Connection braucht neue Einwilligung).
  it('wartet auf einen laufenden Refresh und behält dessen rotierten Token', async () => {
    const natural = key(nordwindId, 'amzn1.account.NORDWIND');
    const aad = connectionTokenAad(natural);
    const id = await insertConnection(natural, encrypt('Atzr|alt', { keyring: oldKeyring, aad }));

    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = (): void => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // Wie der Token-Store: Sperre, Aufruf an Amazon, rotierten Token speichern.
    const refresh = testDb.db.transaction(async (tx) => {
      await tx.select().from(connections).where(eq(connections.id, id)).for('no key update');
      locked();
      await released;
      await tx
        .update(connections)
        .set({ refreshTokenEncrypted: encrypt('Atzr|rotiert', { keyring, aad }) })
        .where(eq(connections.id, id));
    });
    await lockTaken;

    const rotation = reencryptConnectionTokens({ db: testDb.db, keyring });
    // Erst freigeben, wenn die Rotation auf eine Sperre wartet.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [waiting] = await testDb.db.execute<{ count: number }>(
        // Nur diese Datenbank: Andere Testdateien laufen parallel auf demselben Server.
        sql`select count(*)::int as count from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if ((waiting?.count ?? 0) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    release();
    await refresh;
    const result = await rotation;

    expect(result).toEqual({ checked: 1, reencrypted: 0, failed: [] });
    expect(decrypt(await storedCiphertext(id), { keyring, aad })).toBe('Atzr|rotiert');
  });

  it('bricht ab, wenn die Sperre zu lange gehalten wird, und ändert nichts', async () => {
    const natural = key(nordwindId, 'amzn1.account.NORDWIND');
    const aad = connectionTokenAad(natural);
    const ciphertext = encrypt('Atzr|alt', { keyring: oldKeyring, aad });
    const id = await insertConnection(natural, ciphertext);

    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = (): void => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = testDb.db.transaction(async (tx) => {
      await tx.select().from(connections).where(eq(connections.id, id)).for('no key update');
      locked();
      await released;
    });
    await lockTaken;

    try {
      // 55P03 = lock_not_available (lock_timeout abgelaufen), nicht irgendein anderer SQL-Fehler.
      await expect(
        reencryptConnectionTokens({ db: testDb.db, keyring, lockTimeoutMs: 100 }),
      ).rejects.toMatchObject({ cause: { code: '55P03' } });
    } finally {
      release();
      await holder;
    }
    expect(await storedCiphertext(id)).toBe(ciphertext);
    expect(await testDb.db.select().from(auditEvents)).toHaveLength(0);
  });

  it('ist wiederholbar: ein zweiter Lauf ändert nichts mehr', async () => {
    const natural = key(nordwindId, 'amzn1.account.NORDWIND');
    const id = await insertConnection(
      natural,
      encrypt('Atzr|nordwind', { keyring: oldKeyring, aad: connectionTokenAad(natural) }),
    );
    await reencryptConnectionTokens({ db: testDb.db, keyring });
    const afterFirst = await storedCiphertext(id);

    const result = await reencryptConnectionTokens({ db: testDb.db, keyring });

    expect(result).toEqual({ checked: 1, reencrypted: 0, failed: [] });
    expect(await storedCiphertext(id)).toBe(afterFirst);
    expect(await testDb.db.select().from(auditEvents)).toHaveLength(1);
  });
});
