import { CUSTOMER_ORG_FEATURES, slugify, type FeatureKey } from '@profitbash/shared';
import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import { isCustomerOrg } from './access';
import { recordAuditEvent, type DbOrTx } from './audit';
import type { Db } from './client';
import { clients, members, orgEntitlements, organizations, users } from './schema';

/**
 * Plattform-Admin (`phase-6.md` 6.4, F5): Organisationen, Entitlements und Staff über alle Organisationen hinweg.
 * Kein Org-Kontext: Die Routen rufen das nur hinter `requireSuperadmin()` auf. Jede Änderung schreibt ein
 * Audit-Event `platform.*`, bei Organisationen mit der betroffenen Organisation, bei Staff ohne (plattformweit).
 */

export type PlatformErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_NAME'
  | 'SLUG_TAKEN'
  | 'FEATURE_NOT_FOR_CUSTOMERS'
  | 'NOT_AGENCY_MEMBER'
  | 'LAST_SUPERADMIN';

export class PlatformError extends Error {
  constructor(
    public readonly code: PlatformErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformError';
  }
}

export interface PlatformOrganization {
  id: string;
  name: string;
  slug: string;
  type: string;
  /** Kunden-Org nach Typ oder Verknüpfung (wie im Access-Layer). */
  customerOrg: boolean;
  memberCount: number;
  /** Verknüpfter Client einer Kunden-Org und dessen Eigentümer-Org. */
  client: { id: string; name: string; ownerOrganizationId: string } | null;
  /** Gebuchte Feature-Keys, sortiert. */
  features: string[];
  createdAt: Date;
}

const SUPERADMIN = 'superadmin';

const orgNotFound = () => new PlatformError('NOT_FOUND', 'Organisation nicht gefunden.');

async function loadOrganizations(db: DbOrTx, orgId?: string): Promise<PlatformOrganization[]> {
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      type: organizations.type,
      createdAt: organizations.createdAt,
      memberCount: sql<number>`(
        select count(*)::int from ${members} where ${members.organizationId} = ${organizations.id})`,
      features: sql<string[]>`coalesce((
        select array_agg(${orgEntitlements.feature} order by ${orgEntitlements.feature})
        from ${orgEntitlements}
        where ${orgEntitlements.organizationId} = ${organizations.id} and ${orgEntitlements.enabled}), '{}')`,
      clientId: clients.id,
      clientName: clients.name,
      ownerOrganizationId: clients.organizationId,
    })
    .from(organizations)
    .leftJoin(clients, eq(clients.clientOrganizationId, organizations.id))
    .where(orgId === undefined ? undefined : eq(organizations.id, orgId))
    .orderBy(asc(organizations.name), asc(organizations.id));
  return rows.map(({ clientId, clientName, ownerOrganizationId, ...row }) => ({
    ...row,
    // Sortiert wie in JavaScript (der Vergleich vorher/nachher darf nicht an der Sortierung der DB hängen).
    features: row.features.sort(),
    customerOrg: isCustomerOrg(row.type, clientId),
    client:
      clientId !== null && clientName !== null && ownerOrganizationId !== null
        ? { id: clientId, name: clientName, ownerOrganizationId }
        : null,
  }));
}

export function listPlatformOrganizations(db: Db): Promise<PlatformOrganization[]> {
  return loadOrganizations(db);
}

/**
 * Neue Agentur-Org (`type = internal`; Kunden-Orgs entstehen am Client, 6.3c). Der Slug folgt aus dem Namen. Der
 * Anlegende wird ihr Admin, damit er in die Organisation wechseln und dort Mitglieder anlegen kann.
 */
export async function createPlatformOrganization(
  db: Db,
  input: { name: string; actorUserId: string },
): Promise<PlatformOrganization> {
  const slug = slugify(input.name);
  if (!slug) throw new PlatformError('INVALID_NAME', 'Der Name ergibt keinen gültigen Slug.');
  return db.transaction(async (tx) => {
    const now = new Date();
    const [org] = await tx
      .insert(organizations)
      .values({ name: input.name, slug, type: 'internal', createdAt: now })
      .onConflictDoNothing({ target: organizations.slug })
      .returning({ id: organizations.id });
    if (!org) {
      throw new PlatformError('SLUG_TAKEN', 'Eine Organisation mit diesem Namen gibt es schon.');
    }
    await tx.insert(members).values({
      organizationId: org.id,
      userId: input.actorUserId,
      role: 'admin',
      createdAt: now,
    });
    await recordAuditEvent(tx, {
      organizationId: org.id,
      actorUserId: input.actorUserId,
      action: 'platform.organization_create',
      target: { type: 'organization', id: org.id, name: input.name, slug },
    });
    const [record] = await loadOrganizations(tx, org.id);
    return record!;
  });
}

/** Sperrt die Organisation für die Dauer der Änderung; unbekannt → `NOT_FOUND`. */
async function lockOrganization(tx: DbOrTx, orgId: string) {
  const [org] = await tx
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .for('update');
  if (!org) throw orgNotFound();
  return org;
}

/** Umbenennen; der Slug bleibt. Audit nur bei einer Änderung. */
export async function renamePlatformOrganization(
  db: Db,
  input: { orgId: string; name: string; actorUserId: string },
): Promise<PlatformOrganization> {
  return db.transaction(async (tx) => {
    const org = await lockOrganization(tx, input.orgId);
    if (org.name !== input.name) {
      await tx
        .update(organizations)
        .set({ name: input.name })
        .where(eq(organizations.id, input.orgId));
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.actorUserId,
        action: 'platform.organization_rename',
        target: {
          type: 'organization',
          id: input.orgId,
          name: input.name,
          previousName: org.name,
        },
      });
    }
    const [record] = await loadOrganizations(tx, input.orgId);
    return record!;
  });
}

