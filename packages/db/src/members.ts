import { PASSWORD_LINK_VALID_DAYS, type MemberStatus, type OrgRole } from '@profitbash/shared';
import { and, asc, count, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { recordAuditEvent, type DbOrTx } from './audit';
import type { Db } from './client';
import {
  accounts,
  clients,
  memberClientGrants,
  memberPasswordLinks,
  members,
  organizations,
  orgEntitlements,
  savedViews,
  sessions,
  users,
} from './schema';

/**
 * Mitgliederverwaltung der Eigentümer-Org (`phase-2.md` F9, 2.10; ADR 002 „Verwaltung der Eigentümer-Org“): Die Routen
 * rufen das nur hinter `orgAdminOnly` mit der aktiven Organisation auf. Einmal-Links: nur der SHA-256-Hash des Tokens
 * wird gespeichert, ein Link gilt 7 Tage und einmal, Neu-Erzeugen und Entfernen machen offene Links ungültig. Jede
 * Änderung schreibt ein Audit-Event mit dem handelnden Admin (bzw. beim Setzen des Passworts mit dem Mitglied).
 */

export type MemberErrorCode =
  | 'NOT_FOUND'
  | 'LAST_ADMIN'
  | 'SELF'
  | 'EMAIL_TAKEN'
  | 'OTHER_ORGANIZATION'
  | 'PROTECTED'
  | 'UNKNOWN_CLIENT';

export class MemberError extends Error {
  constructor(
    public readonly code: MemberErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MemberError';
  }
}

export interface MemberRecord {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  status: MemberStatus;
  linkExpiresAt: Date | null;
  isSelf: boolean;
  /** Freigaben (6.2): Clients, auf die das Mitglied eingeschränkt ist; leer = alle. Bei Admins ohne Wirkung. */
  clientIds: string[];
  createdAt: Date;
}

export interface MemberAdminInput {
  orgId: string;
  /** Handelnder Org-Admin. */
  actorUserId: string;
  /**
   * Handelnder ist Superadmin (Plattform-Rolle). Nur dann lassen sich Superadmins ändern, entfernen, wieder aufnehmen oder
   * mit einem Link versehen; sonst könnte ein Org-Admin über „Link neu erzeugen“ das Superadmin-Konto übernehmen.
   */
  actorIsSuperadmin?: boolean;
  /**
   * Kundenzugang (6.3c): `orgId` ist die Kunden-Org dieses Clients. Nur von `clientAccessScope` gesetzt; das Audit
   * steht dann als `client_access.*` im Log der Eigentümer-Org.
   */
  customerOf?: { ownerOrgId: string; clientId: string };
}

/** Audit der Mitgliederverwaltung; für Kundenzugänge im Log der Agentur statt in dem der Kunden-Org. */
function recordMemberEvent(
  tx: DbOrTx,
  input: MemberAdminInput,
  action: 'create' | 'remove' | 'link_create',
  target: { id: string } & Record<string, unknown>,
) {
  const { customerOf } = input;
  return recordAuditEvent(tx, {
    organizationId: customerOf?.ownerOrgId ?? input.orgId,
    actorUserId: input.actorUserId,
    action: `${customerOf ? 'client_access' : 'member'}.${action}`,
    target: { type: 'member', ...target, ...(customerOf && { clientId: customerOf.clientId }) },
  });
}

const protectedUser = () =>
  new MemberError('PROTECTED', 'Dieses Konto können nur Plattform-Admins ändern.');

function assertMayManage(input: MemberAdminInput, targetRole: string | null) {
  if (targetRole === 'superadmin' && !input.actorIsSuperadmin) throw protectedUser();
}

const DAY_MS = 86_400_000;
const CREDENTIAL = 'credential';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const notFound = () => new MemberError('NOT_FOUND', 'Mitglied nicht gefunden.');

/** Offene Links: nicht benutzt, nicht gesperrt (ablaufen können sie trotzdem). */
const openLink = and(isNull(memberPasswordLinks.usedAt), isNull(memberPasswordLinks.revokedAt));

async function loadMembers(
  db: DbOrTx,
  input: MemberAdminInput & { now: Date; memberId?: string },
): Promise<MemberRecord[]> {
  const rows = await db
    .select({
      id: members.id,
      userId: members.userId,
      name: users.name,
      email: users.email,
      role: members.role,
      createdAt: members.createdAt,
      hasPassword: sql<boolean>`exists (
        select 1 from ${accounts}
        where ${accounts.userId} = ${members.userId}
          and ${accounts.providerId} = ${CREDENTIAL}
          and ${accounts.password} is not null)`,
      linkExpiresAt: sql<string | null>`(
        select max(${memberPasswordLinks.expiresAt}) from ${memberPasswordLinks}
        where ${memberPasswordLinks.organizationId} = ${members.organizationId}
          and ${memberPasswordLinks.userId} = ${members.userId}
          and ${memberPasswordLinks.usedAt} is null
          and ${memberPasswordLinks.revokedAt} is null
          and ${memberPasswordLinks.expiresAt} > ${input.now.toISOString()}::timestamptz)`,
      clientIds: sql<string[]>`coalesce((
        select array_agg(${memberClientGrants.clientId}::text order by ${memberClientGrants.clientId})
        from ${memberClientGrants}
        where ${memberClientGrants.memberId} = ${members.id}), '{}')`,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.organizationId, input.orgId),
        input.memberId ? eq(members.id, input.memberId) : undefined,
      ),
    )
    .orderBy(asc(users.name), asc(users.email), asc(members.id));
  return rows.map((row) => {
    const linkExpiresAt = row.linkExpiresAt ? new Date(row.linkExpiresAt) : null;
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      email: row.email,
      role: row.role as OrgRole,
      // Ein offener Link (z. B. neu erzeugt zum Zurücksetzen) zählt vor einem gesetzten Passwort.
      status: linkExpiresAt ? 'pending' : row.hasPassword ? 'active' : 'expired',
      linkExpiresAt,
      isSelf: row.userId === input.actorUserId,
      clientIds: row.clientIds,
      createdAt: row.createdAt,
    };
  });
}

