/** Rollen innerhalb einer Organisation. `admin` verwaltet die Org, `editor` darf schreiben, `viewer` nur lesen. */
export const ORG_ROLES = ['admin', 'editor', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Plattform-Rollen (better-auth Admin-Plugin). `superadmin` = Muuv-intern. */
export const PLATFORM_ROLES = ['user', 'superadmin'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export function isOrgRole(value: string): value is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(value);
}

export function isPlatformRole(value: string): value is PlatformRole {
  return (PLATFORM_ROLES as readonly string[]).includes(value);
}

/** Darf die Rolle in freigeschalteten Features schreiben? */
export function canWrite(role: OrgRole): boolean {
  return role === 'admin' || role === 'editor';
}

const ORG_ROLE_RANK: Record<OrgRole, number> = { viewer: 0, editor: 1, admin: 2 };

/** Hat die Rolle mindestens die Rechte von `minimum`? (`admin` ⊃ `editor` ⊃ `viewer`) */
export function hasOrgRole(role: OrgRole | null, minimum: OrgRole): boolean {
  return role !== null && ORG_ROLE_RANK[role] >= ORG_ROLE_RANK[minimum];
}
