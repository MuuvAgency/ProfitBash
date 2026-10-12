import { connectionTokenAad, decrypt, parseKeyring } from '@profitbash/shared/crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessDeniedError, canSeeSellerAccount, visibleSellerAccountsScope } from './access';
import {
  amazonSpAccounts,
  amazonSpCredentials,
  auditEvents,
  clients,
  connections,
  memberClientGrants,
  members,
  organizations,
  users,
} from './schema';
import { reencryptConnectionTokens } from './key-rotation';
import { getSpCredentials, saveSpConnection, syncSellerAccounts } from './seller-accounts';
import { listActiveConnections, listOtherActiveConnections } from './system-access';
import { createTestConnection, createTestOrganization } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

const keyring = parseKeyring({
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  ENCRYPTION_KEY_ID: 'k1',
});

let testDb: TestDatabase;
const ids = {
  org: '',
  otherOrg: '',
  customerOrg: '',
  admin: '',
  editor: '',
  viewer: '',
  outsider: '',
  customer: '',
  nord: '',
  sued: '',
  connection: '',
  de: '',
  fr: '',
  uk: '',
};

const DE = {
  marketplaceId: 'A1PA6795UKMFR9',
  countryCode: 'DE',
  currencyCode: 'EUR',
  domainName: 'www.amazon.de',
  storeName: 'Nordwind',
  isParticipating: true,
};
const FR = {
  ...DE,
  marketplaceId: 'A13V1IB3VIYZZH',
  countryCode: 'FR',
  domainName: 'www.amazon.fr',
};
const UK = {
  ...DE,
  marketplaceId: 'A1F83G8C2ARO7P',
  countryCode: 'UK',
  currencyCode: 'GBP',
  domainName: 'www.amazon.co.uk',
};
const JP = { ...DE, marketplaceId: 'A1VC38T7YXB528', countryCode: 'JP', currencyCode: 'JPY' };

const connectInput = () => ({
  keyring,
  organizationId: ids.org,
  userId: ids.admin,
  region: 'eu' as const,
  amazonSellerId: 'A1SELLER',
  clientId: 'amzn1.application-oa2-client.x',
  clientSecret: 'SECRET-1',
  refreshToken: 'Atzr|refresh-1',
  participations: [DE, FR, { ...UK, isParticipating: false }, JP],
});

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.org = await createTestOrganization(db, 'muuv');
  ids.otherOrg = await createTestOrganization(db, 'andere');
  const [customerOrg] = await db
    .insert(organizations)
    .values({
      name: 'Nordwind GmbH',
      slug: 'nordwind-kunde',
      type: 'client',
      createdAt: new Date(),
    })
    .returning({ id: organizations.id });
  ids.customerOrg = customerOrg!.id;
  const created = await db
    .insert(users)
    .values(
      ['ada', 'edi', 'vera', 'otto', 'kim'].map((name) => ({ name, email: `${name}@muuv.test` })),
    )
    .returning({ id: users.id });
  [ids.admin, ids.editor, ids.viewer, ids.outsider, ids.customer] = created.map((u) => u.id) as [
    string,
    string,
    string,
    string,
    string,
  ];
  const member = (organizationId: string, userId: string, role: string) => ({
    organizationId,
    userId,
    role,
    createdAt: new Date(),
  });
  const [, editorMember] = await db
    .insert(members)
    .values([
      member(ids.org, ids.admin, 'admin'),
      member(ids.org, ids.editor, 'editor'),
      member(ids.org, ids.viewer, 'viewer'),
      member(ids.otherOrg, ids.outsider, 'admin'),
      member(ids.customerOrg, ids.customer, 'viewer'),
    ])
    .returning({ id: members.id });
  const [nord, sued] = await db
    .insert(clients)
    .values([
      {
        organizationId: ids.org,
        name: 'Nordwind',
        slug: 'nordwind',
        clientOrganizationId: ids.customerOrg,
      },
      { organizationId: ids.org, name: 'Südhang', slug: 'suedhang' },
    ])
    .returning({ id: clients.id });
  ids.nord = nord!.id;
  ids.sued = sued!.id;
  // Edi ist auf Südhang eingeschränkt.
  await db
    .insert(memberClientGrants)
    .values({ organizationId: ids.org, memberId: editorMember!.id, clientId: ids.sued });
});

afterAll(async () => {
  await testDb.close();
});

const visible = async (userId: string, orgId: string, options = {}) => {
  const scope = await visibleSellerAccountsScope(testDb.db, { userId, orgId, ...options });
  return scope ? (await scope.ids).map((row) => row.id).sort() : null;
};

