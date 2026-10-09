import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import {
  createProductGroup,
  deleteProductGroup,
  listAdvertisedProducts,
  listProductGroups,
  ProductGroupError,
  updateProductGroup,
} from './product-groups';
import {
  amazonAdsCampaigns,
  amazonAdsProductAds,
  amazonAdsProfiles,
  auditEvents,
  members,
  productGroupItems,
  productGroups,
  users,
} from './schema';
import { createTestOrganization } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/** Produktgruppen (`phase-4.md` 4.1, F2): je sichtbarem Profil verwalten, Auswahl aus den beworbenen Produkten. */

let testDb: TestDatabase;
let f: AdChangeFixture;
const other = { org: '', otto: '', profile: '' };
let vendorProfile = '';
let stranger = '';

const as = (userId: string, orgId = f.org) => ({ userId, orgId });
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ProductGroupError) return err.code;
    throw err;
  }
  return null;
};
const item = (asin: string, sku: string | null = 'SKU-1', isHero = false) => ({
  asin,
  sku,
  isHero,
});
const group = async (
  name: string,
  items = [item('B0TEST0001', 'SKU-1', true)],
  profileId = f.profile,
) => (await createProductGroup(testDb.db, { ...as(f.ada), profileId, name, items }))!;

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  f = await seedAdChangeFixture(db);
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
  await db.insert(members).values({
    organizationId: other.org,
    userId: other.otto,
    role: 'admin',
    createdAt: new Date(),
  });
  const base = { countryCode: 'DE', currencyCode: 'EUR', timezone: 'Europe/Berlin' };
  const [foreign] = await db
    .insert(amazonAdsProfiles)
    .values({ ...base, organizationId: other.org, accountName: 'Fremd', accountType: 'seller' })
    .returning({ id: amazonAdsProfiles.id });
  other.profile = foreign!.id;
  const [vendor] = await db
    .insert(amazonAdsProfiles)
    .values({ ...base, organizationId: f.org, accountName: 'Vendor DE', accountType: 'vendor' })
    .returning({ id: amazonAdsProfiles.id });
  vendorProfile = vendor!.id;

  // Weitere Anzeigen im Profil: dieselbe ASIN als SB-Anzeige, eine pausierte, eine entfernte, ein Platzhalter.
  const [sb] = await db
    .insert(amazonAdsCampaigns)
    .values({
      organizationId: f.org,
      profileId: f.profile,
      amazonCampaignId: 'SB-1',
      adProduct: 'SPONSORED_BRANDS',
      name: 'SB',
      state: 'ENABLED',
    })
    .returning({ id: amazonAdsCampaigns.id });
  const ad = (amazonAdId: string, patch: Partial<typeof amazonAdsProductAds.$inferInsert>) => ({
    organizationId: f.org,
    profileId: f.profile,
    campaignId: f.campaign,
    adGroupId: f.adGroup,
    amazonAdId,
    adProduct: 'SPONSORED_PRODUCTS',
    state: 'ENABLED',
    ...patch,
  });
  const { amazonAdsAdGroups } = await import('./schema');
  const [sbAdGroup] = await db
    .insert(amazonAdsAdGroups)
    .values({
      organizationId: f.org,
      profileId: f.profile,
      campaignId: sb!.id,
      amazonAdGroupId: 'SB-AG-1',
      adProduct: 'SPONSORED_BRANDS',
      name: 'SB AG',
    })
    .returning({ id: amazonAdsAdGroups.id });
  await db.insert(amazonAdsProductAds).values([
    ad('4002', {
      campaignId: sb!.id,
      adGroupId: sbAdGroup!.id,
      adProduct: 'SPONSORED_BRANDS',
      asin: 'B0TEST0001',
      sku: 'SKU-1',
    }),
    ad('4003', { asin: 'B0TEST0003', sku: 'SKU-3', state: 'PAUSED' }),
    ad('4004', { asin: 'B0TEST0004', sku: 'SKU-4', removedAt: new Date() }),
    ad('4005', { asin: null, sku: null }),
  ]);
});

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  await testDb.db.delete(productGroups);
  await testDb.db.delete(auditEvents);
  await testDb.db
    .update(amazonAdsProfiles)
    .set({ isHidden: false })
    .where(eq(amazonAdsProfiles.id, f.profile));
});