/**
 * Gebuchte Features einer Organisation ersetzen (ADR 002 Punkt 4). Kunden-Orgs buchen nur `CUSTOMER_ORG_FEATURES`:
 * Alles andere bliebe für sie ohnehin zu (`CUSTOMER_ORG_PATHS` der API). Audit mit vorher/nachher nur bei einer
 * Änderung.
 */
export async function setPlatformEntitlements(
  db: Db,
  input: { orgId: string; features: readonly FeatureKey[]; actorUserId: string },
): Promise<PlatformOrganization> {
  return db.transaction(async (tx) => {
    await lockOrganization(tx, input.orgId);
    const [before] = await loadOrganizations(tx, input.orgId);
    const after = [...new Set(input.features)].sort();
    const forCustomers: readonly string[] = CUSTOMER_ORG_FEATURES;
    if (before!.customerOrg && after.some((feature) => !forCustomers.includes(feature))) {
      throw new PlatformError(
        'FEATURE_NOT_FOR_CUSTOMERS',
        'Kunden-Orgs lassen sich nur Dashboard und Explorer buchen.',
      );
    }
    if (before!.features.join() === after.join()) return before!;
    if (after.length > 0) {
      await tx
        .insert(orgEntitlements)
        .values(after.map((feature) => ({ organizationId: input.orgId, feature, enabled: true })))
        .onConflictDoUpdate({
          target: [orgEntitlements.organizationId, orgEntitlements.feature],
          set: { enabled: true },
        });
    }
    await tx
      .update(orgEntitlements)
      .set({ enabled: false })
      .where(
        and(
          eq(orgEntitlements.organizationId, input.orgId),
          after.length > 0 ? notInArray(orgEntitlements.feature, after) : undefined,
        ),
      );
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'platform.entitlements_update',
      target: { type: 'organization', id: input.orgId, before: before!.features, after },
    });
    return { ...before!, features: after };
  });
}

export interface PlatformStaff {
  id: string;
  name: string;
  email: string;
  isSelf: boolean;
}

/** Nutzer mit der Plattform-Rolle `superadmin`. */
export async function listPlatformStaff(
  db: Db,
  input: { actorUserId: string },
): Promise<PlatformStaff[]> {
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.role, SUPERADMIN))
    .orderBy(asc(users.name), asc(users.id));
  return rows.map((row) => ({ ...row, isSelf: row.id === input.actorUserId }));
}

const staffTarget = (user: { id: string; email: string }) => ({
  type: 'user',
  id: user.id,
  email: user.email,
});

/**
 * Superadmin-Rolle an ein Mitglied einer Agentur-Org vergeben (über die E-Mail). Schon Superadmin: nichts zu tun.
 */
export async function grantPlatformStaff(
  db: Db,
  input: { email: string; actorUserId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.email, input.email.trim().toLowerCase()))
      .for('update');
    if (!user) throw new PlatformError('NOT_FOUND', 'Kein Nutzer mit dieser E-Mail-Adresse.');
    if (user.role === SUPERADMIN) return;
    // Nur Mitglieder einer Agentur-Org: Ein Kunden-Login erreicht den Plattform-Admin nie, zählte aber als
    // „weiterer Superadmin“ und höbe so den Schutz des letzten auf.
    const memberships = await tx
      .select({ type: organizations.type, linkedClientId: clients.id })
      .from(members)
      .innerJoin(organizations, eq(organizations.id, members.organizationId))
      .leftJoin(clients, eq(clients.clientOrganizationId, organizations.id))
      .where(eq(members.userId, user.id));
    if (!memberships.some((m) => !isCustomerOrg(m.type, m.linkedClientId))) {
      throw new PlatformError(
        'NOT_AGENCY_MEMBER',
        'Plattform-Admin kann nur werden, wer Mitglied einer Agentur-Org ist.',
      );
    }
    await tx.update(users).set({ role: SUPERADMIN }).where(eq(users.id, user.id));
    await recordAuditEvent(tx, {
      organizationId: null,
      actorUserId: input.actorUserId,
      action: 'platform.staff_grant',
      target: staffTarget(user),
    });
  });
}

/** Superadmin-Rolle entziehen (auch sich selbst), solange ein anderer Superadmin bleibt. */
export async function revokePlatformStaff(
  db: Db,
  input: { userId: string; actorUserId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    // Alle Superadmins sperren (nach ID geordnet): Zwei gleichzeitige Anfragen entziehen sonst beide die letzte Rolle.
    const staff = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.role, SUPERADMIN))
      .orderBy(asc(users.id))
      .for('update');
    const user = staff.find((row) => row.id === input.userId);
    if (!user) throw new PlatformError('NOT_FOUND', 'Kein Plattform-Admin mit dieser ID.');
    if (staff.length === 1) {
      throw new PlatformError('LAST_SUPERADMIN', 'Die Plattform braucht mindestens einen Admin.');
    }
    await tx.update(users).set({ role: 'user' }).where(eq(users.id, user.id));
    await recordAuditEvent(tx, {
      organizationId: null,
      actorUserId: input.actorUserId,
      action: 'platform.staff_revoke',
      target: staffTarget(user),
    });
  });
}
