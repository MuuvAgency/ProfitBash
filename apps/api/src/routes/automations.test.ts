import { schema } from '@profitbash/db';
import { seedAdChangeFixture, type AdChangeFixture } from '@profitbash/db/testing';
import {
  DEFAULT_AUTOMATION_RULES,
  DEFAULT_GUARDRAILS,
  type AutomationRulesResponse,
  type AutomationSettings,
  type ErrorResponse,
} from '@profitbash/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  type TestContext,
} from '../testing';

const {
  amazonAdsProfiles,
  auditEvents,
  automationDefaults,
  automationRules,
  clientAutomationSettings,
  clients,
  orgEntitlements,
} = schema;

/**
 * Einstellungen der Automatik über die API (`phase-5.md` 5.4). Je Endpunkt: Recht `write`, Admin für die
 * Startwerte, fremde Organisation, ausgeblendetes Profil, Entitlement.
 */

let ctx: TestContext;
let f: AdChangeFixture;
let other: AdChangeFixture;
let client = '';
let editorId = '';
let admin = '';
let editor = '';
let viewer = '';
let foreign = '';

async function call<T>(method: string, path: string, cookie?: string, json?: unknown) {
  const res = await request(ctx, `/api/ads/automations${path}`, { method, cookie, json });
  return { status: res.status, body: await readJson<T & ErrorResponse>(res) };
}
const settings = (cookie?: string) => call<AutomationSettings>('GET', '/settings', cookie);
const putDefaults = (cookie: string | undefined, guardrails: unknown = DEFAULT_GUARDRAILS) =>
  call<AutomationSettings>('PUT', '/settings/defaults', cookie, guardrails);
const putClient = (cookie: string | undefined, body: Record<string, unknown> = {}, id = client) =>
  call<AutomationSettings>('PUT', `/settings/clients/${id}`, cookie, {
    mode: 'shadow',
    responsibleUserId: null,
    overrides: {},
    ...body,
  });
const hide = (isHidden: boolean) =>
  ctx.testDb.db
    .update(amazonAdsProfiles)
    .set({ isHidden })
    .where(eq(amazonAdsProfiles.id, f.profile));

beforeAll(async () => {
  ctx = await createTestContext();
  const { db } = ctx.testDb;
  const orgId = ctx.seeded.organizationId;
  const editorUser = await createUser(ctx, {
    email: 'editor@muuv.test',
    org: { id: orgId, role: 'editor' },
  });
  editorId = editorUser.id;
  await createUser(ctx, { email: 'viewer@muuv.test', org: { id: orgId, role: 'viewer' } });
  f = await seedAdChangeFixture(db, 'muuv-api', {
    org: orgId,
    ada: ctx.seeded.userId,
    emil: editorUser.id,
  });
  other = await seedAdChangeFixture(db, 'fremd-automatik');
  await db.insert(orgEntitlements).values({ organizationId: other.org, feature: 'automations' });
  await createUser(ctx, { email: 'fremd@andere.test', org: { id: other.org, role: 'admin' } });
  const [kunde] = await db
    .insert(clients)
    .values({ organizationId: orgId, name: 'Kunde', slug: 'kunde-automatik' })
    .returning({ id: clients.id });
  client = kunde!.id;
  await db
    .update(amazonAdsProfiles)
    .set({ clientId: client })
    .where(eq(amazonAdsProfiles.id, f.profile));
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
  viewer = await signIn(ctx, 'viewer@muuv.test');
  foreign = await signIn(ctx, 'fremd@andere.test');
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.testDb.db.delete(clientAutomationSettings);
  await ctx.testDb.db.delete(automationDefaults);
  await ctx.testDb.db.delete(automationRules);
  await hide(false);
});

