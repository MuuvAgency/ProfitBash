import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import {
  amazonAdsCampaigns,
  amazonAdsProfiles,
  auditEvents,
  members,
  organizations,
  tagAssignments,
  tags,
  users,
} from './schema';
import { assignTags, createTag, deleteTag, listTags, TagError, updateTag } from './tags';
import { createTestOrganization } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/** Eigene Tags (`phase-3.md` 3.7, F7): je Organisation verwalten, Entities sichtbarer Profile zuweisen. */

let testDb: TestDatabase;
let f: AdChangeFixture;
const other = { org: '', otto: '', campaign: '' };
let stranger = '';

const as = (userId: string, orgId = f.org) => ({ userId, orgId });
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof TagError) return err.code;
    throw err;
  }
  return null;
};
const tag = async (name: string, userId = f.ada, orgId = f.org) =>
  (await createTag(testDb.db, { userId, orgId, name, color: 'violet' }))!;

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
  const [profile] = await db
    .insert(amazonAdsProfiles)
    .values({
      organizationId: other.org,
      accountName: 'Fremd',
      countryCode: 'DE',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      accountType: 'seller',
    })
    .returning({ id: amazonAdsProfiles.id });
  const [campaign] = await db
    .insert(amazonAdsCampaigns)
    .values({
      organizationId: other.org,
      profileId: profile!.id,
      amazonCampaignId: 'C-FREMD',
      adProduct: 'SPONSORED_PRODUCTS',
      name: 'Fremd',
      state: 'ENABLED',
    })
    .returning({ id: amazonAdsCampaigns.id });
  other.campaign = campaign!.id;
});

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  await testDb.db.delete(tags);
  await testDb.db.delete(auditEvents);
});

describe('Tags verwalten', () => {
  it('legt ein Tag mit Name und Farbe an (Audit-Event) und listet es nach Name', async () => {
    await tag('Winter');
    const created = await createTag(testDb.db, {
      ...as(f.emil),
      name: 'Bestseller',
      color: 'lime',
    });

    expect(created).toMatchObject({
      name: 'Bestseller',
      color: 'lime',
      counts: { campaign: 0, ad_group: 0, target: 0, product_ad: 0 },
    });
    const list = await listTags(testDb.db, as(f.ada));
    expect(list!.map((entry) => entry.name)).toEqual(['Bestseller', 'Winter']);
    const events = await testDb.db.select().from(auditEvents);
    expect(events.map((event) => event.action)).toEqual(['tag.create', 'tag.create']);
  });

  it('lehnt denselben Namen in der Organisation ab (ohne Groß/Klein), erlaubt ihn in einer anderen', async () => {
    await tag('Winter');

    expect(await code(tag('winter'))).toBe('NAME_TAKEN');
    expect(await tag('Winter', other.otto, other.org)).toMatchObject({ name: 'Winter' });
  });

  it('ändert Name und Farbe; ein vergebener Name wird abgelehnt', async () => {
    const winter = await tag('Winter');
    await tag('Sommer');

    const updated = await updateTag(testDb.db, { ...as(f.ada), id: winter.id, color: 'red' });
    expect(updated).toMatchObject({ name: 'Winter', color: 'red' });
    expect(await code(updateTag(testDb.db, { ...as(f.ada), id: winter.id, name: 'SOMMER' }))).toBe(
      'NAME_TAKEN',
    );
    // Die eigene Schreibung darf sich ändern.
    expect(
      await updateTag(testDb.db, { ...as(f.ada), id: winter.id, name: 'WINTER' }),
    ).toMatchObject({ name: 'WINTER' });
  });

  it('schreibt kein Audit-Event, wenn sich nichts ändert', async () => {
    const winter = await tag('Winter');
    await testDb.db.delete(auditEvents);

    const same = await updateTag(testDb.db, {
      ...as(f.ada),
      id: winter.id,
      name: 'Winter',
      color: 'violet',
    });

    expect(same).toMatchObject({ name: 'Winter', color: 'violet' });
    expect(await testDb.db.select().from(auditEvents)).toHaveLength(0);
  });

  it('löscht ein Tag samt Zuweisungen, mit Audit-Event', async () => {
    const winter = await tag('Winter');
    await assignTags(testDb.db, {
      ...as(f.ada),
      entityType: 'campaign',
      entityIds: [f.campaign],
      addTagIds: [winter.id],
    });
    await testDb.db.delete(auditEvents);

    await deleteTag(testDb.db, { ...as(f.ada), id: winter.id });

    expect(await listTags(testDb.db, as(f.ada))).toEqual([]);
    expect(await testDb.db.select().from(tagAssignments)).toHaveLength(0);
    const events = await testDb.db.select().from(auditEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'tag.delete',
      target: { type: 'tag', id: winter.id, name: 'Winter', assignments: 1 },
    });
  });

  it('kennt Tags fremder Organisationen nicht', async () => {
    const foreign = await tag('Fremd', other.otto, other.org);

    expect(await listTags(testDb.db, as(f.ada))).toEqual([]);
    expect(await code(updateTag(testDb.db, { ...as(f.ada), id: foreign.id, color: 'red' }))).toBe(
      'NOT_FOUND',
    );
    expect(await code(deleteTag(testDb.db, { ...as(f.ada), id: foreign.id }))).toBe('NOT_FOUND');
    expect(await listTags(testDb.db, as(stranger))).toBeNull();
    expect(await createTag(testDb.db, { ...as(stranger), name: 'x', color: 'ink' })).toBeNull();
  });
});

