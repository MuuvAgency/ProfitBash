import { z } from 'zod';
import { FEATURE_KEYS } from './features';

/**
 * Plattform-Admin (`docs/tasks/phase-6.md` 6.4, F5; nur Superadmins): Organisationen anlegen und umbenennen,
 * Entitlements je Organisation, Staff (Plattform-Rolle `superadmin`).
 */

export const platformOrganizationSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    /** `internal` (Agentur) oder `client` (Kunden-Org). */
    type: z.string(),
    /** Kunden-Org nach Typ oder Verknüpfung: nur lesend, nur Kunden-Features buchbar. */
    customerOrg: z.boolean(),
    memberCount: z.int(),
    /** Verknüpfter Client einer Kunden-Org. */
    client: z.union([
      z.object({ id: z.uuid(), name: z.string(), ownerOrganizationId: z.uuid() }),
      z.null(),
    ]),
    /** Gebuchte Feature-Keys, sortiert. */
    features: z.array(z.string()),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'PlatformOrganization' });
export type PlatformOrganization = z.infer<typeof platformOrganizationSchema>;

export const platformOrganizationListSchema = z
  .object({ organizations: z.array(platformOrganizationSchema) })
  .meta({ id: 'PlatformOrganizationList' });
export type PlatformOrganizationList = z.infer<typeof platformOrganizationListSchema>;

/** Anlegen und Umbenennen; der Slug folgt beim Anlegen aus dem Namen. */
export const platformOrganizationNameSchema = z
  .object({ name: z.string().trim().min(1).max(120) })
  .meta({ id: 'PlatformOrganizationName' });

/** Ersetzt die gebuchten Features der Organisation. */
export const platformEntitlementsSchema = z
  .object({ features: z.array(z.enum(FEATURE_KEYS)).max(FEATURE_KEYS.length) })
  .meta({ id: 'PlatformEntitlements' });

export const platformStaffSchema = z
  .object({ id: z.uuid(), name: z.string(), email: z.string(), isSelf: z.boolean() })
  .meta({ id: 'PlatformStaff' });
export type PlatformStaff = z.infer<typeof platformStaffSchema>;

export const platformStaffListSchema = z
  .object({ staff: z.array(platformStaffSchema) })
  .meta({ id: 'PlatformStaffList' });
export type PlatformStaffList = z.infer<typeof platformStaffListSchema>;

/** Superadmin-Rolle an einen vorhandenen Nutzer vergeben. */
export const platformStaffGrantSchema = z
  .object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) })
  .meta({ id: 'PlatformStaffGrant' });

/** Mitglieder einer Organisation im Plattform-Admin: Auswahl für „Als Nutzer ansehen“ (6.5). */
export const platformMemberSchema = z
  .object({
    userId: z.uuid(),
    name: z.string(),
    email: z.string(),
    role: z.string(),
    /** Superadmins lassen sich nicht ansehen. */
    superadmin: z.boolean(),
  })
  .meta({ id: 'PlatformMember' });
export type PlatformMember = z.infer<typeof platformMemberSchema>;

export const platformMemberListSchema = z
  .object({ members: z.array(platformMemberSchema) })
  .meta({ id: 'PlatformMemberList' });
export type PlatformMemberList = z.infer<typeof platformMemberListSchema>;

export const impersonationStartSchema = z
  .object({ userId: z.uuid() })
  .meta({ id: 'ImpersonationStart' });
