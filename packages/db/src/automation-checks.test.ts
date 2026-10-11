import { DEFAULT_CHECK_SETTINGS } from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import { AutomationError } from './automation';
import {
  acknowledgeAutomationFindings,
  getAutomationChecks,
  loadCheckSettings,
  saveCheckSettings,
  syncAutomationFindings,
  type FindingInput,
} from './automation-checks';
import {
  amazonAdsProfiles,
  auditEvents,
  automationCheckSettings,
  automationFindings,
  users,
} from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

/** Prüfungen (`phase-5.md` 5.10): Einstellungen je Organisation, Befunde je Profil, quittieren. */

let testDb: TestDatabase;
let f: AdChangeFixture;
let other: AdChangeFixture;
let stranger = '';

const T1 = new Date('2026-10-10T08:00:00Z');
const T2 = new Date('2026-10-17T08:00:00Z');
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
const vcpm = (): FindingInput => ({
  kind: 'vcpm',
  entityType: 'campaign',
  entityId: f.campaign,
  campaignId: f.campaign,
  key: '',
  detail: {},
});
const noOrders = (spend = '40'): FindingInput => ({
  kind: 'spendNoOrders',
  entityType: 'target',
  entityId: f.keyword,
  campaignId: f.campaign,
  key: '',
  detail: { spend, clicks: 80 },
});
const noCap = (): FindingInput => ({
  kind: 'noCap',
  entityType: 'profile',
  entityId: f.profile,
  campaignId: null,
  key: '',
  detail: { campaigns: 1 },
});
const sync = (findings: FindingInput[], now = T1, x = f) =>
  syncAutomationFindings(testDb.db, {
    organizationId: x.org,
    profileId: x.profile,
    findings,
    now,
  });
const list = async (status: 'open' | 'acknowledged' = 'open', actor = as(f.emil)) =>
  (await getAutomationChecks(testDb.db, { ...actor, status }))!;

beforeAll(async () => {
  testDb = await createTestDatabase();
  f = await seedAdChangeFixture(testDb.db);
  other = await seedAdChangeFixture(testDb.db, 'andere');
  const [niemand] = await testDb.db
    .insert(users)
    .values({ name: 'Niemand', email: 'niemand@nirgends.test' })
    .returning({ id: users.id });
  stranger = niemand!.id;
});
afterAll(() => testDb?.close());

beforeEach(async () => {
  const { db } = testDb;
  await db.delete(automationFindings);
  await db.delete(automationCheckSettings);
  await db.delete(auditEvents);
  await db.update(amazonAdsProfiles).set({ isHidden: false });
});

describe('Einstellungen der Prüfungen', () => {
  it('ohne Zeile die Startwerte; Admins speichern mit Audit, ohne Änderung nichts', async () => {
    expect(await loadCheckSettings(testDb.db, f.org)).toEqual(DEFAULT_CHECK_SETTINGS);
    const settings = {
      ...DEFAULT_CHECK_SETTINGS,
      enabled: { ...DEFAULT_CHECK_SETTINGS.enabled, noCap: false },
      placementMinPercent: 100,
    };

    expect(await saveCheckSettings(testDb.db, { ...as(f.ada), settings })).toEqual(settings);
    await saveCheckSettings(testDb.db, { ...as(f.ada), settings });
    expect(await loadCheckSettings(testDb.db, f.org)).toEqual(settings);
    expect(await loadCheckSettings(testDb.db, other.org)).toEqual(DEFAULT_CHECK_SETTINGS);
    const events = await testDb.db.select().from(auditEvents);
    expect(events).toMatchObject([
      {
        action: 'automation_checks.update',
        actorUserId: f.ada,
        target: { before: DEFAULT_CHECK_SETTINGS, after: settings },
      },
    ]);
    expect((await list()).settings).toEqual(settings);
    expect((await list('open', as(f.ada))).canEditSettings).toBe(true);
    expect((await list()).canEditSettings).toBe(false);
  });

  it('nur Admins; kein Mitglied: null', async () => {
    const input = { settings: DEFAULT_CHECK_SETTINGS };
    expect(await code(saveCheckSettings(testDb.db, { ...as(f.emil), ...input }))).toBe('FORBIDDEN');
    expect(await saveCheckSettings(testDb.db, { ...as(stranger), ...input })).toBeNull();
    expect(await getAutomationChecks(testDb.db, { ...as(stranger), status: 'open' })).toBeNull();
  });
});

