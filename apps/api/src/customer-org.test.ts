import { schema } from '@profitbash/db';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ErrorResponse, MeResponse } from '@profitbash/shared';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  type TestContext,
} from './testing';

/**
 * Kunden-Login über **alle** registrierten Routen (`phase-6.md`, Definition of Done, fail-closed): Was nicht
 * ausdrücklich freigegeben ist, antwortet mit 403, auch jede neue Route. Wer eine Route für Kunden öffnet, trägt
 * sie hier ein und schreibt den Test mit zweitem Client dazu.
 */

/** Ohne Session erreichbar bzw. mit eigener Prüfung; hängen nicht an der aktiven Organisation. */
const PUBLIC = [
  /^(GET|POST) \/api\/auth\/\*$/,
  /^GET \/api\/health$/,
  /^GET \/api\/openapi\.json$/,
  /^POST \/api\/password-links\/(inspect|redeem)$/,
  // Der Callback nimmt die Organisation aus dem signierten `state` (nur Org-Admins können ihn erzeugen).
  /^GET \/api\/amazon\/oauth\/(callback|mock-consent)$/,
];

/** Für Kunden-Logins freigegeben. Persönliche Einstellungen gehören dem Nutzer, nicht der Agentur. */
const OPEN_FOR_CUSTOMERS = [
  'GET /api/me',
  'GET /api/settings',
  'PUT /api/settings',
  'GET /api/settings/ui-state/:scope/:key',
  'PUT /api/settings/ui-state/:scope/:key',
  // Dashboard und Explorer (6.3b), je Endpunkt mit zweitem Client geprüft in `routes/analytics-customer.test.ts`.
  'POST /api/ads/filter-options',
  'POST /api/ads/dashboard',
  'POST /api/ads/explorer/rows',
  'POST /api/ads/timeseries',
];

let ctx: TestContext;
let cookie: string;
const ids = { customerOrg: '', nord: '', sued: '', suedProfile: '' };

beforeAll(async () => {
  ctx = await createTestContext();
  const { db } = ctx.testDb;
  const agency = ctx.seeded.organizationId;
  const [customerOrg] = await db
    .insert(schema.organizations)
    .values({
      name: 'Nordwind GmbH',
      slug: 'nordwind-kunde',
      type: 'client',
      createdAt: new Date(),
    })
    .returning({ id: schema.organizations.id });
  ids.customerOrg = customerOrg!.id;
  // Alle Features gebucht und die Rolle falsch auf admin gesetzt: Beides darf für Kunden nichts öffnen.
  await db
    .insert(schema.orgEntitlements)
    .values(
      (
        await db
          .select({ feature: schema.orgEntitlements.feature })
          .from(schema.orgEntitlements)
          .where(eq(schema.orgEntitlements.organizationId, agency))
      ).map(({ feature }) => ({ organizationId: ids.customerOrg, feature, enabled: true })),
    );
  await createUser(ctx, {
    email: 'kim@nordwind.test',
    org: { id: ids.customerOrg, role: 'admin' },
  });

  const [nord, sued] = await db
    .insert(schema.clients)
    .values([
      {
        organizationId: agency,
        name: 'Nordwind',
        slug: 'nordwind',
        clientOrganizationId: ids.customerOrg,
      },
      { organizationId: agency, name: 'Südhang', slug: 'suedhang' },
    ])
    .returning({ id: schema.clients.id });
  ids.nord = nord!.id;
  ids.sued = sued!.id;
  const [profile] = await db
    .insert(schema.amazonAdsProfiles)
    .values({
      organizationId: agency,
      clientId: ids.sued,
      accountName: 'Konto Südhang',
      countryCode: 'DE',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      accountType: 'seller',
    })
    .returning({ id: schema.amazonAdsProfiles.id });
  ids.suedProfile = profile!.id;

  cookie = await signIn(ctx, 'kim@nordwind.test');
});

afterAll(async () => {
  await ctx?.close();
});

function registeredRoutes(): { method: string; path: string }[] {
  const seen = new Map<string, { method: string; path: string }>();
  for (const { method, path } of ctx.app.routes) {
    // `ALL` sind Middlewares (`app.use`), keine Endpunkte.
    if (method !== 'ALL') seen.set(`${method} ${path}`, { method, path });
  }
  return [...seen.values()];
}

describe('Kunden-Login', () => {
  it('/api/me nennt den Typ der Organisation, die Rolle viewer und nirgends write', async () => {
    const body = await readJson<MeResponse>(await request(ctx, '/api/me', { cookie }));
    expect(body.organizations).toEqual([
      {
        id: ids.customerOrg,
        name: 'Nordwind GmbH',
        slug: 'nordwind-kunde',
        type: 'client',
        role: 'viewer',
      },
    ]);
    const rights = Object.values(body.features);
    expect(rights.some((feature) => feature.view)).toBe(true);
    expect(rights.every((feature) => !feature.write)).toBe(true);
  });

  it('jede nicht freigegebene Route antwortet mit 403 und verrät nichts über andere Clients', async () => {
    const { db } = ctx.testDb;
    const auditBefore = await db.select({ n: count() }).from(schema.auditEvents);
    const routes = registeredRoutes().filter(
      ({ method, path }) => !PUBLIC.some((pattern) => pattern.test(`${method} ${path}`)),
    );
    // Sonst prüfte der Test bei geänderter Registrierung stillschweigend nichts mehr.
    expect(routes.length).toBeGreaterThan(100);
    const registered = routes.map(({ method, path }) => `${method} ${path}`);
    for (const open of OPEN_FOR_CUSTOMERS) expect(registered).toContain(open);

    const notForbidden: string[] = [];
    for (const { method, path } of routes) {
      const key = `${method} ${path}`;
      if (OPEN_FOR_CUSTOMERS.includes(key)) continue;
      // Platzhalter mit einer echten ID der Agentur füllen: Ein Leck fiele damit auf.
      const url = path.replace(':clientId', ids.sued).replace(/:[A-Za-z]+/g, ids.suedProfile);
      const res = await request(ctx, url, {
        method,
        cookie,
        json: method === 'GET' ? undefined : {},
      });
      const text = await res.text();
      expect(text, key).not.toContain('Südhang');
      if (res.status !== 403) {
        notForbidden.push(`${key} → ${res.status}`);
        continue;
      }
      expect((JSON.parse(text) as ErrorResponse).error.code, key).toBe('CUSTOMER_ORG_FORBIDDEN');
    }
    expect(notForbidden).toEqual([]);
    expect(await db.select({ n: count() }).from(schema.auditEvents)).toEqual(auditBefore);
  });

  it('nach dem Wechsel in eine Agentur-Org gilt die Sperre nicht mehr', async () => {
    const admin = await signIn(ctx, ctx.seeded.email);
    expect((await request(ctx, '/api/clients', { cookie: admin })).status).toBe(200);
  });
});
