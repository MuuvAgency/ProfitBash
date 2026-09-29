import type { SavedViewState } from '@profitbash/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSavedView,
  deleteSavedView,
  getSavedView,
  listSavedViews,
  SavedViewError,
  updateSavedView,
} from './saved-views';
import {
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsPortfolios,
  amazonAdsProfiles,
  auditEvents,
  clients,
  members,
  savedViews,
  users,
} from './schema';
import { createTestConnection, createTestOrganization } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/** Gespeicherte Ansichten (2.9, F8): Rechte, Freigabe, Filter über den Access-Layer, Audit. */

let testDb: TestDatabase;
const ids = {
  org: '',
  otherOrg: '',
  admin: '',
  editor: '',
  viewer: '',
  outsider: '',
  clientA: '',
  clientForeign: '',
  de: '',
  hidden: '',
  foreign: '',
  portfolioDe: '',
  campaignDe: '',
  adGroupDe: '',
  campaignHidden: '',
  campaignForeign: '',
};

const filters = (patch: Partial<SavedViewState['filters']> = {}): SavedViewState['filters'] => ({
  clientIds: [],
  withoutClient: false,
  profileIds: null,
  period: { preset: 'last30' },
  comparison: 'previous',
  currency: 'auto',
  attribution: 'console',
  ...patch,
});

const explorer = (
  drill: Partial<NonNullable<SavedViewState['explorer']>['drill']> = {},
): NonNullable<SavedViewState['explorer']> => ({
  level: 'target',
  drill: { portfolioId: null, campaignId: null, adGroupId: null, ...drill },
  includeRemoved: false,
  adProducts: [],
  chartMetrics: ['cost', 'sales'],
  columns: null,
  sort: { column: 'cost', direction: 'desc' },
});

const as = (userId: string) => ({ userId, orgId: ids.org });

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.org = await createTestOrganization(db, 'muuv');
  ids.otherOrg = await createTestOrganization(db, 'andere');
  const [admin, editor, viewer, outsider] = await db
    .insert(users)
    .values([
      { name: 'Ada', email: 'ada@muuv.test' },
      { name: 'Emil', email: 'emil@muuv.test' },
      { name: 'Vera', email: 'vera@muuv.test' },
      { name: 'Otto', email: 'otto@andere.test' },
    ])
    .returning({ id: users.id });
  ids.admin = admin!.id;
  ids.editor = editor!.id;
  ids.viewer = viewer!.id;
  ids.outsider = outsider!.id;
  await db.insert(members).values([
    { organizationId: ids.org, userId: ids.admin, role: 'admin', createdAt: new Date() },
    { organizationId: ids.org, userId: ids.editor, role: 'editor', createdAt: new Date() },
    { organizationId: ids.org, userId: ids.viewer, role: 'viewer', createdAt: new Date() },
    { organizationId: ids.otherOrg, userId: ids.outsider, role: 'admin', createdAt: new Date() },
  ]);
  const [clientA] = await db
    .insert(clients)
    .values({ organizationId: ids.org, name: 'Alpha', slug: 'alpha' })
    .returning({ id: clients.id });
  const [clientForeign] = await db
    .insert(clients)
    .values({ organizationId: ids.otherOrg, name: 'Fremd', slug: 'fremd' })
    .returning({ id: clients.id });
  ids.clientA = clientA!.id;
  ids.clientForeign = clientForeign!.id;

  const connection = await createTestConnection(db, ids.org, 'amzn1.account.MUUV');
  const otherConnection = await createTestConnection(db, ids.otherOrg, 'amzn1.account.OTHER');
  const profile = (organizationId: string, connectionId: string, amazonProfileId: string) => ({
    organizationId,
    connectionId,
    amazonProfileId,
    accountName: `Konto ${amazonProfileId}`,
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    accountType: 'seller',
  });
  const [de, hidden, foreign] = await db
    .insert(amazonAdsProfiles)
    .values([
      { ...profile(ids.org, connection, '1'), clientId: ids.clientA },
      { ...profile(ids.org, connection, '2'), clientId: ids.clientA, isHidden: true },
      profile(ids.otherOrg, otherConnection, '3'),
    ])
    .returning({ id: amazonAdsProfiles.id });
  ids.de = de!.id;
  ids.hidden = hidden!.id;
  ids.foreign = foreign!.id;

  const [portfolio] = await db
    .insert(amazonAdsPortfolios)
    .values({ organizationId: ids.org, profileId: ids.de, amazonPortfolioId: 'P1', name: 'P' })
    .returning({ id: amazonAdsPortfolios.id });
  ids.portfolioDe = portfolio!.id;
  const campaign = (organizationId: string, profileId: string, amazonCampaignId: string) => ({
    organizationId,
    profileId,
    amazonCampaignId,
    adProduct: 'SPONSORED_PRODUCTS',
    name: `Kampagne ${amazonCampaignId}`,
  });
  const [campaignDe, campaignHidden, campaignForeign] = await db
    .insert(amazonAdsCampaigns)
    .values([
      campaign(ids.org, ids.de, 'C1'),
      campaign(ids.org, ids.hidden, 'C2'),
      campaign(ids.otherOrg, ids.foreign, 'C3'),
    ])
    .returning({ id: amazonAdsCampaigns.id });
  ids.campaignDe = campaignDe!.id;
  ids.campaignHidden = campaignHidden!.id;
  ids.campaignForeign = campaignForeign!.id;
  const [adGroup] = await db
    .insert(amazonAdsAdGroups)
    .values({
      organizationId: ids.org,
      profileId: ids.de,
      campaignId: ids.campaignDe,
      amazonAdGroupId: 'G1',
      adProduct: 'SPONSORED_PRODUCTS',
      name: 'G',
    })
    .returning({ id: amazonAdsAdGroups.id });
  ids.adGroupDe = adGroup!.id;
});

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  await testDb.db.delete(savedViews);
  await testDb.db.delete(auditEvents);
});

