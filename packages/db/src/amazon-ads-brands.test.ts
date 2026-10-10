import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import { listProfileBrands, replaceProfileBrands } from './amazon-ads-brands';
import { amazonAdsBrands, amazonAdsProfiles } from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

/**
 * Marken eines Profils für Sponsored Brands (`phase-4.md` 4.10): Der Bulk-Import ersetzt die Liste aus dem Blatt
 * „Brand Assets Data“, der Assistent liest sie über den Access-Layer.
 */

let testDb: TestDatabase;
let f: AdChangeFixture;

beforeAll(async () => {
  testDb = await createTestDatabase();
  f = await seedAdChangeFixture(testDb.db);
});

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  await testDb.db.delete(amazonAdsBrands);
  await testDb.db.update(amazonAdsProfiles).set({ isHidden: false });
});

const scope = () => ({
  organizationId: f.org,
  profileId: f.profile,
  now: new Date('2099-10-10T10:00:00Z'),
});
const as = (userId: string) => ({ userId, orgId: f.org, profileId: f.profile });

describe('replaceProfileBrands', () => {
  it('legt Marken an, ändert Namen und markiert fehlende als entfernt', async () => {
    await replaceProfileBrands(testDb.db, scope(), [
      { brandEntityId: 'ENTITYA', name: 'Waldkauz' },
      { brandEntityId: 'ENTITYB', name: 'Alt' },
    ]);
    await replaceProfileBrands(testDb.db, scope(), [
      { brandEntityId: 'ENTITYA', name: 'Waldkauz Outdoor' },
      { brandEntityId: 'ENTITYC', name: null },
    ]);
    const rows = await testDb.db
      .select()
      .from(amazonAdsBrands)
      .where(eq(amazonAdsBrands.profileId, f.profile))
      .orderBy(amazonAdsBrands.brandEntityId);
    expect(rows.map((row) => [row.brandEntityId, row.name, row.removedAt !== null])).toEqual([
      ['ENTITYA', 'Waldkauz Outdoor', false],
      ['ENTITYB', 'Alt', true],
      ['ENTITYC', null, false],
    ]);

    // Taucht eine entfernte Marke wieder auf, gilt sie wieder.
    await replaceProfileBrands(testDb.db, scope(), [{ brandEntityId: 'ENTITYB', name: 'Alt' }]);
    expect((await listProfileBrands(testDb.db, as(f.ada)))!.map((b) => b.brandEntityId)).toEqual([
      'ENTITYB',
    ]);
  });
});

describe('listProfileBrands', () => {
  it('liefert nicht entfernte Marken nach Name, nur für sichtbare Profile', async () => {
    await replaceProfileBrands(testDb.db, scope(), [
      { brandEntityId: 'ENTITYZ', name: 'Zelt' },
      { brandEntityId: 'ENTITYA', name: 'Anker' },
    ]);
    expect(await listProfileBrands(testDb.db, as(f.ada))).toEqual([
      { brandEntityId: 'ENTITYA', name: 'Anker' },
      { brandEntityId: 'ENTITYZ', name: 'Zelt' },
    ]);
    expect(
      await listProfileBrands(testDb.db, { ...as(f.ada), orgId: crypto.randomUUID() }),
    ).toBeNull();
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, f.profile));
    expect(await listProfileBrands(testDb.db, as(f.emil))).toBeNull();
  });
});