describe('Produktgruppen verwalten', () => {
  it('legt eine Gruppe mit Produkten in Reihenfolge an (Audit) und listet sie mit Profilen und Clients', async () => {
    const created = await createProductGroup(testDb.db, {
      ...as(f.emil),
      profileId: f.profile,
      name: 'Flaschen',
      items: [item('B0TEST0003', 'SKU-3'), item('B0TEST0001', 'SKU-1', true)],
    });

    expect(created).toMatchObject({
      profileId: f.profile,
      name: 'Flaschen',
      items: [
        { asin: 'B0TEST0003', sku: 'SKU-3', isHero: false },
        { asin: 'B0TEST0001', sku: 'SKU-1', isHero: true },
      ],
    });
    const list = await listProductGroups(testDb.db, as(f.ada));
    expect(list!.groups.map((entry) => entry.name)).toEqual(['Flaschen']);
    expect(list!.profiles.map((profile) => profile.accountName)).toEqual([
      'Datei-Konto',
      'Nordwind DE',
      'Vendor DE',
    ]);
    const events = await testDb.db.select().from(auditEvents);
    expect(events.map((event) => event.action)).toEqual(['product_group.create']);
    expect(events[0]!.target).toMatchObject({ profileId: f.profile, name: 'Flaschen', items: 2 });
  });

  it('lehnt denselben Namen im Profil ab (ohne Groß/Klein), erlaubt ihn in einem anderen Profil', async () => {
    await group('Flaschen');

    expect(await code(group('flaschen'))).toBe('NAME_TAKEN');
    expect(await group('Flaschen', [item('B0TEST0001', 'X-1')], f.fileProfile)).toMatchObject({
      name: 'Flaschen',
      profileId: f.fileProfile,
    });
  });

  it('verlangt bei Sellern eine SKU und verbietet sie bei Vendoren', async () => {
    expect(await code(group('Ohne SKU', [item('B0TEST0001', null)]))).toBe('SKU_REQUIRED');
    expect(await code(group('Mit SKU', [item('B0TEST0001', 'V-1')], vendorProfile))).toBe(
      'SKU_NOT_ALLOWED',
    );
    expect(await group('Vendor', [item('B0TEST0001', null, true)], vendorProfile)).toMatchObject({
      items: [{ asin: 'B0TEST0001', sku: null, isHero: true }],
    });
  });

  it('kennt fremde und ausgeblendete Profile nicht', async () => {
    expect(await code(group('Fremd', [item('B0TEST0001')], other.profile))).toBe('NOT_FOUND');
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, f.profile));
    expect(await code(group('Versteckt'))).toBe('NOT_FOUND');
    expect(
      await createProductGroup(testDb.db, {
        ...as(stranger),
        profileId: f.profile,
        name: 'X',
        items: [item('B0TEST0001')],
      }),
    ).toBeNull();
  });

  it('blendet Gruppen ausgeblendeter Profile aus und verweigert dort Ändern und Löschen', async () => {
    const flaschen = await group('Flaschen');
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, f.profile));

    expect((await listProductGroups(testDb.db, as(f.ada)))!.groups).toEqual([]);
    expect(
      await code(updateProductGroup(testDb.db, { ...as(f.ada), id: flaschen.id, name: 'Neu' })),
    ).toBe('NOT_FOUND');
    expect(await code(deleteProductGroup(testDb.db, { ...as(f.ada), id: flaschen.id }))).toBe(
      'NOT_FOUND',
    );
  });

  it('ändert Name und ersetzt die Produkte (Audit mit vorher/nachher); ohne Änderung kein Audit', async () => {
    const flaschen = await group('Flaschen');
    await testDb.db.delete(auditEvents);

    const updated = await updateProductGroup(testDb.db, {
      ...as(f.emil),
      id: flaschen.id,
      name: 'Trinkflaschen',
      items: [item('B0TEST0003', 'SKU-3', true), item('B0TEST0001', 'SKU-1')],
    });
    expect(updated).toMatchObject({
      name: 'Trinkflaschen',
      items: [
        { asin: 'B0TEST0003', isHero: true },
        { asin: 'B0TEST0001', isHero: false },
      ],
    });
    const same = await updateProductGroup(testDb.db, {
      ...as(f.emil),
      id: flaschen.id,
      name: 'Trinkflaschen',
      items: [item('B0TEST0003', 'SKU-3', true), item('B0TEST0001', 'SKU-1')],
    });
    expect(same!.name).toBe('Trinkflaschen');
    const events = await testDb.db.select().from(auditEvents);
    expect(events.map((event) => event.action)).toEqual(['product_group.update']);
    expect(events[0]!.target).toMatchObject({
      before: { name: 'Flaschen', items: [{ asin: 'B0TEST0001', sku: 'SKU-1', isHero: true }] },
      after: { name: 'Trinkflaschen' },
    });
  });

  it('prüft beim Ändern die SKU-Regel des Profils und vergebene Namen', async () => {
    const flaschen = await group('Flaschen');
    await group('Dosen');
    expect(
      await code(
        updateProductGroup(testDb.db, {
          ...as(f.ada),
          id: flaschen.id,
          items: [item('B0TEST0001', null)],
        }),
      ),
    ).toBe('SKU_REQUIRED');
    expect(
      await code(updateProductGroup(testDb.db, { ...as(f.ada), id: flaschen.id, name: 'DOSEN' })),
    ).toBe('NAME_TAKEN');
  });

  it('löscht eine Gruppe samt Produkten (Audit), fremde Gruppen sind unbekannt', async () => {
    const flaschen = await group('Flaschen');
    await testDb.db.delete(auditEvents);
    expect(
      await code(
        deleteProductGroup(testDb.db, { userId: other.otto, orgId: other.org, id: flaschen.id }),
      ),
    ).toBe('NOT_FOUND');

    expect(await deleteProductGroup(testDb.db, { ...as(f.ada), id: flaschen.id })).toBe(true);
    expect(await testDb.db.select().from(productGroupItems)).toEqual([]);
    const events = await testDb.db.select().from(auditEvents);
    expect(events.map((event) => event.action)).toEqual(['product_group.delete']);
  });
});

describe('Beworbene Produkte als Auswahl', () => {
  it('fasst die Anzeigen je ASIN und SKU zusammen, ohne entfernte und Platzhalter, mit Gruppen', async () => {
    const flaschen = await group('Flaschen');
    const result = await listAdvertisedProducts(testDb.db, { ...as(f.ada), profileId: f.profile });

    expect(result).toEqual({
      truncated: false,
      products: [
        {
          asin: 'B0TEST0001',
          sku: 'SKU-1',
          adProducts: ['SPONSORED_BRANDS', 'SPONSORED_PRODUCTS'],
          enabled: true,
          groupIds: [flaschen.id],
        },
        {
          asin: 'B0TEST0003',
          sku: 'SKU-3',
          adProducts: ['SPONSORED_PRODUCTS'],
          enabled: false,
          groupIds: [],
        },
      ],
    });
  });

  it('kennt fremde und ausgeblendete Profile nicht', async () => {
    expect(
      await code(listAdvertisedProducts(testDb.db, { ...as(f.ada), profileId: other.profile })),
    ).toBe('NOT_FOUND');
    expect(
      await listAdvertisedProducts(testDb.db, { ...as(stranger), profileId: f.profile }),
    ).toBeNull();
  });
});
