import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  addMember,
  clientAccessScope,
  findUserByEmail,
  inspectPasswordLink,
  listMembers,
  MemberError,
  redeemPasswordLink,
  regeneratePasswordLink,
  removeMember,
  setMemberClientGrants,
  updateMemberRole,
  type MemberRecord,
} from '@profitbash/db';
import {
  clientAccessCreateSchema,
  errorResponseSchema,
  idParamSchema,
  memberCreateSchema,
  memberListSchema,
  memberClientGrantsSchema,
  memberPatchSchema,
  memberSchema,
  memberWithLinkSchema,
  passwordLinkInfoSchema,
  passwordLinkRedeemSchema,
  passwordLinkSchema,
  passwordLinkTokenSchema,
  SET_PASSWORD_PATH,
  type Member,
} from '@profitbash/shared';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { orgAdminOnly } from '../middleware';

/**
 * Mitglieder (`docs/tasks/phase-2.md` F9, 2.10). Verwaltung nur für Org-Admins der aktiven Organisation. Neue Nutzer legt
 * der Server über better-auth an (`createUser` ist Superadmins vorbehalten, deshalb serverseitig ohne Session); Audit
 * schreibt `packages/db/src/members.ts` mit dem Admin als Handelndem. Der Link zum Setzen des Passworts trägt das Token
 * im Fragment (`/set-password#…`), damit es in keinem Request-Log steht; die öffentlichen Endpunkte bekommen es im Body.
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });
const error = (description: string) => ({ description, content: json(errorResponseSchema) });
const adminErrors = {
  400: error('Ungültige Eingabe.'),
  401: error('Nicht angemeldet.'),
  403: error('Keine Admin-Rolle.'),
};
const notFound = { 404: error('Mitglied nicht gefunden (auch: andere Organisation).') };
const conflict = {
  409: error(
    'E-Mail vergeben, letzter Admin, eigenes Konto oder Mitglied einer anderen Organisation.',
  ),
};

const listRoute = createRoute({
  method: 'get',
  path: '/members',
  tags: ['Mitglieder'],
  summary: 'Mitglieder der aktiven Organisation (nur Admin)',
  responses: {
    200: { description: 'Nach Name.', content: json(memberListSchema) },
    ...adminErrors,
  },
});

const createMemberRoute = createRoute({
  method: 'post',
  path: '/members',
  tags: ['Mitglieder'],
  summary: 'Mitglied anlegen und Link zum Setzen des Passworts erzeugen (nur Admin)',
  request: { body: { required: true, content: json(memberCreateSchema) } },
  responses: {
    201: {
      description: 'Mitglied und Link (nur jetzt sichtbar).',
      content: json(memberWithLinkSchema),
    },
    ...adminErrors,
    ...conflict,
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/members/{id}',
  tags: ['Mitglieder'],
  summary: 'Rolle ändern (nur Admin; der letzte Admin bleibt Admin)',
  request: { params: idParamSchema, body: { required: true, content: json(memberPatchSchema) } },
  responses: {
    200: { description: 'Geändertes Mitglied.', content: json(memberSchema) },
    ...adminErrors,
    ...notFound,
    ...conflict,
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/members/{id}',
  tags: ['Mitglieder'],
  summary:
    'Mitglied entfernen: Sessions beenden, Links sperren, persönliche Ansichten löschen (nur Admin)',
  request: { params: idParamSchema },
  responses: { 204: { description: 'Entfernt.' }, ...adminErrors, ...notFound, ...conflict },
});

const grantsRoute = createRoute({
  method: 'put',
  path: '/members/{id}/client-grants',
  tags: ['Mitglieder'],
  summary:
    'Freigaben ersetzen: Clients, auf die das Mitglied eingeschränkt ist; leer = alle (nur Admin)',
  request: {
    params: idParamSchema,
    body: { required: true, content: json(memberClientGrantsSchema) },
  },
  responses: {
    200: { description: 'Mitglied mit den neuen Freigaben.', content: json(memberSchema) },
    ...adminErrors,
    ...notFound,
    ...conflict,
  },
});

const linkRoute = createRoute({
  method: 'post',
  path: '/members/{id}/password-link',
  tags: ['Mitglieder'],
  summary: 'Link zum Setzen des Passworts neu erzeugen; offene Links verfallen (nur Admin)',
  request: { params: idParamSchema },
  responses: {
    201: { description: 'Neuer Link (nur jetzt sichtbar).', content: json(passwordLinkSchema) },
    ...adminErrors,
    ...notFound,
    ...conflict,
  },
});

// Kundenzugang am Client (`phase-6.md` 6.3c, F3): dieselbe Verwaltung für die Kunden-Org des Clients.
const clientAccessTags = ['Kundenzugang'];
const clientNotFound = { 404: error('Client oder Kunden-Nutzer nicht gefunden.') };
const clientAccessMemberParams = z.object({ id: z.uuid(), memberId: z.uuid() });

const clientAccessListRoute = createRoute({
  method: 'get',
  path: '/clients/{id}/access',
  tags: clientAccessTags,
  summary: 'Kunden-Nutzer eines Clients (nur Admin der Agentur)',
  request: { params: idParamSchema },
  responses: {
    200: { description: 'Nach Name; leer ohne Kundenzugang.', content: json(memberListSchema) },
    ...adminErrors,
    ...clientNotFound,
  },
});

const clientAccessCreateRoute = createRoute({
  method: 'post',
  path: '/clients/{id}/access',
  tags: clientAccessTags,
  summary:
    'Kunden-Nutzer anlegen (nur lesend, sieht nur diesen Client); die Kunden-Org entsteht beim ersten',
  request: {
    params: idParamSchema,
    body: { required: true, content: json(clientAccessCreateSchema) },
  },
  responses: {
    201: {
      description: 'Angelegt; der Link ist nur jetzt sichtbar.',
      content: json(memberWithLinkSchema),
    },
    ...adminErrors,
    ...clientNotFound,
    409: error('E-Mail gehört schon zu einem Mitglied (Agentur oder anderer Kunde).'),
  },
});

const clientAccessLinkRoute = createRoute({
  method: 'post',
  path: '/clients/{id}/access/{memberId}/password-link',
  tags: clientAccessTags,
  summary: 'Link zum Setzen des Passworts für einen Kunden-Nutzer neu erzeugen',
  request: { params: clientAccessMemberParams },
  responses: {
    201: { description: 'Neuer Link (nur jetzt sichtbar).', content: json(passwordLinkSchema) },
    ...adminErrors,
    ...clientNotFound,
  },
});

const clientAccessDeleteRoute = createRoute({
  method: 'delete',
  path: '/clients/{id}/access/{memberId}',
  tags: clientAccessTags,
  summary: 'Kundenzugang entziehen: Mitgliedschaft und Sessions enden, Links verfallen',
  request: { params: clientAccessMemberParams },
  responses: { 204: { description: 'Entzogen.' }, ...adminErrors, ...clientNotFound },
});

const invalidLink = { 410: error('Link unbekannt, benutzt, ungültig gemacht oder abgelaufen.') };

const inspectRoute = createRoute({
  method: 'post',
  path: '/password-links/inspect',
  tags: ['Mitglieder'],
  summary: 'Öffentlich: für wen gilt ein Link? (Token im Body)',
  request: { body: { required: true, content: json(passwordLinkTokenSchema) } },
  responses: {
    200: { description: 'Gültiger Link.', content: json(passwordLinkInfoSchema) },
    400: adminErrors[400],
    ...invalidLink,
  },
});

const redeemRoute = createRoute({
  method: 'post',
  path: '/password-links/redeem',
  tags: ['Mitglieder'],
  summary: 'Öffentlich: Passwort über den Link setzen (einmal); beendet alle Sessions des Nutzers',
  request: { body: { required: true, content: json(passwordLinkRedeemSchema) } },
  responses: { 204: { description: 'Passwort gesetzt.' }, 400: adminErrors[400], ...invalidLink },
});

const ERROR_STATUS: Record<MemberError['code'], [ContentfulStatusCode, string]> = {
  NOT_FOUND: [404, 'MEMBER_NOT_FOUND'],
  UNKNOWN_CLIENT: [409, 'MEMBER_UNKNOWN_CLIENT'],
  LAST_ADMIN: [409, 'MEMBER_LAST_ADMIN'],
  SELF: [409, 'MEMBER_SELF'],
  EMAIL_TAKEN: [409, 'MEMBER_EMAIL_TAKEN'],
  OTHER_ORGANIZATION: [409, 'MEMBER_OTHER_ORGANIZATION'],
  PROTECTED: [403, 'MEMBER_PROTECTED'],
};

async function mapErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof MemberError) {
      const [status, code] = ERROR_STATUS[err.code];
      throw new ApiError(status, code, err.message);
    }
    throw err;
  }
}

function toMember(record: MemberRecord): Member {
  return {
    ...record,
    linkExpiresAt: record.linkExpiresAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

const linkInvalid = () =>
  new ApiError(
    410,
    'PASSWORD_LINK_INVALID',
    'Der Link gilt nicht mehr. Bitte einen neuen anfordern.',
  );

export function registerMemberRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db, auth } = deps;
  const middleware = orgAdminOnly(deps);
  const adminOf = (c: { get(key: 'auth'): AppEnv['Variables']['auth'] }) => {
    const session = c.get('auth');
    return {
      orgId: session.activeOrganization!.organizationId,
      actorUserId: session.user.id,
      actorIsSuperadmin: session.user.role === 'superadmin',
    };
  };
  const linkUrl = (token: string) => `${new URL(SET_PASSWORD_PATH, deps.appUrl).href}#${token}`;

  const emailTaken = () =>
    new ApiError(409, 'MEMBER_EMAIL_TAKEN', 'Diese E-Mail-Adresse gehört schon zu einem Mitglied.');

  /**
   * Nutzer zur E-Mail, neu angelegt, falls es ihn nicht gibt; wer schon irgendwo Mitglied ist → 409. Ohne Passwort
   * (kein Login möglich, bis der Link benutzt ist) und ohne Session: better-auth prüft dann keine
   * Superadmin-Rechte; die Admin-Prüfung für diese Organisation macht `orgAdminOnly`.
   */
  async function findOrCreateUser(email: string, name: string): Promise<string> {
    const existing = await findUserByEmail(db, email);
    if (existing?.hasMemberships) throw emailTaken();
    if (existing) return existing.id;
    try {
      return (await auth.api.createUser({ body: { email, name, role: 'user' } })).user.id;
    } catch (err) {
      // Gleichzeitig mit derselben E-Mail angelegt: wie vergeben behandeln.
      if (await findUserByEmail(db, email)) throw emailTaken();
      throw err;
    }
  }

  /** Verwaltung der Kunden-Org des Clients; ohne Kunden-Org `null` (bzw. mit `create` neu angelegt). */
  const customerScope = (
    c: { get(key: 'auth'): AppEnv['Variables']['auth'] },
    clientId: string,
    create = false,
  ) => mapErrors(() => clientAccessScope(db, { ...adminOf(c), clientId, create }));
  const clientAccessNotFound = () =>
    new ApiError(404, 'MEMBER_NOT_FOUND', 'Kunden-Nutzer nicht gefunden.');

  app.openapi({ ...clientAccessListRoute, middleware }, async (c) => {
    const scope = await customerScope(c, c.req.valid('param').id);
    const records = scope ? await listMembers(db, { ...scope, now: new Date() }) : [];
    return c.json({ members: records.map(toMember) }, 200);
  });

  app.openapi({ ...clientAccessCreateRoute, middleware }, async (c) => {
    const { email, name } = c.req.valid('json');
    // Erst den Client prüfen: Für einen fremden Client entsteht kein Nutzer.
    await customerScope(c, c.req.valid('param').id);
    const userId = await findOrCreateUser(email, name);
    const scope = (await customerScope(c, c.req.valid('param').id, true))!;
    const { member, token, expiresAt } = await mapErrors(() =>
      addMember(db, { ...scope, userId, role: 'viewer', now: new Date() }),
    );
    return c.json(
      {
        member: toMember(member),
        link: { url: linkUrl(token), expiresAt: expiresAt.toISOString() },
      },
      201,
    );
  });

  app.openapi({ ...clientAccessLinkRoute, middleware }, async (c) => {
    const { id, memberId } = c.req.valid('param');
    const scope = await customerScope(c, id);
    if (!scope) throw clientAccessNotFound();
    const { token, expiresAt } = await mapErrors(() =>
      regeneratePasswordLink(db, { ...scope, memberId, now: new Date() }),
    );
    return c.json({ url: linkUrl(token), expiresAt: expiresAt.toISOString() }, 201);
  });

  app.openapi({ ...clientAccessDeleteRoute, middleware }, async (c) => {
    const { id, memberId } = c.req.valid('param');
    const scope = await customerScope(c, id);
    if (!scope) throw clientAccessNotFound();
    await mapErrors(() => removeMember(db, { ...scope, memberId }));
    return c.body(null, 204);
  });

  app.openapi({ ...listRoute, middleware }, async (c) => {
    const records = await listMembers(db, { ...adminOf(c), now: new Date() });
    return c.json({ members: records.map(toMember) }, 200);
  });

  app.openapi({ ...createMemberRoute, middleware }, async (c) => {
    const { email, name, role } = c.req.valid('json');
    const newUserId = await findOrCreateUser(email, name);
    const { member, token, expiresAt } = await mapErrors(() =>
      addMember(db, { ...adminOf(c), userId: newUserId, role, now: new Date() }),
    );
    return c.json(
      {
        member: toMember(member),
        link: { url: linkUrl(token), expiresAt: expiresAt.toISOString() },
      },
      201,
    );
  });

  app.openapi({ ...patchRoute, middleware }, async (c) => {
    const record = await mapErrors(() =>
      updateMemberRole(db, {
        ...adminOf(c),
        memberId: c.req.valid('param').id,
        role: c.req.valid('json').role,
        now: new Date(),
      }),
    );
    return c.json(toMember(record), 200);
  });

  app.openapi({ ...grantsRoute, middleware }, async (c) => {
    const record = await mapErrors(() =>
      setMemberClientGrants(db, {
        ...adminOf(c),
        memberId: c.req.valid('param').id,
        clientIds: c.req.valid('json').clientIds,
        now: new Date(),
      }),
    );
    return c.json(toMember(record), 200);
  });

  app.openapi({ ...deleteRoute, middleware }, async (c) => {
    await mapErrors(() => removeMember(db, { ...adminOf(c), memberId: c.req.valid('param').id }));
    return c.body(null, 204);
  });

  app.openapi({ ...linkRoute, middleware }, async (c) => {
    const { token, expiresAt } = await mapErrors(() =>
      regeneratePasswordLink(db, {
        ...adminOf(c),
        memberId: c.req.valid('param').id,
        now: new Date(),
      }),
    );
    return c.json({ url: linkUrl(token), expiresAt: expiresAt.toISOString() }, 201);
  });

  app.openapi(inspectRoute, async (c) => {
    const info = await inspectPasswordLink(db, c.req.valid('json').token, new Date());
    if (!info) throw linkInvalid();
    return c.json({ ...info, expiresAt: info.expiresAt.toISOString() }, 200);
  });

  app.openapi(redeemRoute, async (c) => {
    const { token, password } = c.req.valid('json');
    // Erst prüfen, dann hashen: Der Hash kostet Rechenzeit, der Endpunkt ist öffentlich. Die eigentliche Prüfung (einmal,
    // nicht abgelaufen) macht `redeemPasswordLink` atomar.
    if (!(await inspectPasswordLink(db, token, new Date()))) throw linkInvalid();
    const context = await auth.$context;
    const passwordHash = await context.password.hash(password);
    if (!(await redeemPasswordLink(db, { token, passwordHash, now: new Date() })))
      throw linkInvalid();
    return c.body(null, 204);
  });
}