export function listMembers(
  db: Db,
  input: MemberAdminInput & { now: Date },
): Promise<MemberRecord[]> {
  return loadMembers(db, input);
}

/** Nutzer zu einer E-Mail (klein geschrieben) und ob er irgendwo Mitglied ist. */
export async function findUserByEmail(
  db: Db,
  email: string,
): Promise<{ id: string; hasMemberships: boolean } | null> {
  const [row] = await db
    .select({ id: users.id, memberships: count(members.id) })
    .from(users)
    .leftJoin(members, eq(members.userId, users.id))
    .where(eq(users.email, email.trim().toLowerCase()))
    .groupBy(users.id)
    .limit(1);
  return row ? { id: row.id, hasMemberships: row.memberships > 0 } : null;
}

/** Offene Links des Nutzers in der Organisation sperren und einen neuen anlegen. */
async function issueLink(
  tx: DbOrTx,
  input: MemberAdminInput & { userId: string; now: Date },
): Promise<{ token: string; expiresAt: Date }> {
  await tx
    .update(memberPasswordLinks)
    .set({ revokedAt: input.now })
    .where(
      and(
        eq(memberPasswordLinks.organizationId, input.orgId),
        eq(memberPasswordLinks.userId, input.userId),
        openLink,
      ),
    );
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(input.now.getTime() + PASSWORD_LINK_VALID_DAYS * DAY_MS);
  await tx.insert(memberPasswordLinks).values({
    organizationId: input.orgId,
    userId: input.userId,
    tokenHash: hashToken(token),
    createdBy: input.actorUserId,
    expiresAt,
  });
  return { token, expiresAt };
}

/**
 * Mitgliedschaft für einen Nutzer ohne Mitgliedschaft anlegen (neu angelegt oder früher entfernt) und den ersten Link
 * erzeugen. Nutzer mit einer Mitgliedschaft (hier oder in einer anderen Organisation) → `EMAIL_TAKEN`: Ein Link für sie
 * setzte das Passwort eines fremden Kontos.
 */
export async function addMember(
  db: Db,
  input: MemberAdminInput & { userId: string; role: OrgRole; now: Date },
): Promise<{ member: MemberRecord; token: string; expiresAt: Date }> {
  return db.transaction(async (tx) => {
    // Sperrt den Nutzer, damit zwei gleichzeitige Anfragen nicht beide eine Mitgliedschaft anlegen.
    const [user] = await tx
      .select({ id: users.id, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.id, input.userId))
      .for('update');
    if (!user) throw notFound();
    assertMayManage(input, user.role);
    const [existing] = await tx
      .select({ n: count() })
      .from(members)
      .where(eq(members.userId, input.userId));
    if ((existing?.n ?? 0) > 0) {
      throw new MemberError('EMAIL_TAKEN', 'Diese E-Mail-Adresse gehört schon zu einem Mitglied.');
    }
    const [membership] = await tx
      .insert(members)
      .values({
        organizationId: input.orgId,
        userId: input.userId,
        role: input.role,
        createdAt: input.now,
      })
      .returning({ id: members.id });
    const link = await issueLink(tx, input);
    await recordMemberEvent(tx, input, 'create', {
      id: membership!.id,
      userId: input.userId,
      email: user.email,
      role: input.role,
      linkExpiresAt: link.expiresAt.toISOString(),
    });
    const [member] = await loadMembers(tx, { ...input, memberId: membership!.id });
    return { member: member!, ...link };
  });
}