describe('saveSpConnection', () => {
  it('legt Connection, verschlüsselte Zugangsdaten und Seller-Konten in einem Schritt an', async () => {
    const { db } = testDb;
    const result = await saveSpConnection(db, connectInput());
    ids.connection = result.connectionId;
    expect(result).toMatchObject({
      created: true,
      accounts: 2,
      skippedMarketplaceIds: [JP.marketplaceId],
    });

    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, ids.connection));
    expect(connection).toMatchObject({
      provider: 'amazon_sp',
      region: 'eu',
      externalAccountId: 'A1SELLER',
      status: 'active',
    });
    expect(connection!.consentedAt).toBeInstanceOf(Date);
    expect(connection!.refreshTokenEncrypted).not.toContain('refresh-1');
    expect(
      decrypt(connection!.refreshTokenEncrypted, { keyring, aad: connectionTokenAad(connection!) }),
    ).toBe('Atzr|refresh-1');

    const [stored] = await db.select().from(amazonSpCredentials);
    expect(stored!.clientSecretEncrypted).not.toContain('SECRET-1');
    expect(
      await getSpCredentials(db, keyring, { id: ids.connection, organizationId: ids.org }),
    ).toEqual({ clientId: 'amzn1.application-oa2-client.x', clientSecret: 'SECRET-1' });
    // Fremde Organisation: keine Zugangsdaten.
    await expect(
      getSpCredentials(db, keyring, { id: ids.connection, organizationId: ids.otherOrg }),
    ).rejects.toThrow('Connection nicht gefunden.');

    const accounts = await db.select().from(amazonSpAccounts).orderBy(amazonSpAccounts.countryCode);
    // UK nimmt nicht teil, JP kennt ProfitBash nicht.
    expect(
      accounts.map((a) => [a.countryCode, a.currencyCode, a.timezone, a.amazonSellerId]),
    ).toEqual([
      ['DE', 'EUR', 'Europe/Berlin', 'A1SELLER'],
      ['FR', 'EUR', 'Europe/Paris', 'A1SELLER'],
    ]);
    [ids.de, ids.fr] = accounts.map((a) => a.id) as [string, string];

    const audit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'connection.create'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/SECRET-1|refresh-1/);
    expect(audit[0]!.target).toMatchObject({
      provider: 'amazon_sp',
      externalAccountId: 'A1SELLER',
    });
  });

  it('aktualisiert beim Neu-Verbinden dieselbe Connection und behält Zuordnungen', async () => {
    const { db } = testDb;
    await db
      .update(amazonSpAccounts)
      .set({ clientId: ids.nord })
      .where(eq(amazonSpAccounts.id, ids.de));
    await db
      .update(connections)
      .set({ status: 'reauth_required' })
      .where(eq(connections.id, ids.connection));

    const result = await saveSpConnection(db, {
      ...connectInput(),
      clientSecret: 'SECRET-2',
      refreshToken: 'Atzr|refresh-2',
    });

    expect(result).toMatchObject({ connectionId: ids.connection, created: false });
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, ids.connection));
    expect(connection!.status).toBe('active');
    expect(
      (await getSpCredentials(db, keyring, { id: ids.connection, organizationId: ids.org }))
        .clientSecret,
    ).toBe('SECRET-2');
    const [de] = await db.select().from(amazonSpAccounts).where(eq(amazonSpAccounts.id, ids.de));
    expect(de!.clientId).toBe(ids.nord);
    const audit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'connection.reconnect'));
    expect(audit).toHaveLength(1);
  });
});

describe('syncSellerAccounts', () => {
  it('markiert Marktplätze ohne Teilnahme als entfernt und holt sie beim Wiederauftauchen zurück', async () => {
    const { db } = testDb;
    const sync = (participations: (typeof DE)[]) =>
      syncSellerAccounts(db, {
        organizationId: ids.org,
        connectionId: ids.connection,
        amazonSellerId: 'A1SELLER',
        participations,
      });

    expect(
      await sync([DE, { ...FR, isParticipating: false }, { ...UK, isParticipating: true }]),
    ).toEqual({
      accounts: 2,
      created: 1,
      removed: 1,
      skippedMarketplaceIds: [],
    });
    const rows = await db.select().from(amazonSpAccounts);
    const byCountry = Object.fromEntries(rows.map((row) => [row.countryCode, row]));
    expect(byCountry.FR!.removedAt).toBeInstanceOf(Date);
    expect(byCountry.UK).toMatchObject({
      currencyCode: 'GBP',
      timezone: 'Europe/London',
      removedAt: null,
    });
    ids.uk = byCountry.UK!.id;

    expect(await sync([DE, FR, UK])).toMatchObject({ accounts: 3, created: 0, removed: 0 });
    const [fr] = await db.select().from(amazonSpAccounts).where(eq(amazonSpAccounts.id, ids.fr));
    expect(fr!.removedAt).toBeNull();
  });
});

