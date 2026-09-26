import { isOrgRole, type OrgRole } from '@profitbash/shared';
import { and, asc, eq, isNull, type SQL } from 'drizzle-orm';
import type { Db } from './client';
import { amazonAdsProfiles, members, orgEntitlements, organizations } from './schema';

/**
 * Zentraler Access-Layer. ALLE Profil-Abfragen laufen hierüber (siehe CLAUDE.md).
 *
 * Regel Phase 0: Ein Mitglied sieht alle Profile seiner Organisation, die Amazon noch liefert
 * (`removed_at IS NULL`). Ausgeblendete Profile nur mit `includeHidden`, entfernte nur mit
 * `includeRemoved`, beides nur für Admins (Verwaltung unter Admin → Clients & Connections).
 * Profil-Freigaben pro Mitglied (Phase 6) werden hier ergänzt, ohne die Signaturen zu ändern.
 */

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

export interface ProfileVisibilityInput {
  userId: string;
  orgId: string;
  /** Auch ausgeblendete Profile einbeziehen (nur Org-Admins). */
  includeHidden?: boolean;
  /** Auch Profile einbeziehen, die Amazon nicht mehr liefert (nur Org-Admins). */
  includeRemoved?: boolean;
}

/** Rolle des Nutzers in der Organisation oder `null`, wenn er kein Mitglied ist. */
export async function getOrgRole(db: Db, userId: string, orgId: string): Promise<OrgRole | null> {
  const [membership] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, orgId)))
    .limit(1);
  if (!membership) return null;
  return isOrgRole(membership.role) ? membership.role : null;
}

export interface Membership {
  organizationId: string;
  name: string;
  slug: string;
  type: string;
  role: OrgRole;
}

/**
 * Alle Organisationen, in denen der Nutzer Mitglied ist, älteste Mitgliedschaft zuerst.
 * Mitgliedschaften mit unbekannter Rolle werden ausgelassen (die DB lässt keine zu).
 */
export async function listMemberships(db: Db, userId: string): Promise<Membership[]> {
  const rows = await db
    .select({
      organizationId: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      type: organizations.type,
      role: members.role,
    })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(eq(members.userId, userId))
    .orderBy(asc(members.createdAt), asc(organizations.id));
  return rows.filter((row): row is Membership => isOrgRole(row.role));
}

/** Feature-Keys, die die Organisation gebucht und aktiviert hat (`org_entitlements.enabled`). */
export async function listEnabledFeatures(db: Db, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ feature: orgEntitlements.feature })
    .from(orgEntitlements)
    .where(and(eq(orgEntitlements.organizationId, orgId), eq(orgEntitlements.enabled, true)))
    .orderBy(asc(orgEntitlements.feature));
  return rows.map((row) => row.feature);
}

/**
 * Prüft Mitgliedschaft und Rechte und liefert die Filterbedingungen für sichtbare Profile,
 * oder `null`, wenn der Nutzer kein Mitglied der Organisation ist.
 */
async function visibilityConditions(db: Db, input: ProfileVisibilityInput): Promise<SQL[] | null> {
  const role = await getOrgRole(db, input.userId, input.orgId);
  if (role === null) return null;
  if (input.includeHidden && role !== 'admin') {
    throw new AccessDeniedError('Nur Org-Admins dürfen ausgeblendete Profile sehen.');
  }
  if (input.includeRemoved && role !== 'admin') {
    throw new AccessDeniedError('Nur Org-Admins dürfen entfernte Profile sehen.');
  }

  const conditions: SQL[] = [eq(amazonAdsProfiles.organizationId, input.orgId)];
  if (!input.includeRemoved) conditions.push(isNull(amazonAdsProfiles.removedAt));
  if (!input.includeHidden) conditions.push(eq(amazonAdsProfiles.isHidden, false));
  return conditions;
}

/**
 * Sichtbarkeits-Scope für Abfragen über viele Profile. `scope.ids` ist eine Unterabfrage der
 * sichtbaren `amazon_ads_profiles.id`, nutzbar als `inArray(table.profileId, scope.ids)`, ohne dass
 * eine ID-Liste in die Anwendung wandert. Liefert `null`, wenn der Nutzer kein Mitglied ist.
 *
 * Hinweis: Die Unterabfrage steckt bewusst in einem Objekt. Drizzle-Abfragen sind „thenable" und
 * würden beim `await` einer async-Funktion sonst sofort ausgeführt.
 */
export async function visibleProfilesScope(db: Db, input: ProfileVisibilityInput) {
  const conditions = await visibilityConditions(db, input);
  if (conditions === null) return null;
  return {
    ids: db
      .select({ id: amazonAdsProfiles.id })
      .from(amazonAdsProfiles)
      .where(and(...conditions)),
  };
}

/** Sichtbare Profil-IDs als Liste. Für kleine Mengen und Berechtigungsprüfungen. */
export async function visibleProfileIds(db: Db, input: ProfileVisibilityInput): Promise<string[]> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return [];
  const rows = await scope.ids;
  return rows.map((row) => row.id);
}

/** Darf der Nutzer dieses Profil sehen? `profileId` ist die interne ID (`amazon_ads_profiles.id`), nicht die Amazon-ID. */
export async function canSeeProfile(
  db: Db,
  input: ProfileVisibilityInput & { profileId: string },
): Promise<boolean> {
  const conditions = await visibilityConditions(db, input);
  if (conditions === null) return false;
  const [row] = await db
    .select({ id: amazonAdsProfiles.id })
    .from(amazonAdsProfiles)
    .where(and(...conditions, eq(amazonAdsProfiles.id, input.profileId)))
    .limit(1);
  return row !== undefined;
}