/**
 * Admins der Organisation sperren (`FOR UPDATE`, nach ID geordnet, damit sich gleichzeitige Änderungen nicht gegenseitig
 * blockieren), danach die Ziel-Mitgliedschaft; sonst `NOT_FOUND`. Liefert dazu, wie viele Admins außer dem Ziel bleiben.
 */
async function lockMember(tx: DbOrTx, input: MemberAdminInput, memberId: string) {
  const admins = await tx
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, input.orgId), eq(members.role, 'admin')))
    .orderBy(asc(members.id))
    .for('update');
  const [row] = await tx
    .select({
      id: members.id,
      userId: members.userId,
      role: members.role,
      platformRole: users.role,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.id, memberId), eq(members.organizationId, input.orgId)))
    .for('update', { of: members });
  if (!row) throw notFound();
  assertMayManage(input, row.platformRole);
  return { ...row, otherAdmins: admins.filter((a) => a.id !== row.id).length };
}

const lastAdmin = () =>
  new MemberError('LAST_ADMIN', 'Die Organisation braucht mindestens einen Admin.');

export async function updateMemberRole(
  db: Db,
  input: MemberAdminInput & { memberId: string; role: OrgRole; now: Date },
): Promise<MemberRecord> {
  return db.transaction(async (tx) => {
    const member = await lockMember(tx, input, input.memberId);
    if (member.role === 'admin' && input.role !== 'admin' && member.otherAdmins === 0) {
      throw lastAdmin();
    }
    if (member.role !== input.role) {
      await tx.update(members).set({ role: input.role }).where(eq(members.id, member.id));
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.actorUserId,
        action: 'member.role_update',
        target: {
          type: 'member',
          id: member.id,
          userId: member.userId,
          previousRole: member.role,
          role: input.role,
        },
      });
    }
    const [record] = await loadMembers(tx, input);
    return record!;
  });
}

/**
 * Freigaben eines Mitglieds ersetzen (6.2): `clientIds` leer = alle Clients. Nur Clients der Organisation
 * (`UNKNOWN_CLIENT`). Audit `member.grants_update` nur bei einer Änderung.
 */
export async function setMemberClientGrants(
  db: Db,
  input: MemberAdminInput & { memberId: string; clientIds: string[]; now: Date },
): Promise<MemberRecord> {
  return db.transaction(async (tx) => {
    const member = await lockMember(tx, input, input.memberId);
    const after = [...new Set(input.clientIds)].sort();
    if (after.length > 0) {
      const known = await tx
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.organizationId, input.orgId), inArray(clients.id, after)));
      if (known.length !== after.length) {
        throw new MemberError('UNKNOWN_CLIENT', 'Ein Client gehört nicht zur Organisation.');
      }
    }
    const before = (
      await tx
        .select({ clientId: memberClientGrants.clientId })
        .from(memberClientGrants)
        .where(eq(memberClientGrants.memberId, member.id))
    )
      .map((row) => row.clientId)
      .sort();
    if (before.join() !== after.join()) {
      await tx.delete(memberClientGrants).where(eq(memberClientGrants.memberId, member.id));
      if (after.length > 0) {
        await tx.insert(memberClientGrants).values(
          after.map((clientId) => ({
            organizationId: input.orgId,
            memberId: member.id,
            clientId,
          })),
        );
      }
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.actorUserId,
        action: 'member.grants_update',
        target: { type: 'member', id: member.id, userId: member.userId, before, after },
      });
    }
    const [record] = await loadMembers(tx, input);
    return record!;
  });
}

/**
 * Mitglied entfernen: Mitgliedschaft löschen, offene Links sperren, alle Sessions des Nutzers beenden, persönliche
 * gespeicherte Ansichten in der Organisation löschen (freigegebene bleiben, Dominik 2026-09-29). Der Nutzer selbst bleibt
 * (Audit-Verweise); eine spätere Wiederaufnahme legt nur eine neue Mitgliedschaft mit neuem Link an.
 */
