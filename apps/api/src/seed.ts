import { schema, type Db } from '@profitbash/db';
import { FEATURE_KEYS } from '@profitbash/shared';
import { and, eq } from 'drizzle-orm';
import type { Auth } from './auth';

const { members, orgEntitlements, organizations, users } = schema;

export const SEED_ORG = { name: 'Muuv', slug: 'muuv', type: 'internal' } as const;

export interface SeedAdmin {
  email: string;
  password: string;
  name?: string;
}

export interface SeedResult {
  userId: string;
  organizationId: string;
  createdUser: boolean;
  createdOrganization: boolean;
}

/**
 * Legt die Grundausstattung an. Idempotent: Ein zweiter Lauf legt nichts doppelt an. Er stellt nur
 * sicher, dass Admin-Rollen und der Org-Typ stimmen.
 * - Admin-User (Plattform-Rolle `superadmin`) über die better-auth-API, nicht über den Signup
 * - Organisation „Muuv" (`type = internal`) mit dem Admin als Org-Admin
 * - fehlende Feature-Entitlements aktiv anlegen (bestehende bleiben, wie sie sind)
 *
 * Ein bestehendes Passwort wird nicht überschrieben.
 */
export async function seed({
  db,
  auth,
  admin,
}: {
  db: Db;
  auth: Auth;
  admin: SeedAdmin;
}): Promise<SeedResult> {
  const email = admin.email.trim().toLowerCase();

  // 1) Admin-User
  let createdUser = false;
  let [user] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) {
    const created = await auth.api.createUser({
      body: { email, password: admin.password, name: admin.name ?? 'Admin', role: 'superadmin' },
    });
    user = { id: created.user.id, role: 'superadmin' };
    createdUser = true;
  } else if (user.role !== 'superadmin') {
    await db.update(users).set({ role: 'superadmin' }).where(eq(users.id, user.id));
  }

  // 2) Organisation „Muuv"
  let createdOrganization = false;
  let [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, SEED_ORG.slug))
    .limit(1);

  if (!org) {
    const created = await auth.api.createOrganization({
      body: { name: SEED_ORG.name, slug: SEED_ORG.slug, userId: user.id },
    });
    if (!created) throw new Error('Organisation konnte nicht angelegt werden.');
    org = { id: created.id };
    createdOrganization = true;
  }
  // Der Typ ist für Clients schreibgeschützt (input: false) und wird deshalb serverseitig gesetzt.
  await db.update(organizations).set({ type: SEED_ORG.type }).where(eq(organizations.id, org.id));

  // 3) Mitgliedschaft als Org-Admin sicherstellen (falls die Org schon ohne ihn existierte)
  const [membership] = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.organizationId, org.id), eq(members.userId, user.id)))
    .limit(1);
  if (!membership) {
    await db
      .insert(members)
      .values({ organizationId: org.id, userId: user.id, role: 'admin', createdAt: new Date() });
  } else if (membership.role !== 'admin') {
    await db.update(members).set({ role: 'admin' }).where(eq(members.id, membership.id));
  }

  // 4) Fehlende Entitlements aktiv anlegen. Bewusst abgeschaltete bleiben abgeschaltet.
  await db
    .insert(orgEntitlements)
    .values(FEATURE_KEYS.map((feature) => ({ organizationId: org.id, feature, enabled: true })))
    .onConflictDoNothing({ target: [orgEntitlements.organizationId, orgEntitlements.feature] });

  return { userId: user.id, organizationId: org.id, createdUser, createdOrganization };
}
