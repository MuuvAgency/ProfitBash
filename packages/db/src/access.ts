import { isOrgRole, type OrgRole } from '@profitbash/shared';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { Db } from './client';
import { amazonAdsProfiles, members } from './schema';

/**
 * Zentraler Access-Layer. ALLE Profil-Abfragen laufen hierüber (siehe CLAUDE.md).
 *
 * Regel Phase 0: Ein Mitglied sieht alle Profile seiner Organisation, die Amazon noch liefert
 * (`removed_at IS NULL`). Ausgeblendete Profile nur mit `includeHidden`, und das nur für Admins.
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

  const conditions: SQL[] = [
    eq(amazonAdsProfiles.organizationId, input.orgId),
    isNull(amazonAdsProfiles.removedAt),
  ];
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

/** Darf der Nutzer dieses Profil sehen? (`profileId` = `amazon_ads_profiles.id`) */
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