export async function removeMember(
  db: Db,
  input: MemberAdminInput & { memberId: string },
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const member = await lockMember(tx, input, input.memberId);
    if (member.userId === input.actorUserId) {
      throw new MemberError('SELF', 'Das eigene Konto lässt sich hier nicht entfernen.');
    }
    if (member.role === 'admin' && member.otherAdmins === 0) throw lastAdmin();
    await tx.delete(members).where(eq(members.id, member.id));
    await tx
      .update(memberPasswordLinks)
      .set({ revokedAt: now })
      .where(
        and(
          eq(memberPasswordLinks.organizationId, input.orgId),
          eq(memberPasswordLinks.userId, member.userId),
          openLink,
        ),
      );
    // Alle Sessions, nicht nur die dieser Organisation: Außer über Phase 6 gibt es keine weiteren Mitgliedschaften, und
    // eine Session ohne Mitgliedschaft sähe ohnehin nichts.
    const ended = await tx
      .delete(sessions)
      .where(eq(sessions.userId, member.userId))
      .returning({ id: sessions.id });
    const views = await tx
      .delete(savedViews)
      .where(
        and(
          eq(savedViews.organizationId, input.orgId),
          eq(savedViews.ownerUserId, member.userId),
          eq(savedViews.shared, false),
        ),
      )
      .returning({ id: savedViews.id });
    await recordMemberEvent(tx, input, 'remove', {
      id: member.id,
      userId: member.userId,
      role: member.role,
      sessionsEnded: ended.length,
      personalViewsDeleted: views.length,
    });
  });
}

/**
 * Neuen Link erzeugen (auch zum Zurücksetzen eines gesetzten Passworts). Nicht für Nutzer, die auch in einer anderen
 * Organisation Mitglied sind: Der Admin dieser Organisation dürfte sonst deren Konto übernehmen.
 */
export async function regeneratePasswordLink(
  db: Db,
  input: MemberAdminInput & { memberId: string; now: Date },
): Promise<{ token: string; expiresAt: Date }> {
  return db.transaction(async (tx) => {
    const member = await lockMember(tx, input, input.memberId);
    const [elsewhere] = await tx
      .select({ n: count() })
      .from(members)
      .where(and(eq(members.userId, member.userId), ne(members.organizationId, input.orgId)));
    if ((elsewhere?.n ?? 0) > 0) {
      throw new MemberError(
        'OTHER_ORGANIZATION',
        'Das Mitglied gehört auch zu einer anderen Organisation; sein Passwort lässt sich hier nicht setzen.',
      );
    }
    const link = await issueLink(tx, { ...input, userId: member.userId });
    await recordMemberEvent(tx, input, 'link_create', {
      id: member.id,
      userId: member.userId,
      linkExpiresAt: link.expiresAt.toISOString(),
    });
    return link;
  });
}

/** Was eine Kunden-Org bucht (`phase-6.md` F1): Dashboard und Explorer, nur lesend. */
export const CUSTOMER_ORG_FEATURES = ['dashboard', 'sp-explorer'] as const;

/**
 * Kundenzugang eines Clients (`phase-6.md` 6.3c, F3): liefert die Eingabe, mit der `listMembers`, `addMember` (immer
 * Rolle `viewer`), `regeneratePasswordLink` und `removeMember` die Nutzer der Kunden-Org verwalten. `orgId` ist die
 * Eigentümer-Org des handelnden Admins; fremde oder unbekannte Clients → `NOT_FOUND`. Ohne Kunden-Org: `null`, mit
 * `create` entsteht sie (Typ `client`, Entitlements nach F1, verknüpft über `clients.client_organization_id`).
 */
