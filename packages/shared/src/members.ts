import { z } from 'zod';
import { ORG_ROLES } from './roles';

/**
 * Mitgliederverwaltung (`docs/tasks/phase-2.md` F9, 2.10): Org-Admins legen Mitglieder an, ändern Rollen, entfernen sie und
 * erzeugen einen einmaligen Link zum Setzen des Passworts (ohne E-Mail-Versand). Der Link trägt das Token im Fragment
 * (`/set-password#<token>`); gespeichert wird nur ein Hash.
 */

/** Wie `minPasswordLength` in `apps/api/src/auth.ts`. */
export const MIN_PASSWORD_LENGTH = 12;
/** better-auth-Standard. */
export const MAX_PASSWORD_LENGTH = 128;
/** Gültigkeit eines Links (F9). */
export const PASSWORD_LINK_VALID_DAYS = 7;
/** Seite zum Setzen des Passworts; das Token steht im Fragment. */
export const SET_PASSWORD_PATH = '/set-password';

const orgRole = z.enum(ORG_ROLES);

export const memberCreateSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
    name: z.string().trim().min(1).max(120),
    role: orgRole,
  })
  .meta({ id: 'MemberCreate' });

export const memberPatchSchema = z.object({ role: orgRole }).meta({ id: 'MemberPatch' });

/** `active`: Passwort gesetzt; `pending`: gültiger Link offen; `expired`: Link abgelaufen oder keiner offen. */
export const MEMBER_STATUSES = ['active', 'pending', 'expired'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const memberSchema = z
  .object({
    /** ID der Mitgliedschaft (`members.id`). */
    id: z.uuid(),
    userId: z.uuid(),
    name: z.string(),
    email: z.string(),
    role: orgRole,
    status: z.enum(MEMBER_STATUSES),
    /** Ablauf des offenen Links (`pending`). */
    linkExpiresAt: z.union([z.iso.datetime(), z.null()]),
    /** Angemeldeter Admin selbst. */
    isSelf: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Member' });
export type Member = z.infer<typeof memberSchema>;

export const memberListSchema = z
  .object({ members: z.array(memberSchema) })
  .meta({ id: 'MemberList' });

/** Nur einmal ausgeliefert (beim Anlegen oder Neu-Erzeugen); das Token speichert der Server nur als Hash. */
export const passwordLinkSchema = z
  .object({ url: z.url(), expiresAt: z.iso.datetime() })
  .meta({ id: 'PasswordLink' });

export const memberWithLinkSchema = z
  .object({ member: memberSchema, link: passwordLinkSchema })
  .meta({ id: 'MemberWithLink' });

/** 32 Zufallsbytes als base64url. */
export const passwordLinkTokenSchema = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .meta({ id: 'PasswordLinkToken' });

export const passwordLinkInfoSchema = z
  .object({ email: z.string(), name: z.string(), expiresAt: z.iso.datetime() })
  .meta({ id: 'PasswordLinkInfo' });

export const passwordLinkRedeemSchema = passwordLinkTokenSchema
  .extend({ password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH) })
  .meta({ id: 'PasswordLinkRedeem' });