async function create(userId: string, input: Partial<Parameters<typeof createSavedView>[1]> = {}) {
  return createSavedView(testDb.db, {
    ...as(userId),
    name: 'Meine Ansicht',
    area: 'dashboard',
    shared: false,
    canShare: true,
    state: { filters: filters() },
    ...input,
  });
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SavedViewError) return err.code;
    throw err;
  }
  return undefined;
}

describe('Anlegen und Liste', () => {
  it('persönliche Ansichten sieht nur der Besitzer, auch ein Viewer darf sie anlegen', async () => {
    const view = await create(ids.viewer, { canShare: false });
    expect(view).toMatchObject({ name: 'Meine Ansicht', shared: false, own: true, canEdit: true });
    expect(
      (await listSavedViews(testDb.db, { ...as(ids.viewer), area: 'dashboard' })).map((v) => v.id),
    ).toEqual([view.id]);
    expect(await listSavedViews(testDb.db, { ...as(ids.admin), area: 'dashboard' })).toEqual([]);
    expect(await getSavedView(testDb.db, { ...as(ids.admin), id: view.id })).toBeNull();
  });

  it('freigegebene Ansichten sehen alle Mitglieder der Organisation, keine fremde', async () => {
    const view = await create(ids.editor, { shared: true });
    const forViewer = await listSavedViews(testDb.db, { ...as(ids.viewer), area: 'dashboard' });
    expect(forViewer).toHaveLength(1);
    expect(forViewer[0]).toMatchObject({
      id: view.id,
      own: false,
      canEdit: false,
      owner: { id: ids.editor, name: 'Emil' },
    });
    expect(
      await listSavedViews(testDb.db, { userId: ids.outsider, orgId: ids.org, area: 'dashboard' }),
    ).toEqual([]);
    expect(
      await listSavedViews(testDb.db, {
        userId: ids.outsider,
        orgId: ids.otherOrg,
        area: 'dashboard',
      }),
    ).toEqual([]);
    expect(
      await getSavedView(testDb.db, { userId: ids.outsider, orgId: ids.org, id: view.id }),
    ).toBeNull();
  });

  it('trennt die Bereiche und sortiert eigene vor fremden, dann nach Name', async () => {
    await create(ids.admin, { name: 'b', shared: true });
    await create(ids.viewer, { name: 'z', canShare: false });
    await create(ids.viewer, { name: 'a', canShare: false });
    await create(ids.viewer, {
      name: 'Explorer',
      area: 'explorer',
      canShare: false,
      state: { filters: filters(), explorer: explorer() },
    });
    const list = await listSavedViews(testDb.db, { ...as(ids.viewer), area: 'dashboard' });
    expect(list.map((v) => v.name)).toEqual(['a', 'z', 'b']);
  });

  it('ohne Schreibrecht nicht freigeben', async () => {
    expect(await errorCode(create(ids.viewer, { shared: true, canShare: false }))).toBe(
      'SHARE_FORBIDDEN',
    );
  });

  it('ein Name je Besitzer und Bereich, ohne Groß-/Kleinschreibung', async () => {
    await create(ids.viewer, { name: 'Top' });
    expect(await errorCode(create(ids.viewer, { name: 'TOP' }))).toBe('NAME_TAKEN');
    await create(ids.admin, { name: 'Top' });
    await create(ids.viewer, {
      name: 'Top',
      area: 'explorer',
      state: { filters: filters(), explorer: explorer() },
    });
  });

  it('Nicht-Mitglieder legen nichts an', async () => {
    expect(await errorCode(create(ids.outsider))).toBe('NOT_FOUND');
  });

  it('schreibt ein Audit-Event mit handelndem Nutzer', async () => {
    const view = await create(ids.editor, { shared: true });
    const [event] = await testDb.db.select().from(auditEvents);
    expect(event).toMatchObject({
      organizationId: ids.org,
      actorUserId: ids.editor,
      action: 'saved_view.create',
      target: {
        type: 'saved_view',
        id: view.id,
        name: 'Meine Ansicht',
        area: 'dashboard',
        shared: true,
      },
    });
  });
});

