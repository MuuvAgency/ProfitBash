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
import type { OrgRole, PlatformRole } from './roles';

/**
 * Zugriffskontrolle für better-auth. Server (apps/api) und Client (apps/web) nutzen dieselben
 * Definitionen. Eigener Einstiegspunkt (`@profitbash/shared/access-control`), damit better-auth nur
 * dort im Bundle landet, wo es gebraucht wird.
 */
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
