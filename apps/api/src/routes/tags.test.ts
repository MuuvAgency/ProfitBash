import { schema } from '@profitbash/db';
import { seedAdChangeFixture, type AdChangeFixture } from '@profitbash/db/testing';
import type { AssignTagsResponse, ErrorResponse, Tag, TagListResponse } from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  type TestContext,
} from '../testing';

const { amazonAdsProfiles, auditEvents, orgEntitlements, tags } = schema;

/**
 * Tags über die API (`phase-3.md` 3.7): verwalten, zuweisen, Filter in den Auswertungen. Je Endpunkt: Recht
 * `write`, fremde Organisation, ausgeblendetes Profil, Entitlement.
 */

let ctx: TestContext;
let f: AdChangeFixture;
let other: AdChangeFixture;
let admin = '';
let editor = '';
let viewer = '';
let foreign = '';

async function call<T>(method: string, path: string, cookie?: string, json?: unknown) {
  const res = await request(ctx, `/api${path}`, { method, cookie, json });
  // 204 (gelöscht) hat keinen Body.
  const body =
    res.status === 204 ? ({} as T & ErrorResponse) : await readJson<T & ErrorResponse>(res);
  return { status: res.status, body };
}
const create = (cookie: string | undefined, name: string, color = 'violet') =>
  call<Tag>('POST', '/ads/tags', cookie, { name, color });
const list = (cookie: string | undefined) => call<TagListResponse>('GET', '/ads/tags', cookie);
const assign = (cookie: string | undefined, body: Record<string, unknown>) =>
  call<AssignTagsResponse>('POST', '/ads/tags/assign', cookie, body);

beforeAll(async () => {
  ctx = await createTestContext();
  const { db } = ctx.testDb;
  const orgId = ctx.seeded.organizationId;
  const editorUser = await createUser(ctx, {
    email: 'editor@muuv.test',
    org: { id: orgId, role: 'editor' },
  });
  await createUser(ctx, { email: 'viewer@muuv.test', org: { id: orgId, role: 'viewer' } });
  f = await seedAdChangeFixture(db, 'muuv-api', {
    org: orgId,
    ada: ctx.seeded.userId,
    emil: editorUser.id,
  });
  other = await seedAdChangeFixture(db, 'fremd-tags');
  await db.insert(orgEntitlements).values([
    { organizationId: other.org, feature: 'tags' },
    { organizationId: other.org, feature: 'sp-explorer' },
  ]);
  await createUser(ctx, { email: 'fremd@andere.test', org: { id: other.org, role: 'admin' } });
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
  viewer = await signIn(ctx, 'viewer@muuv.test');
  foreign = await signIn(ctx, 'fremd@andere.test');
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.testDb.db.delete(tags);
});

describe('Tags verwalten (/api/ads/tags)', () => {
  it('Editoren legen Tags an, ändern und löschen sie; Viewer lesen nur', async () => {
    const created = await create(editor, '  Winter   Aktion ', 'lime');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Winter Aktion',
      color: 'lime',
      counts: { campaign: 0, ad_group: 0, target: 0, product_ad: 0 },
    });
    const id = created.body.id;

    const listed = await list(viewer);
    expect(listed.status).toBe(200);
    expect(listed.body.tags.map((tag) => tag.name)).toEqual(['Winter Aktion']);
    expect(listed.body.maxTags).toBe(200);

    expect((await create(viewer, 'Nein')).status).toBe(403);
    expect((await call('PATCH', `/ads/tags/${id}`, viewer, { color: 'red' })).status).toBe(403);
    expect((await call('DELETE', `/ads/tags/${id}`, viewer)).status).toBe(403);

    const updated = await call<Tag>('PATCH', `/ads/tags/${id}`, editor, { color: 'red' });
    expect(updated.body).toMatchObject({ name: 'Winter Aktion', color: 'red' });
    expect((await call('DELETE', `/ads/tags/${id}`, editor)).status).toBe(204);
    expect((await list(admin)).body.tags).toEqual([]);
  });

  it('meldet einen vergebenen Namen mit 409', async () => {
    await create(admin, 'Winter');

    const res = await create(admin, 'WINTER');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TAG_NAME_TAKEN');
  });

  it('prüft die Eingabe', async () => {
    expect((await create(admin, '   ')).status).toBe(400);
    expect((await create(admin, 'x'.repeat(41))).status).toBe(400);
    expect((await create(admin, 'Farbe', '#ff0000')).status).toBe(400);
    const { body } = await create(admin, 'Winter');
    expect((await call('PATCH', `/ads/tags/${body.id}`, admin, {})).status).toBe(400);
    expect((await call('PATCH', '/ads/tags/keine-uuid', admin, { color: 'red' })).status).toBe(400);
  });

  it('zeigt und ändert keine Tags fremder Organisationen', async () => {
    const { body } = await create(admin, 'Winter');

    expect((await list(foreign)).body.tags).toEqual([]);
    const patch = await call('PATCH', `/ads/tags/${body.id}`, foreign, { color: 'red' });
    expect(patch.status).toBe(404);
    expect(patch.body.error.code).toBe('TAG_NOT_FOUND');
    expect((await call('DELETE', `/ads/tags/${body.id}`, foreign)).status).toBe(404);
    expect((await list(admin)).body.tags).toHaveLength(1);
  });
});

