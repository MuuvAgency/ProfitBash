import { DEFAULT_AUTOMATION_RULES, type AutomationRule } from '@profitbash/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import { AutomationError } from './automation';
import { getAutomationRules, saveAutomationRules } from './automation-rules';
import { auditEvents, automationRules, clients, users } from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

/** Regeln der Automatik (`phase-5.md` 5.6a): eine Liste je Organisation, Startregeln, Version, Audit. */

let testDb: TestDatabase;
let f: AdChangeFixture;
let other: AdChangeFixture;
let client = '';
let otherClient = '';
let stranger = '';

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
const rule = (patch: Partial<AutomationRule> = {}): AutomationRule => ({
  ...DEFAULT_AUTOMATION_RULES[0]!,
  id: '00000000-0000-4000-8000-0000000000f1',
  name: 'Eigene Regel',
  ...patch,
});
const save = (rules: AutomationRule[], version = 0, actor = as(f.emil)) =>
  saveAutomationRules(testDb.db, { ...actor, rules, version });

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  f = await seedAdChangeFixture(db);
  other = await seedAdChangeFixture(db, 'andere');
  const [kunde, fremd] = await db
    .insert(clients)
    .values([
      { organizationId: f.org, name: 'Kunde', slug: 'kunde' },
      { organizationId: other.org, name: 'Fremd', slug: 'fremd' },
    ])
    .returning({ id: clients.id });
  client = kunde!.id;
  otherClient = fremd!.id;
  const [niemand] = await db
    .insert(users)
    .values({ name: 'Niemand', email: 'niemand@nirgends.test' })
    .returning({ id: users.id });
  stranger = niemand!.id;
});

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  await testDb.db.delete(automationRules);
  await testDb.db.delete(auditEvents);
});

describe('Regeln der Automatik', () => {
  it('liefert ohne gespeicherte Regeln die Startregeln mit Version 0', async () => {
    expect(await getAutomationRules(testDb.db, as(f.emil))).toEqual({
      rules: DEFAULT_AUTOMATION_RULES,
      version: 0,
      updatedAt: null,
    });
    expect(await getAutomationRules(testDb.db, as(stranger))).toBeNull();
  });

  it('speichert die Liste in ihrer Reihenfolge, zählt die Version und schreibt ein Audit-Event', async () => {
    const first = [rule({ clientId: client }), ...DEFAULT_AUTOMATION_RULES];
    expect(await save(first)).toMatchObject({ version: 1, rules: first });
    const second = [DEFAULT_AUTOMATION_RULES[1]!];
    expect(await save(second, 1, as(f.ada))).toMatchObject({ version: 2 });

    expect(await getAutomationRules(testDb.db, as(f.emil))).toMatchObject({
      rules: second,
      version: 2,
    });
    // Eine leere Liste bleibt leer (keine Startregeln mehr).
    await save([], 2);
    expect((await getAutomationRules(testDb.db, as(f.emil)))!.rules).toEqual([]);

    const events = await testDb.db.select().from(auditEvents).orderBy(auditEvents.createdAt);
    expect(events.map((e) => [e.action, e.actorUserId])).toEqual([
      ['automation_rules.update', f.emil],
      ['automation_rules.update', f.ada],
      ['automation_rules.update', f.emil],
    ]);
    expect(events[1]!.target).toMatchObject({
      version: 2,
      before: { version: 1, rules: first },
      after: second,
    });
    // Andere Organisationen behalten ihre Regeln.
    expect((await getAutomationRules(testDb.db, as(other.ada, other.org)))!.version).toBe(0);
  });

  it('lehnt eine veraltete Version ab', async () => {
    await save([rule()]);
    expect(await code(save([], 0))).toBe('VERSION_CONFLICT');
    expect(await code(save([], 5))).toBe('VERSION_CONFLICT');
    expect((await getAutomationRules(testDb.db, as(f.emil)))!.rules).toHaveLength(1);
  });

  it('lehnt Regeln für Clients anderer Organisationen ab', async () => {
    expect(await code(save([rule({ clientId: otherClient })]))).toBe('UNKNOWN_CLIENT');
    expect(await testDb.db.select().from(automationRules)).toHaveLength(0);
  });

  it('liefert null für Nicht-Mitglieder', async () => {
    expect(await save([rule()], 0, as(stranger))).toBeNull();
  });
});
