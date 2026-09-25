import { createAccessControl } from 'better-auth/plugins/access';
import {
  adminAc as platformAdminStatements,
  defaultStatements as platformStatements,
  userAc as platformUserStatements,
} from 'better-auth/plugins/admin/access';
import {
  adminAc as orgAdminStatements,
  memberAc as orgMemberStatements,
  defaultStatements as orgStatements,
} from 'better-auth/plugins/organization/access';

/** Rollen innerhalb einer Organisation. `admin` verwaltet die Org, `editor` darf schreiben, `viewer` nur lesen. */
export const ORG_ROLES = ['admin', 'editor', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Plattform-Rollen (better-auth Admin-Plugin). `superadmin` = Muuv-intern. */
export const PLATFORM_ROLES = ['user', 'superadmin'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export function isOrgRole(value: string): value is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(value);
}

/** Darf die Rolle in freigeschalteten Features schreiben? */
export function canWrite(role: OrgRole): boolean {
  return role === 'admin' || role === 'editor';
}

// Zugriffskontrolle für better-auth. Server (apps/api) und Client (apps/web) nutzen dieselben Definitionen.
export const orgAccessControl = createAccessControl(orgStatements);
export const orgRoles = {
  admin: orgAccessControl.newRole(orgAdminStatements.statements),
  editor: orgAccessControl.newRole(orgMemberStatements.statements),
  viewer: orgAccessControl.newRole(orgMemberStatements.statements),
} satisfies Record<OrgRole, unknown>;

export const platformAccessControl = createAccessControl(platformStatements);
export const platformRoles = {
  user: platformAccessControl.newRole(platformUserStatements.statements),
  superadmin: platformAccessControl.newRole(platformAdminStatements.statements),
} satisfies Record<PlatformRole, unknown>;
