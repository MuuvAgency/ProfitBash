import { DEFAULT_STRUCTURE_CATALOG, type StructureCatalog } from '@profitbash/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import { createProductGroup, ProductGroupError, updateProductGroup } from './product-groups';
import {
  auditEvents,
  clientPresets,
  clients,
  members,
  productGroups,
  structureCatalogs,
  users,
} from './schema';
import {
  getStructureCatalog,
  saveStructureCatalog,
  setClientPreset,
  StructureCatalogError,
} from './structure-catalog';
import { createTestOrganization } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/** Struktur-Katalog (`phase-4.md` 4.2): Dokument je Organisation, nur Admins ändern, Presets je Client und Gruppe. */

let testDb: TestDatabase;
let f: AdChangeFixture;
let client = '';
const other = { org: '', otto: '', client: '' };
let stranger = '';

const as = (userId: string, orgId = f.org) => ({ userId, orgId });
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof StructureCatalogError || err instanceof ProductGroupError) return err.code;
    throw err;
  }
  return null;
};
const changed = (): StructureCatalog => {
  const catalog = structuredClone(DEFAULT_STRUCTURE_CATALOG);
  catalog.naming.pattern = '{client} {adType}-{block}';
  return catalog;
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  f = await seedAdChangeFixture(db);
  [{ id: client }] = (await db
    .insert(clients)
    .values({ organizationId: f.org, name: 'Waldkauz', slug: 'waldkauz' })
    .returning({ id: clients.id })) as [{ id: string }];
  other.org = await createTestOrganization(db, 'andere');
  const [otto, niemand] = await db
    .insert(users)
    .values([
      { name: 'Otto', email: 'otto@andere.test' },
      { name: 'Niemand', email: 'niemand@nirgends.test' },
    ])
    .returning({ id: users.id });
  other.otto = otto!.id;
  stranger = niemand!.id;
  await db
    .insert(members)
    .values({
      organizationId: other.org,
      userId: other.otto,
      role: 'admin',
      createdAt: new Date(),
    });
  const [theirs] = await db
    .insert(clients)
    .values({ organizationId: other.org, name: 'Fremd', slug: 'fremd' })
    .returning({ id: clients.id });
  other.client = theirs!.id;
});

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  await testDb.db.delete(structureCatalogs);
  await testDb.db.delete(clientPresets);
  await testDb.db.delete(productGroups);
  await testDb.db.delete(auditEvents);
});

describe('Struktur-Katalog lesen und speichern', () => {
  it('liefert ohne gespeichertes Dokument die Startwerte (Version 0) und die Clients der Organisation', async () => {
    const result = await getStructureCatalog(testDb.db, as(f.emil));
    expect(result).toMatchObject({ version: 0, updatedAt: null, clientPresets: [] });
    expect(result!.catalog).toEqual(DEFAULT_STRUCTURE_CATALOG);
    expect(result!.clients).toEqual([{ id: client, name: 'Waldkauz' }]);
    expect(await getStructureCatalog(testDb.db, as(stranger))).toBeNull();
  });

  it('speichert für Admins mit Version (Audit), lehnt eine veraltete Version ab', async () => {
    const saved = await saveStructureCatalog(testDb.db, {
      ...as(f.ada),
      catalog: changed(),
      version: 0,
    });
    expect(saved).toMatchObject({ version: 1 });
    expect((await getStructureCatalog(testDb.db, as(f.emil)))!.catalog.naming.pattern).toBe(
      '{client} {adType}-{block}',
    );
    expect(
      await code(saveStructureCatalog(testDb.db, { ...as(f.ada), catalog: changed(), version: 0 })),
    ).toBe('VERSION_CONFLICT');
    const events = await testDb.db.select().from(auditEvents);
    expect(events.map((event) => event.action)).toEqual(['structure_catalog.update']);
    expect(events[0]!.target).toMatchObject({ version: 1, before: { version: 0 } });
  });

  it('lässt nur Admins speichern', async () => {
    expect(
      await code(
        saveStructureCatalog(testDb.db, { ...as(f.emil), catalog: changed(), version: 0 }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await saveStructureCatalog(testDb.db, { ...as(stranger), catalog: changed(), version: 0 }),
    ).toBeNull();
  });

  it('hält die Kataloge der Organisationen getrennt', async () => {
    await saveStructureCatalog(testDb.db, { ...as(f.ada), catalog: changed(), version: 0 });
    const theirs = await getStructureCatalog(testDb.db, as(other.otto, other.org));
    expect(theirs).toMatchObject({ version: 0 });
    expect(theirs!.catalog).toEqual(DEFAULT_STRUCTURE_CATALOG);
  });

  it('fällt bei einem nicht mehr gültigen Dokument auf die Startwerte zurück und behält die Version', async () => {
    await testDb.db
      .insert(structureCatalogs)
      .values({ organizationId: f.org, catalog: { kaputt: true }, version: 4 });
    const result = await getStructureCatalog(testDb.db, as(f.ada));
    expect(result).toMatchObject({ version: 4 });
    expect(result!.catalog).toEqual(DEFAULT_STRUCTURE_CATALOG);
  });
});

describe('Preset je Client', () => {
  it('ordnet ein Preset zu und löst es wieder (Editoren dürfen das, Audit)', async () => {
    expect(
      await setClientPreset(testDb.db, { ...as(f.emil), clientId: client, presetKey: 'launch' }),
    ).toBe(true);
    expect((await getStructureCatalog(testDb.db, as(f.ada)))!.clientPresets).toEqual([
      { clientId: client, presetKey: 'launch' },
    ]);
    await setClientPreset(testDb.db, { ...as(f.emil), clientId: client, presetKey: null });
    expect((await getStructureCatalog(testDb.db, as(f.ada)))!.clientPresets).toEqual([]);
    const events = await testDb.db.select().from(auditEvents);
    expect(events.map((event) => event.action)).toEqual([
      'client_preset.update',
      'client_preset.update',
    ]);
  });

  it('kennt nur Presets des Katalogs und Clients der eigenen Organisation', async () => {
    expect(
      await code(
        setClientPreset(testDb.db, { ...as(f.ada), clientId: client, presetKey: 'gibt-es-nicht' }),
      ),
    ).toBe('UNKNOWN_PRESET');
    expect(
      await code(
        setClientPreset(testDb.db, { ...as(f.ada), clientId: other.client, presetKey: 'launch' }),
      ),
    ).toBe('NOT_FOUND');
  });
});

describe('Preset je Produktgruppe', () => {
  const items = [{ asin: 'B0TEST0001', sku: 'SKU-1', isHero: true }];

  it('speichert ein Preset beim Anlegen und Ändern und kennt nur Presets des Katalogs', async () => {
    const group = await createProductGroup(testDb.db, {
      ...as(f.emil),
      profileId: f.profile,
      name: 'Flaschen',
      items,
      presetKey: 'control',
    });
    expect(group).toMatchObject({ presetKey: 'control' });
    const cleared = await updateProductGroup(testDb.db, {
      ...as(f.emil),
      id: group!.id,
      presetKey: null,
    });
    expect(cleared).toMatchObject({ presetKey: null });
    expect(
      await code(
        updateProductGroup(testDb.db, { ...as(f.emil), id: group!.id, presetKey: 'gibt-es-nicht' }),
      ),
    ).toBe('UNKNOWN_PRESET');
  });
});