describe('visibleSellerAccountsScope', () => {
  beforeAll(async () => {
    const { db } = testDb;
    // DE → Nordwind, FR → Südhang (ausgeblendet), UK ohne Client und entfernt.
    await db
      .update(amazonSpAccounts)
      .set({ clientId: ids.sued, isHidden: true })
      .where(eq(amazonSpAccounts.id, ids.fr));
    await db
      .update(amazonSpAccounts)
      .set({ removedAt: new Date() })
      .where(eq(amazonSpAccounts.id, ids.uk));
  });

  it('zeigt Mitgliedern die nicht ausgeblendeten, nicht entfernten Konten der eigenen Organisation', async () => {
    expect(await visible(ids.viewer, ids.org)).toEqual([ids.de]);
    expect(await visible(ids.outsider, ids.otherOrg)).toEqual([]);
    expect(await visible(ids.outsider, ids.org)).toBeNull();
  });

  it('zeigt Admins auf Wunsch ausgeblendete und entfernte, anderen Rollen nie', async () => {
    expect(
      await visible(ids.admin, ids.org, { includeHidden: true, includeRemoved: true }),
    ).toEqual([ids.de, ids.fr, ids.uk].sort());
    await expect(visible(ids.viewer, ids.org, { includeHidden: true })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(visible(ids.viewer, ids.org, { includeRemoved: true })).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  it('beachtet Freigaben je Client', async () => {
    // Edi darf nur Südhang; dessen Konto ist ausgeblendet.
    expect(await visible(ids.editor, ids.org)).toEqual([]);
    await testDb.db
      .update(amazonSpAccounts)
      .set({ isHidden: false })
      .where(eq(amazonSpAccounts.id, ids.fr));
    expect(await visible(ids.editor, ids.org)).toEqual([ids.fr]);
  });

  it('zeigt einer Kunden-Org nur die Konten ihres Clients, nie ausgeblendete', async () => {
    expect(await visible(ids.customer, ids.customerOrg)).toEqual([ids.de]);
    await expect(
      visible(ids.customer, ids.customerOrg, { includeHidden: true }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('prüft einzelne Konten mit canSeeSellerAccount', async () => {
    const { db } = testDb;
    const can = (userId: string, orgId: string, sellerAccountId: string) =>
      canSeeSellerAccount(db, { userId, orgId, sellerAccountId });
    expect(await can(ids.viewer, ids.org, ids.de)).toBe(true);
    expect(await can(ids.editor, ids.org, ids.de)).toBe(false);
    expect(await can(ids.outsider, ids.otherOrg, ids.de)).toBe(false);
    expect(await can(ids.customer, ids.customerOrg, ids.fr)).toBe(false);
  });
});

describe('Abgrenzung zu Ads-Connections', () => {
  it('plant für SP-Connections keine Ads-Jobs', async () => {
    const { db } = testDb;
    const adsId = await createTestConnection(db, ids.org, 'amzn1.account.ADS');
    expect((await listActiveConnections(db)).map((c) => c.id)).toEqual([adsId]);
    expect(
      await listOtherActiveConnections(db, { organizationId: ids.org, exceptConnectionId: adsId }),
    ).toEqual([]);
  });

  it('verschlüsselt bei der Schlüsselrotation auch das App-Secret neu', async () => {
    const { db } = testDb;
    const newKey = Buffer.alloc(32, 9).toString('base64');
    const rotating = parseKeyring({
      ENCRYPTION_KEY: newKey,
      ENCRYPTION_KEY_ID: 'k2',
      ENCRYPTION_KEYS_PREVIOUS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
    });

    const result = await reencryptConnectionTokens({ db, keyring: rotating });

    // Die Ads-Connection der Fixtures trägt keinen echten Ciphertext und scheitert; die SP-Connection nicht.
    expect(result.failed.map((failure) => failure.connectionId)).not.toContain(ids.connection);
    // Danach genügt der neue Schlüssel allein.
    const onlyNew = parseKeyring({ ENCRYPTION_KEY: newKey, ENCRYPTION_KEY_ID: 'k2' });
    expect(
      await getSpCredentials(db, onlyNew, { id: ids.connection, organizationId: ids.org }),
    ).toMatchObject({ clientSecret: 'SECRET-2' });
  });
});

describe('Schema-Regeln', () => {
  it('löscht Zugangsdaten und Konten mit der Connection', async () => {
    const { db } = testDb;
    await db.delete(connections).where(and(eq(connections.id, ids.connection)));
    expect(await db.select().from(amazonSpCredentials)).toEqual([]);
    expect(await db.select().from(amazonSpAccounts)).toEqual([]);
  });
});