describe('syncAutomationFindings', () => {
  it('legt neue Befunde an, hält bestehende (mit Quittung) und löscht verschwundene', async () => {
    expect(await sync([vcpm(), noOrders(), noCap()])).toEqual({
      total: 3,
      added: 3,
      addedWarnings: 2,
    });
    const [first] = (await list()).findings.filter((x) => x.kind === 'spendNoOrders');
    await acknowledgeAutomationFindings(testDb.db, { ...as(f.emil), ids: [first!.id] });

    // Derselbe Befund mit neuen Zahlen bleibt derselbe und quittiert; der vCPM-Befund ist weg.
    expect(await sync([noOrders('55'), noCap()], T2)).toEqual({
      total: 2,
      added: 0,
      addedWarnings: 0,
    });
    const [kept] = (await list('acknowledged')).findings;
    expect(kept).toMatchObject({
      id: first!.id,
      detail: { spend: '55' },
      firstSeenAt: T1,
      acknowledgedAt: expect.any(Date),
    });
    expect((await list()).findings.map((x) => x.kind)).toEqual(['noCap']);

    // Verschwunden und wieder da: neu und offen.
    await sync([noCap()], T2);
    expect(await sync([noOrders(), noCap()], T2)).toEqual({ total: 2, added: 1, addedWarnings: 1 });
    expect((await list('acknowledged')).findings).toEqual([]);
    expect((await list()).findings.find((x) => x.kind === 'spendNoOrders')!.id).not.toBe(first!.id);
  });

  it('berührt die Befunde anderer Profile nicht', async () => {
    await sync([vcpm()]);
    await sync([], T1, other);
    expect((await list()).findings).toHaveLength(1);
  });
});

describe('getAutomationChecks und quittieren', () => {
  it('listet Befunde sichtbarer Profile mit Namen, Warnungen zuerst', async () => {
    await sync([noCap(), noOrders(), vcpm()]);
    const result = await list();

    expect(result.total).toBe(3);
    expect(result.findings.map((x) => [x.kind, x.severity])).toEqual([
      ['spendNoOrders', 'warning'],
      ['vcpm', 'warning'],
      ['noCap', 'info'],
    ]);
    expect(result.findings[1]).toMatchObject({
      profileId: f.profile,
      accountName: 'Nordwind DE',
      currencyCode: 'EUR',
      entityType: 'campaign',
      campaignName: 'Kampagne 1001',
      keywordText: null,
      acknowledgedAt: null,
    });
    expect(result.findings[0]).toMatchObject({
      entityType: 'target',
      campaignName: 'Kampagne 1001',
      keywordText: expect.any(String),
    });
    expect((await list('open', as(other.ada, other.org))).findings).toEqual([]);
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, f.profile));
    expect((await list()).findings).toEqual([]);
  });

  it('quittiert offene Befunde mit Audit; fremde, unsichtbare und schon quittierte zählen nicht', async () => {
    await sync([vcpm(), noOrders()]);
    const ids = (await list()).findings.map((x) => x.id);

    expect(
      await acknowledgeAutomationFindings(testDb.db, { ...as(other.ada, other.org), ids }),
    ).toEqual({ changed: 0, skipped: 2 });
    expect(await acknowledgeAutomationFindings(testDb.db, { ...as(f.emil), ids })).toEqual({
      changed: 2,
      skipped: 0,
    });
    expect(await acknowledgeAutomationFindings(testDb.db, { ...as(f.ada), ids })).toEqual({
      changed: 0,
      skipped: 2,
    });
    expect((await list('acknowledged')).findings).toHaveLength(2);
    expect(await testDb.db.select().from(auditEvents)).toMatchObject([
      { action: 'automation_findings.acknowledge', actorUserId: f.emil, target: { count: 2 } },
    ]);
    expect(await acknowledgeAutomationFindings(testDb.db, { ...as(stranger), ids })).toBeNull();
  });
});