describe('Einstellungen der Automatik (/api/ads/automations/settings)', () => {
  it('liefert Startwerte, Clients und Mitglieder mit Schreibrecht; auch für Viewer', async () => {
    const res = await settings(viewer);
    expect(res.status).toBe(200);
    expect(res.body.defaults).toEqual(DEFAULT_GUARDRAILS);
    expect(res.body.canEditDefaults).toBe(false);
    expect(res.body.clients).toEqual([
      { id: client, name: 'Kunde', mode: 'shadow', responsibleUserId: null, overrides: {} },
    ]);
    expect(res.body.members.map((m) => m.userId).sort()).toEqual(
      [ctx.seeded.userId, editorId].sort(),
    );
    expect((await settings()).status).toBe(401);
  });

  it('Startwerte der Organisation ändern nur Admins', async () => {
    const guardrails = { ...DEFAULT_GUARDRAILS, maxBidChangePercent: 10, maxBidEur: '2,50' };
    const saved = await putDefaults(admin, guardrails);
    expect(saved.status).toBe(200);
    expect(saved.body.defaults).toMatchObject({ maxBidChangePercent: 10, maxBidEur: '2.50' });
    expect(saved.body.canEditDefaults).toBe(true);

    const denied = await putDefaults(editor);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('AUTOMATION_DEFAULTS_FORBIDDEN');
    expect((await putDefaults(viewer)).status).toBe(403);
    expect((await settings(editor)).body.defaults.maxBidChangePercent).toBe(10);
    // Die andere Organisation behält ihre Startwerte.
    expect((await settings(foreign)).body.defaults).toEqual(DEFAULT_GUARDRAILS);
  });

  it('prüft die Leitplanken', async () => {
    for (const patch of [{ maxBidChangePercent: 0 }, { maxBidEur: '-1' }, { unbekannt: 1 }]) {
      const res = await putDefaults(admin, { ...DEFAULT_GUARDRAILS, ...patch });
      expect(res.status).toBe(400);
    }
  });

  it('Editoren setzen Modus, zuständigen Nutzer und Werte eines Clients; Viewer nicht', async () => {
    const saved = await putClient(editor, { mode: 'cart', overrides: { minClicks: 30 } });
    expect(saved.status).toBe(200);
    expect(saved.body.clients).toEqual([
      {
        id: client,
        name: 'Kunde',
        mode: 'cart',
        responsibleUserId: editorId,
        overrides: { minClicks: 30 },
      },
    ]);
    expect((await putClient(viewer)).status).toBe(403);
    const events = await ctx.testDb.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, ctx.seeded.organizationId),
          eq(auditEvents.action, 'client_automation.update'),
        ),
      );
    expect(events.length).toBeGreaterThan(0);
  });

  it('lehnt zuständige Nutzer ohne Schreibrecht, fremde Clients und ausgeblendete Profile ab', async () => {
    const invalid = await putClient(editor, { mode: 'cart', responsibleUserId: other.ada });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('AUTOMATION_INVALID_RESPONSIBLE');

    const fromOutside = await putClient(foreign);
    expect(fromOutside.status).toBe(404);
    expect(fromOutside.body.error.code).toBe('CLIENT_NOT_FOUND');

    await hide(true);
    expect((await putClient(editor)).status).toBe(404);
    expect((await settings(editor)).body.clients).toEqual([]);
    expect(await ctx.testDb.db.select().from(clientAutomationSettings)).toHaveLength(0);
  });

  it('braucht das Feature automations', async () => {
    const where = and(
      eq(orgEntitlements.organizationId, ctx.seeded.organizationId),
      eq(orgEntitlements.feature, 'automations'),
    );
    await ctx.testDb.db.delete(orgEntitlements).where(where);
    try {
      expect((await settings(admin)).status).toBe(403);
      expect((await putDefaults(admin)).status).toBe(403);
      expect((await putClient(admin)).status).toBe(403);
    } finally {
      await ctx.testDb.db
        .insert(orgEntitlements)
        .values({ organizationId: ctx.seeded.organizationId, feature: 'automations' });
    }
  });
});

describe('Regeln der Automatik (/api/ads/automations/rules)', () => {
  const rules = (cookie?: string) => call<AutomationRulesResponse>('GET', '/rules', cookie);
  const putRules = (cookie: string | undefined, list: unknown, version = 0) =>
    call<AutomationRulesResponse>('PUT', '/rules', cookie, { rules: list, version });
  const own = { ...DEFAULT_AUTOMATION_RULES[0]!, name: 'Eigene Regel' };

  it('liefert die Startregeln; Editoren speichern, Viewer lesen nur', async () => {
    const initial = await rules(viewer);
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({ rules: DEFAULT_AUTOMATION_RULES, version: 0, updatedAt: null });

    const saved = await putRules(editor, [{ ...own, clientId: client }]);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ version: 1, rules: [{ name: 'Eigene Regel' }] });
    expect(typeof saved.body.updatedAt).toBe('string');
    expect((await putRules(viewer, [], 1)).status).toBe(403);
    expect((await rules()).status).toBe(401);
    // Die andere Organisation sieht ihre eigenen (Start-)Regeln.
    expect((await rules(foreign)).body.version).toBe(0);
  });

  it('meldet veraltete Versionen, fremde Clients und ungültige Regeln', async () => {
    await putRules(admin, [own]);
    const stale = await putRules(editor, [], 0);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('AUTOMATION_RULES_VERSION_CONFLICT');

    const fromOutside = await putRules(foreign, [{ ...own, clientId: client }]);
    expect(fromOutside.status).toBe(400);
    expect(fromOutside.body.error.code).toBe('AUTOMATION_RULES_UNKNOWN_CLIENT');

    expect((await putRules(admin, [{ ...own, conditions: [] }], 1)).status).toBe(400);
    expect((await putRules(admin, [{ ...own, level: 'campaign' }], 1)).status).toBe(400);
  });

  it('Vorschau: zählt je Regel, speichert nichts und braucht nur „view“', async () => {
    const res = await call<{ counts: { ruleId: string; entities: number }[] }>(
      'POST',
      '/rules/preview',
      viewer,
      { rules: [own] },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      counts: [{ ruleId: own.id, entities: 0 }],
      targets: 0,
      campaigns: 0,
    });
    expect(await ctx.testDb.db.select().from(automationRules)).toHaveLength(0);
    expect(
      (await call('POST', '/rules/preview', viewer, { rules: [{ ...own, name: '' }] })).status,
    ).toBe(400);
    expect((await call('POST', '/rules/preview', undefined, { rules: [] })).status).toBe(401);
  });
});
