import { DEFAULT_GUARDRAILS } from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import {
  AutomationError,
  getAutomationSettings,
  saveGuardrailDefaults,
  setClientAutomation,
} from './automation';
import {
  amazonAdsProfiles,
  auditEvents,
  automationDefaults,
  clientAutomationSettings,
  clients,
  members,
  users,
} from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

/** Leitplanken und Modus (`phase-5.md` 5.4): Startwerte der Organisation nur Admins, je Client mit Sichtbarkeit. */

let testDb: TestDatabase;
let f: AdChangeFixture;
let other: AdChangeFixture;
let client = '';
let emptyClient = '';
let otherClient = '';
let stranger = '';
let viewer = '';

const as = (userId: string, orgId = f.org) => ({ userId, orgId });
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AutomationError) return err.code;
    throw err;
  }
  return null;
};
const setClient = (
  input: Partial<Parameters<typeof setClientAutomation>[1]> = {},
  actor = as(f.emil),
) =>
  setClientAutomation(testDb.db, {
    ...actor,
    clientId: client,
    mode: 'shadow',
    responsibleUserId: null,
    overrides: {},
    ...input,
  });

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  f = await seedAdChangeFixture(db);
  other = await seedAdChangeFixture(db, 'andere');
  const [kunde, leer, fremd] = await db
    .insert(clients)
    .values([
      { organizationId: f.org, name: 'Kunde', slug: 'kunde' },
      { organizationId: f.org, name: 'Leer', slug: 'leer' },
      { organizationId: other.org, name: 'Fremd', slug: 'fremd' },
    ])
    .returning({ id: clients.id });
  client = kunde!.id;
  emptyClient = leer!.id;
  otherClient = fremd!.id;
  await db
    .update(amazonAdsProfiles)
    .set({ clientId: client })
    .where(eq(amazonAdsProfiles.id, f.profile));
  await db
    .update(amazonAdsProfiles)
    .set({ clientId: otherClient })
    .where(eq(amazonAdsProfiles.id, other.profile));
  const [niemand, vera] = await db
    .insert(users)
    .values([
      { name: 'Niemand', email: 'niemand@nirgends.test' },
      { name: 'Vera', email: 'vera@muuv.test' },
    ])
    .returning({ id: users.id });
  stranger = niemand!.id;
  viewer = vera!.id;
  await db
    .insert(members)
    .values({ organizationId: f.org, userId: viewer, role: 'viewer', createdAt: new Date() });
});

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  const { db } = testDb;
  await db.delete(clientAutomationSettings);
  await db.delete(automationDefaults);
  await db.delete(auditEvents);
  await db.update(amazonAdsProfiles).set({ isHidden: false });
});

describe('getAutomationSettings', () => {
  it('liefert ohne gespeicherte Werte die Startwerte, Modus shadow und die Mitglieder mit Schreibrecht', async () => {
    const settings = (await getAutomationSettings(testDb.db, as(f.emil)))!;
    expect(settings).toEqual({
      defaults: DEFAULT_GUARDRAILS,
      canEditDefaults: false,
      clients: [
        { id: client, name: 'Kunde', mode: 'shadow', responsibleUserId: null, overrides: {} },
      ],
      members: [
        { userId: f.ada, name: 'Ada' },
        { userId: f.emil, name: 'Emil' },
      ],
    });
    expect((await getAutomationSettings(testDb.db, as(f.ada)))!.canEditDefaults).toBe(true);
  });

  it('liefert null für Nicht-Mitglieder', async () => {
    expect(await getAutomationSettings(testDb.db, as(stranger))).toBeNull();
  });
});

