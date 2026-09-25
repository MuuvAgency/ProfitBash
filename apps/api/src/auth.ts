import { tryGetCurrentAuthEndpointContext } from '@better-auth/core/context';
import {
  listMemberships,
  recordAuditEvent,
  schema,
  type AuditEventInput,
  type Db,
} from '@profitbash/db';
import {
  orgAccessControl,
  orgRoles,
  platformAccessControl,
  platformRoles,
} from '@profitbash/shared/access-control';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { admin, organization } from 'better-auth/plugins';

export interface CreateAuthOptions {
  db: Db;
  secret: string;
  /** Öffentliche Origin der App (APP_URL). */
  baseURL: string;
  trustedOrigins?: string[];
}

interface MemberLike {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
}

const memberTarget = (member: MemberLike) => ({
  type: 'member',
  id: member.id,
  userId: member.userId,
  role: member.role,
});

const invitationTarget = (invitation: { id: string; email: string; role: string }) => ({
  type: 'invitation',
  id: invitation.id,
  email: invitation.email,
  role: invitation.role,
});

/**
 * Handelnder Nutzer der laufenden better-auth-Anfrage. `null` bei Server-Aufrufen ohne Session
 * (z. B. Seed). Die Organization-Hooks übergeben nur den *betroffenen* Nutzer, deshalb der Umweg
 * über den Endpoint-Kontext.
 *
 * Wichtig für eigenen Code: Serverseitige Aufrufe wie `auth.api.addMember(…)` immer mit den
 * `headers` der Anfrage ausführen, sonst fehlt der Handelnde im Audit-Log.
 */
function currentActorId(): string | null {
  const session: unknown = tryGetCurrentAuthEndpointContext()?.context.session;
  if (session && typeof session === 'object' && 'user' in session) {
    const user = (session as { user?: { id?: unknown } }).user;
    if (typeof user?.id === 'string') return user.id;
  }
  return null;
}

/**
 * Audit-Events für Schreibvorgänge über better-auth (Organisation, Mitglieder, Rollen,
 * Einladungen). Die Hooks laufen nur nach erfolgreichen Änderungen, allerdings nicht in derselben
 * Transaktion: Scheitert das Audit-Insert, bleibt die Änderung bestehen und die Anfrage endet mit 500.
 */
function auditHooks(db: Db) {
  const record = (event: Omit<AuditEventInput, 'actorUserId'>) =>
    recordAuditEvent(db, { ...event, actorUserId: currentActorId() });

  return {
    afterCreateOrganization: async ({ organization }: { organization: OrganizationLike }) =>
      record({
        organizationId: organization.id,
        action: 'organization.create',
        target: orgTarget(organization),
      }),
    afterUpdateOrganization: async ({
      organization,
    }: {
      organization: OrganizationLike | null;
    }) => {
      if (!organization) return;
      await record({
        organizationId: organization.id,
        action: 'organization.update',
        target: orgTarget(organization),
      });
    },
    afterAddMember: async ({ member }: { member: MemberLike }) =>
      record({
        organizationId: member.organizationId,
        action: 'member.add',
        target: memberTarget(member),
      }),
    afterRemoveMember: async ({ member }: { member: MemberLike }) =>
      record({
        organizationId: member.organizationId,
        action: 'member.remove',
        target: memberTarget(member),
      }),
    afterUpdateMemberRole: async ({
      member,
      previousRole,
    }: {
      member: MemberLike;
      previousRole: string;
    }) =>
      record({
        organizationId: member.organizationId,
        action: 'member.role_update',
        target: { ...memberTarget(member), previousRole },
      }),
    afterCreateInvitation: async ({ invitation }: { invitation: InvitationLike }) =>
      record({
        organizationId: invitation.organizationId,
        action: 'invitation.create',
        target: invitationTarget(invitation),
      }),
    afterAcceptInvitation: async ({ invitation }: { invitation: InvitationLike }) =>
      record({
        organizationId: invitation.organizationId,
        action: 'invitation.accept',
        target: invitationTarget(invitation),
      }),
    afterRejectInvitation: async ({ invitation }: { invitation: InvitationLike }) =>
      record({
        organizationId: invitation.organizationId,
        action: 'invitation.reject',
        target: invitationTarget(invitation),
      }),
    afterCancelInvitation: async ({ invitation }: { invitation: InvitationLike }) =>
      record({
        organizationId: invitation.organizationId,
        action: 'invitation.cancel',
        target: invitationTarget(invitation),
      }),
  };
}

interface OrganizationLike {
  id: string;
  name: string;
  slug: string;
}

interface InvitationLike {
  id: string;
  email: string;
  role: string;
  organizationId: string;
}

const orgTarget = (organization: OrganizationLike) => ({
  type: 'organization',
  id: organization.id,
  name: organization.name,
  slug: organization.slug,
});

function isMemberLike(value: unknown): value is MemberLike {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return ['id', 'userId', 'organizationId', 'role'].every((k) => typeof v[k] === 'string');
}

/**
 * better-auth-Konfiguration. Änderungen an Plugins oder Feldern erfordern ein neues Schema:
 * `pnpm --filter @profitbash/api auth:schema`, danach `pnpm db:generate`.
 */
export function createAuth({ db, secret, baseURL, trustedOrigins = [] }: CreateAuthOptions) {
  return betterAuth({
    secret,
    baseURL,
    basePath: '/api/auth',
    trustedOrigins,
    database: drizzleAdapter(db, { provider: 'pg', schema, usePlural: true }),
    advanced: { database: { generateId: 'uuid' } },
    hooks: {
      // `/organization/leave` löst keinen Organization-Hook aus. Die Antwort ist das entfernte
      // Mitglied; der Handelnde ist das Mitglied selbst.
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/organization/leave') return;
        const member: unknown = ctx.context.returned;
        if (!isMemberLike(member)) return;
        await recordAuditEvent(db, {
          organizationId: member.organizationId,
          actorUserId: member.userId,
          action: 'member.leave',
          target: memberTarget(member),
        });
      }),
    },
    databaseHooks: {
      session: {
        create: {
          // Neue Sessions starten in der ältesten Organisation des Nutzers. Wechsel über
          // `/api/auth/organization/set-active`; die API prüft die Mitgliedschaft bei jeder Anfrage.
          before: async (session) => {
            const [first] = await listMemberships(db, session.userId);
            return { data: { ...session, activeOrganizationId: first?.organizationId ?? null } };
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      // Keine öffentliche Registrierung: Nutzer legen Admins an (Seed, später Mitgliederverwaltung).
      disableSignUp: true,
      minPasswordLength: 12,
    },
    plugins: [
      organization({
        ac: orgAccessControl,
        roles: orgRoles,
        creatorRole: 'admin',
        allowUserToCreateOrganization: false,
        organizationHooks: auditHooks(db),
        schema: {
          organization: {
            additionalFields: {
              // internal = Agentur (Muuv), client = Kundenorganisation.
              // input: false → Clients können den Typ nicht setzen oder ändern, nur der Server.
              type: { type: 'string', required: true, defaultValue: 'client', input: false },
            },
          },
        },
      }),
      admin({
        ac: platformAccessControl,
        roles: platformRoles,
        adminRoles: ['superadmin'],
        defaultRole: 'user',
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