export async function clientAccessScope(
  db: Db,
  input: MemberAdminInput & { clientId: string; create?: boolean },
): Promise<MemberAdminInput | null> {
  const { clientId, create, ...admin } = input;
  return db.transaction(async (tx) => {
    // Sperrt den Client, damit zwei gleichzeitige Anfragen nicht zwei Kunden-Orgs anlegen.
    const [client] = await tx
      .select({
        name: clients.name,
        customerOrgId: clients.clientOrganizationId,
        customerOrgType: organizations.type,
      })
      .from(clients)
      .leftJoin(organizations, eq(organizations.id, clients.clientOrganizationId))
      .where(and(eq(clients.id, clientId), eq(clients.organizationId, admin.orgId)))
      .for('update', { of: clients });
    // Nur Kunden-Orgs: Zeigte die Verknüpfung je auf eine Agentur-Org, ließen sich sonst deren Konten übernehmen.
    if (!client || (client.customerOrgId && client.customerOrgType !== 'client')) {
      throw new MemberError('NOT_FOUND', 'Client nicht gefunden.');
    }
    const scope = (orgId: string): MemberAdminInput => ({
      ...admin,
      orgId,
      customerOf: { ownerOrgId: admin.orgId, clientId },
    });
    if (client.customerOrgId) return scope(client.customerOrgId);
    if (!create) return null;
    const [org] = await tx
      .insert(organizations)
      // Der Slug muss nur eindeutig sein; Kunden-Orgs haben keine eigene Adresse.
      .values({
        name: client.name,
        slug: `kunde-${clientId}`,
        type: 'client',
        createdAt: new Date(),
      })
      .returning({ id: organizations.id });
    await tx.insert(orgEntitlements).values(
      CUSTOMER_ORG_FEATURES.map((feature) => ({
        organizationId: org!.id,
        feature,
        enabled: true,
      })),
    );
    await tx.update(clients).set({ clientOrganizationId: org!.id }).where(eq(clients.id, clientId));
    await recordAuditEvent(tx, {
      organizationId: admin.orgId,
      actorUserId: admin.actorUserId,
      action: 'client_access.org_create',
      target: { type: 'client', id: clientId, clientId, customerOrganizationId: org!.id },
    });
    return scope(org!.id);
  });
}

const validLink = (token: string, now: Date) =>
  and(
    eq(memberPasswordLinks.tokenHash, hashToken(token)),
    openLink,
    gt(memberPasswordLinks.expiresAt, now),
  );

/** Wem gehört ein gültiger Link? `null`: unbekannt, benutzt, gesperrt oder abgelaufen (bewusst nicht unterschieden). */
export async function inspectPasswordLink(
  db: Db,
  token: string,
  now: Date,
): Promise<{ email: string; name: string; expiresAt: Date } | null> {
  const [row] = await db
    .select({ email: users.email, name: users.name, expiresAt: memberPasswordLinks.expiresAt })
    .from(memberPasswordLinks)
    .innerJoin(users, eq(users.id, memberPasswordLinks.userId))
    // Nur solange die Mitgliedschaft besteht (Entfernen sperrt die Links ohnehin).
    .innerJoin(
      members,
      and(
        eq(members.userId, memberPasswordLinks.userId),
        eq(members.organizationId, memberPasswordLinks.organizationId),
      ),
    )
    .where(validLink(token, now))
    .limit(1);
  return row ?? null;
}

/**
 * Passwort über einen gültigen Link setzen (Hash von better-auth, `ctx.password.hash`): Link als benutzt markieren,
 * Passwort der Anmeldung per E-Mail setzen oder anlegen, alle Sessions beenden. Liefert `false`, wenn der Link nicht
 * (mehr) gilt.
 */
export async function redeemPasswordLink(
  db: Db,
  input: { token: string; passwordHash: string; now: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [link] = await tx
      .update(memberPasswordLinks)
      .set({ usedAt: input.now })
      .where(
        and(
          validLink(input.token, input.now),
          inArray(
            memberPasswordLinks.userId,
            tx
              .select({ userId: members.userId })
              .from(members)
              .where(eq(members.organizationId, memberPasswordLinks.organizationId)),
          ),
        ),
      )
      .returning({
        id: memberPasswordLinks.id,
        userId: memberPasswordLinks.userId,
        organizationId: memberPasswordLinks.organizationId,
      });
    if (!link) return false;
    const updated = await tx
      .update(accounts)
      .set({ password: input.passwordHash, updatedAt: input.now })
      .where(and(eq(accounts.userId, link.userId), eq(accounts.providerId, CREDENTIAL)))
      .returning({ id: accounts.id });
    if (updated.length === 0) {
      // Wie better-auth (`internalAdapter.createAccount` für E-Mail und Passwort): accountId = userId.
      await tx.insert(accounts).values({
        userId: link.userId,
        providerId: CREDENTIAL,
        accountId: link.userId,
        password: input.passwordHash,
        updatedAt: input.now,
      });
    }
    await tx.delete(sessions).where(eq(sessions.userId, link.userId));
    await recordAuditEvent(tx, {
      organizationId: link.organizationId,
      actorUserId: link.userId,
      action: 'member.password_set',
      target: { type: 'user', id: link.userId, linkId: link.id },
    });
    return true;
  });
}