describe('assignTags', () => {
  it('hängt Tags an Entities und löst sie wieder; Doppeltes zählt nicht', async () => {
    const winter = await tag('Winter');
    const sommer = await tag('Sommer');

    const first = await assignTags(testDb.db, {
      ...as(f.ada),
      entityType: 'target',
      entityIds: [f.keyword, f.productTarget],
      addTagIds: [winter.id, sommer.id],
    });
    expect(first).toEqual({ added: 4, removed: 0, skippedEntities: 0 });

    const second = await assignTags(testDb.db, {
      ...as(f.emil),
      entityType: 'target',
      entityIds: [f.keyword],
      addTagIds: [winter.id],
      removeTagIds: [sommer.id],
    });
    expect(second).toEqual({ added: 0, removed: 1, skippedEntities: 0 });

    const list = await listTags(testDb.db, as(f.ada));
    expect(Object.fromEntries(list!.map((entry) => [entry.name, entry.counts.target]))).toEqual({
      Sommer: 1,
      Winter: 2,
    });
  });

  it('kennt alle vier Arten von Entities', async () => {
    const winter = await tag('Winter');
    for (const [entityType, id] of [
      ['campaign', f.campaign],
      ['ad_group', f.adGroup],
      ['target', f.keyword],
      ['product_ad', f.productAd],
    ] as const) {
      await assignTags(testDb.db, {
        ...as(f.ada),
        entityType,
        entityIds: [id],
        addTagIds: [winter.id],
      });
    }

    const [entry] = (await listTags(testDb.db, as(f.ada)))!;
    expect(entry!.counts).toEqual({ campaign: 1, ad_group: 1, target: 1, product_ad: 1 });
  });

  it('überspringt Entities fremder Organisationen, ausgeblendeter Profile und der falschen Art', async () => {
    const winter = await tag('Winter');
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, f.fileProfile));
    try {
      const result = await assignTags(testDb.db, {
        ...as(f.ada),
        entityType: 'campaign',
        entityIds: [f.campaign, other.campaign, f.fileCampaign, f.adGroup],
        addTagIds: [winter.id],
      });

      expect(result).toEqual({ added: 1, removed: 0, skippedEntities: 3 });
      // Zuweisungen in ausgeblendeten Profilen zählen nicht mit.
      expect((await listTags(testDb.db, as(f.ada)))![0]!.counts.campaign).toBe(1);
    } finally {
      await testDb.db
        .update(amazonAdsProfiles)
        .set({ isHidden: false })
        .where(eq(amazonAdsProfiles.id, f.fileProfile));
    }
  });

  it('lehnt Tags fremder Organisationen ab und weist dann nichts zu', async () => {
    const winter = await tag('Winter');
    const foreign = await tag('Fremd', other.otto, other.org);

    expect(
      await code(
        assignTags(testDb.db, {
          ...as(f.ada),
          entityType: 'campaign',
          entityIds: [f.campaign],
          addTagIds: [winter.id, foreign.id],
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(await testDb.db.select().from(tagAssignments)).toHaveLength(0);
    expect(
      await assignTags(testDb.db, {
        ...as(stranger),
        entityType: 'campaign',
        entityIds: [f.campaign],
        addTagIds: [winter.id],
      }),
    ).toBeNull();
  });

  it('schreibt ein Audit-Event nur, wenn sich etwas geändert hat', async () => {
    const winter = await tag('Winter');
    await testDb.db.delete(auditEvents);
    const input = {
      ...as(f.ada),
      entityType: 'campaign' as const,
      entityIds: [f.campaign],
      addTagIds: [winter.id],
    };

    await assignTags(testDb.db, input);
    await assignTags(testDb.db, input);

    const events = await testDb.db.select().from(auditEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'tags.assign',
      target: { type: 'tags', entityType: 'campaign', added: 1, removed: 0 },
    });
  });
});

describe('Schema', () => {
  it('löscht Tags und Zuweisungen mit der Organisation', async () => {
    const foreign = await tag('Fremd', other.otto, other.org);
    await assignTags(testDb.db, {
      userId: other.otto,
      orgId: other.org,
      entityType: 'campaign',
      entityIds: [other.campaign],
      addTagIds: [foreign.id],
    });

    await testDb.db.delete(organizations).where(eq(organizations.id, other.org));

    expect(await testDb.db.select().from(tags)).toHaveLength(0);
    expect(await testDb.db.select().from(tagAssignments)).toHaveLength(0);
  });
});