describe('saveGuardrailDefaults', () => {
  const guardrails = { ...DEFAULT_GUARDRAILS, maxBidChangePercent: 10, maxBidEur: null };

  it('speichert als Admin und schreibt ein Audit-Event mit vorher und nachher', async () => {
    await saveGuardrailDefaults(testDb.db, { ...as(f.ada), guardrails });
    await saveGuardrailDefaults(testDb.db, { ...as(f.ada), guardrails: DEFAULT_GUARDRAILS });

    expect((await getAutomationSettings(testDb.db, as(f.emil)))!.defaults).toEqual(
      DEFAULT_GUARDRAILS,
    );
    const events = await testDb.db.select().from(auditEvents).orderBy(auditEvents.createdAt);
    expect(events.map((e) => e.action)).toEqual([
      'automation_defaults.update',
      'automation_defaults.update',
    ]);
    expect(events[0]!.target).toMatchObject({ before: DEFAULT_GUARDRAILS, after: guardrails });
    expect(events[1]!.target).toMatchObject({ before: guardrails, after: DEFAULT_GUARDRAILS });
  });

  it('lehnt Editoren ab und liefert null für Nicht-Mitglieder', async () => {
    expect(await code(saveGuardrailDefaults(testDb.db, { ...as(f.emil), guardrails }))).toBe(
      'FORBIDDEN',
    );
    expect(await saveGuardrailDefaults(testDb.db, { ...as(stranger), guardrails })).toBeNull();
    expect(await testDb.db.select().from(automationDefaults)).toHaveLength(0);
  });

  it('wirkt nicht auf andere Organisationen', async () => {
    await saveGuardrailDefaults(testDb.db, { ...as(f.ada), guardrails });
    expect((await getAutomationSettings(testDb.db, as(other.ada, other.org)))!.defaults).toEqual(
      DEFAULT_GUARDRAILS,
    );
  });
});

describe('setClientAutomation', () => {
  it('speichert Modus und überschriebene Werte als Editor, mit Audit', async () => {
    await setClient({ mode: 'off', overrides: { maxBidChangePercent: 10, maxBidEur: null } });

    const settings = (await getAutomationSettings(testDb.db, as(f.ada)))!;
    expect(settings.clients).toEqual([
      {
        id: client,
        name: 'Kunde',
        mode: 'off',
        responsibleUserId: null,
        overrides: { maxBidChangePercent: 10, maxBidEur: null },
      },
    ]);
    const [event] = await testDb.db.select().from(auditEvents);
    expect(event).toMatchObject({ action: 'client_automation.update', actorUserId: f.emil });
    expect(event!.target).toMatchObject({
      type: 'client',
      id: client,
      before: { mode: 'shadow', responsibleUserId: null, overrides: {} },
      after: { mode: 'off', overrides: { maxBidChangePercent: 10, maxBidEur: null } },
    });
  });

  it('belegt den zuständigen Nutzer im Modus cart mit dem vor, der speichert', async () => {
    expect(await setClient({ mode: 'cart' })).toMatchObject({ responsibleUserId: f.emil });
    expect(await setClient({ mode: 'cart', responsibleUserId: f.ada })).toMatchObject({
      responsibleUserId: f.ada,
    });
  });

  it('lehnt zuständige Nutzer ohne Schreibrecht in der Organisation ab', async () => {
    for (const responsibleUserId of [viewer, stranger, other.ada]) {
      expect(await code(setClient({ mode: 'cart', responsibleUserId }))).toBe(
        'INVALID_RESPONSIBLE',
      );
    }
    expect(await testDb.db.select().from(clientAutomationSettings)).toHaveLength(0);
  });

  it('lehnt fremde Clients und Clients ohne sichtbares Profil ab', async () => {
    expect(await code(setClient({ clientId: otherClient }))).toBe('NOT_FOUND');
    expect(await code(setClient({ clientId: emptyClient }))).toBe('NOT_FOUND');
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, f.profile));
    expect(await code(setClient())).toBe('NOT_FOUND');
    expect(await testDb.db.select().from(auditEvents)).toHaveLength(0);
  });

  it('liefert null für Nicht-Mitglieder', async () => {
    expect(await setClient({}, as(stranger))).toBeNull();
  });
});