describe('Access-Layer beim Speichern und Laden (ADR 002)', () => {
  it('entfernt ausgeblendete und fremde Profile, Clients und Drill-Down-IDs und zählt sie', async () => {
    const view = await create(ids.admin, {
      area: 'explorer',
      state: {
        filters: filters({
          clientIds: [ids.clientA, ids.clientForeign],
          profileIds: [ids.de, ids.hidden, ids.foreign],
        }),
        explorer: explorer({ campaignId: ids.campaignHidden, portfolioId: ids.portfolioDe }),
      },
    });
    expect(view.state.filters.clientIds).toEqual([ids.clientA]);
    expect(view.state.filters.profileIds).toEqual([ids.de]);
    expect(view.state.explorer?.drill).toEqual({
      portfolioId: ids.portfolioDe,
      campaignId: null,
      adGroupId: null,
    });
    expect(view.hiddenItems).toBe(4);
    // Gespeichert wird nur Sichtbares.
    const [row] = await testDb.db.select({ state: savedViews.state }).from(savedViews);
    expect(JSON.stringify(row!.state)).not.toContain(ids.hidden);
    expect(JSON.stringify(row!.state)).not.toContain(ids.foreign);
  });

  it('filtert beim Laden auch nachträglich ausgeblendete Profile', async () => {
    const view = await create(ids.editor, {
      shared: true,
      area: 'explorer',
      state: {
        filters: filters({ clientIds: [ids.clientA], profileIds: [ids.de] }),
        explorer: explorer({ campaignId: ids.campaignDe, adGroupId: ids.adGroupDe }),
      },
    });
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, ids.de));
    try {
      const loaded = await getSavedView(testDb.db, { ...as(ids.viewer), id: view.id });
      expect(loaded?.state.filters.profileIds).toBeNull();
      expect(loaded?.state.filters.clientIds).toEqual([]);
      expect(loaded?.state.explorer?.drill).toEqual({
        portfolioId: null,
        campaignId: null,
        adGroupId: null,
      });
      expect(loaded?.hiddenItems).toBe(4);
      const [listed] = await listSavedViews(testDb.db, { ...as(ids.viewer), area: 'explorer' });
      expect(listed?.state.filters.profileIds).toBeNull();
    } finally {
      await testDb.db
        .update(amazonAdsProfiles)
        .set({ isHidden: false })
        .where(eq(amazonAdsProfiles.id, ids.de));
    }
  });

  it('lässt fremde Drill-Down-IDs auch ohne Profilauswahl nicht durch', async () => {
    const view = await create(ids.admin, {
      area: 'explorer',
      state: { filters: filters(), explorer: explorer({ campaignId: ids.campaignForeign }) },
    });
    expect(view.state.explorer?.drill.campaignId).toBeNull();
  });
});