describe('POST /api/ads/tags/assign', () => {
  it('Editoren weisen Tags zu und lösen sie; die Liste zählt mit, mit Audit-Event', async () => {
    const { body: winter } = await create(admin, 'Winter');
    await ctx.testDb.db.delete(auditEvents);

    const added = await assign(editor, {
      entityType: 'target',
      entityIds: [f.keyword, f.productTarget],
      addTagIds: [winter.id],
    });
    expect(added.status).toBe(200);
    expect(added.body).toEqual({ added: 2, removed: 0, skippedEntities: 0 });
    expect((await list(viewer)).body.tags[0]!.counts.target).toBe(2);

    const removed = await assign(editor, {
      entityType: 'target',
      entityIds: [f.keyword],
      removeTagIds: [winter.id],
    });
    expect(removed.body).toEqual({ added: 0, removed: 1, skippedEntities: 0 });
    const events = await ctx.testDb.db.select().from(auditEvents);
    expect(events.map((event) => event.action)).toEqual(['tags.assign', 'tags.assign']);
  });

  it('Viewer dürfen nicht zuweisen', async () => {
    const { body: winter } = await create(admin, 'Winter');
    const res = await assign(viewer, {
      entityType: 'campaign',
      entityIds: [f.campaign],
      addTagIds: [winter.id],
    });
    expect(res.status).toBe(403);
  });

  it('überspringt Entities fremder Organisationen und ausgeblendeter Profile; fremde Tags: 404', async () => {
    const { body: winter } = await create(admin, 'Winter');
    const { body: theirs } = await create(foreign, 'Fremd');
    await ctx.testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, f.fileProfile));
    try {
      const res = await assign(admin, {
        entityType: 'campaign',
        entityIds: [f.campaign, other.campaign, f.fileCampaign],
        addTagIds: [winter.id],
      });
      expect(res.body).toEqual({ added: 1, removed: 0, skippedEntities: 2 });
    } finally {
      await ctx.testDb.db
        .update(amazonAdsProfiles)
        .set({ isHidden: false })
        .where(eq(amazonAdsProfiles.id, f.fileProfile));
    }
    const res = await assign(admin, {
      entityType: 'campaign',
      entityIds: [f.campaign],
      addTagIds: [theirs.id],
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TAG_NOT_FOUND');
  });

  it('prüft die Eingabe', async () => {
    const { body: winter } = await create(admin, 'Winter');
    const base = { entityType: 'campaign', entityIds: [f.campaign], addTagIds: [winter.id] };
    expect((await assign(admin, { ...base, entityType: 'portfolio' })).status).toBe(400);
    expect((await assign(admin, { ...base, entityIds: [] })).status).toBe(400);
    expect((await assign(admin, { ...base, addTagIds: [] })).status).toBe(400);
    expect(
      (
        await assign(admin, {
          ...base,
          entityIds: Array.from({ length: 1001 }, () => f.campaign),
        })
      ).status,
    ).toBe(400);
  });
});

describe('Tag-Filter in den Auswertungen', () => {
  const query = (tagIds?: string[]) => ({
    period: { from: '2026-09-01', to: '2026-09-30' },
    ...(tagIds && { tagIds }),
  });
  interface Rows {
    rows: { id: string; attributes: { tagIds?: string[] } }[];
  }

  it('filtert Explorer und Dashboard und nennt die Tags je Zeile', async () => {
    const { body: winter } = await create(admin, 'Winter');
    await assign(admin, {
      entityType: 'campaign',
      entityIds: [f.campaign],
      addTagIds: [winter.id],
    });

    const all = await call<Rows>('POST', '/ads/explorer/rows', viewer, {
      ...query(),
      level: 'campaign',
    });
    const tagged = await call<Rows>('POST', '/ads/explorer/rows', viewer, {
      ...query([winter.id]),
      level: 'campaign',
    });
    expect(all.status).toBe(200);
    expect(all.body.rows.length).toBeGreaterThan(1);
    expect(tagged.body.rows.map((row) => row.id)).toEqual([f.campaign]);
    expect(tagged.body.rows[0]!.attributes.tagIds).toEqual([winter.id]);
    expect((await call('POST', '/ads/dashboard', viewer, query([winter.id]))).status).toBe(200);
    expect(
      (
        await call('POST', '/ads/explorer/rows', viewer, {
          ...query(['keine-uuid']),
          level: 'campaign',
        })
      ).status,
    ).toBe(400);
  });
});

describe('Rechte je Endpunkt', () => {
  const ID = '7f1f7a52-0d0b-4b0e-9a55-0a4b7b6a0001';
  const endpoints = (): [string, string, unknown][] => [
    ['GET', '/ads/tags', undefined],
    ['POST', '/ads/tags', { name: 'x', color: 'ink' }],
    ['PATCH', `/ads/tags/${ID}`, { color: 'ink' }],
    ['DELETE', `/ads/tags/${ID}`, undefined],
    ['POST', '/ads/tags/assign', { entityType: 'campaign', entityIds: [ID], addTagIds: [ID] }],
  ];

  it('verlangt eine Session', async () => {
    for (const [method, path, body] of endpoints()) {
      expect((await call(method, path, undefined, body)).status, path).toBe(401);
    }
  });

  it('verlangt das Feature „tags“', async () => {
    const set = (enabled: boolean) =>
      ctx.testDb.db
        .update(orgEntitlements)
        .set({ enabled })
        .where(eq(orgEntitlements.feature, 'tags'));
    await set(false);
    try {
      for (const [method, path, body] of endpoints()) {
        const res = await call(method, path, admin, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body.error.code, path).toBe('FEATURE_FORBIDDEN');
      }
    } finally {
      await set(true);
    }
  });
});