describe('Ändern und Löschen', () => {
  it('Besitzer benennt um und übernimmt den Zustand; Audit mit vorher/nachher', async () => {
    const view = await create(ids.viewer, { canShare: false });
    const updated = await updateSavedView(testDb.db, {
      ...as(ids.viewer),
      id: view.id,
      canShare: false,
      patch: { name: 'Neu', state: { filters: filters({ comparison: 'off' }) } },
    });
    expect(updated).toMatchObject({ name: 'Neu', state: { filters: { comparison: 'off' } } });
    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'saved_view.update'));
    expect(event).toMatchObject({
      actorUserId: ids.viewer,
      target: {
        type: 'saved_view',
        id: view.id,
        before: { name: 'Meine Ansicht', shared: false },
        after: { name: 'Neu', shared: false },
        stateChanged: true,
      },
    });
  });

  it('andere Mitglieder ändern freigegebene Ansichten nicht, Org-Admins schon', async () => {
    const view = await create(ids.editor, { shared: true });
    const patch = (userId: string) =>
      updateSavedView(testDb.db, {
        ...as(userId),
        id: view.id,
        canShare: true,
        patch: { name: 'X' },
      });
    expect(await errorCode(patch(ids.viewer))).toBe('FORBIDDEN');
    expect(await errorCode(deleteSavedView(testDb.db, { ...as(ids.viewer), id: view.id }))).toBe(
      'FORBIDDEN',
    );
    expect((await patch(ids.admin)).name).toBe('X');
    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'saved_view.update'));
    expect(event?.actorUserId).toBe(ids.admin);
  });

  it('persönliche Ansichten anderer bleiben unsichtbar, auch für Admins', async () => {
    const view = await create(ids.viewer, { canShare: false });
    expect(
      await errorCode(
        updateSavedView(testDb.db, {
          ...as(ids.admin),
          id: view.id,
          canShare: true,
          patch: { name: 'X' },
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(await errorCode(deleteSavedView(testDb.db, { ...as(ids.admin), id: view.id }))).toBe(
      'NOT_FOUND',
    );
  });

  it('freigeben nur mit Schreibrecht, zurücknehmen darf der Besitzer immer', async () => {
    const view = await create(ids.editor, { shared: true });
    const unshared = await updateSavedView(testDb.db, {
      ...as(ids.editor),
      id: view.id,
      canShare: false,
      patch: { shared: false },
    });
    expect(unshared.shared).toBe(false);
    expect(
      await errorCode(
        updateSavedView(testDb.db, {
          ...as(ids.editor),
          id: view.id,
          canShare: false,
          patch: { shared: true },
        }),
      ),
    ).toBe('SHARE_FORBIDDEN');
  });

  it('Explorer-Teil bleibt beim Bereich: falscher Zustand wird abgelehnt', async () => {
    const view = await create(ids.viewer);
    expect(
      await errorCode(
        updateSavedView(testDb.db, {
          ...as(ids.viewer),
          id: view.id,
          canShare: false,
          patch: { state: { filters: filters(), explorer: explorer() } },
        }),
      ),
    ).toBe('INVALID_STATE');
  });

  it('Umbenennen auf einen vergebenen Namen scheitert', async () => {
    await create(ids.viewer, { name: 'A' });
    const b = await create(ids.viewer, { name: 'B' });
    expect(
      await errorCode(
        updateSavedView(testDb.db, {
          ...as(ids.viewer),
          id: b.id,
          canShare: false,
          patch: { name: 'a' },
        }),
      ),
    ).toBe('NAME_TAKEN');
  });

  it('Löschen schreibt ein Audit-Event', async () => {
    const view = await create(ids.editor, { shared: true });
    await deleteSavedView(testDb.db, { ...as(ids.admin), id: view.id });
    expect(await testDb.db.select().from(savedViews).where(eq(savedViews.id, view.id))).toEqual([]);
    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, 'saved_view.delete'), eq(auditEvents.actorUserId, ids.admin)),
      );
    expect(event?.target).toMatchObject({ type: 'saved_view', id: view.id, name: 'Meine Ansicht' });
  });
});
