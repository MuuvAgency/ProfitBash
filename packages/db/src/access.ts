import { isOrgRole, type OrgRole } from '@profitbash/shared';
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Db } from './client';
import {
  amazonAdsProfiles,
  clients,
  memberClientGrants,
  members,
  orgEntitlements,
  organizations,
} from './schema';

/**
 * Zentraler Access-Layer. ALLE Profil-Abfragen laufen hierüber (siehe CLAUDE.md).
 *
 * Regel Phase 0: Ein Mitglied sieht alle Profile seiner Organisation, die Amazon noch liefert
 * (`removed_at IS NULL`). Ausgeblendete Profile nur mit `includeHidden`, entfernte nur mit
 * `includeRemoved`, beides nur für Admins (Verwaltung unter Admin → Clients & Connections).
 *
 * Freigaben (Phase 6, 6.2): Ein Mitglied mit Einträgen in `member_client_grants` sieht nur Profile dieser Clients
 * (also auch keine ohne Client), eines ohne Einträge alle. Admins sehen immer alle.
 *
 * Kunden-Org (Phase 6, 6.3a): Ist `orgId` über `clients.client_organization_id` mit einem Client verknüpft, sehen
 * ihre Mitglieder genau dessen nicht ausgeblendete, nicht entfernte Profile, unabhängig von der Rolle. Die Daten
 * tragen weiter die `organization_id` der Eigentümer-Org (ADR 002).
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

interface MembershipRow {
  id: string;
  /** In einer Kunden-Org immer `viewer`, unabhängig vom gespeicherten Wert. */
  role: OrgRole;
  customerOrg: boolean;
  /** Nur Kunden-Org: der verknüpfte Client der Eigentümer-Org. */
  customerOf: { clientId: string; ownerOrgId: string } | null;
}

async function getMembership(db: Db, userId: string, orgId: string): Promise<MembershipRow | null> {
  const [membership] = await db
    .select({
      id: members.id,
      role: members.role,
      orgType: organizations.type,
      clientId: clients.id,
      ownerOrgId: clients.organizationId,
    })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .leftJoin(clients, eq(clients.clientOrganizationId, members.organizationId))
    .where(and(eq(members.userId, userId), eq(members.organizationId, orgId)))
    .limit(1);
  if (!membership || !isOrgRole(membership.role)) return null;
  const { id, orgType, clientId, ownerOrgId } = membership;
  const customerOf = clientId !== null && ownerOrgId !== null ? { clientId, ownerOrgId } : null;
  const customerOrg = isCustomerOrg(orgType, clientId);
  return { id, role: customerOrg ? 'viewer' : membership.role, customerOrg, customerOf };
}

/** Kunden-Org: nach Typ oder Verknüpfung, damit ein falsch gesetzter Wert allein nichts öffnet. */
const isCustomerOrg = (orgType: string, linkedClientId: string | null) =>
  orgType === 'client' || linkedClientId !== null;

/** Rolle des Nutzers in der Organisation oder `null`, wenn er kein Mitglied ist. In Kunden-Orgs immer `viewer`. */
export async function getOrgRole(db: Db, userId: string, orgId: string): Promise<OrgRole | null> {
  return (await getMembership(db, userId, orgId))?.role ?? null;
}

/** Clients, auf die das Mitglied eingeschränkt ist (Unterabfrage). */
const grantedClientIds = (db: Db, memberId: string) =>
  db
    .select({ clientId: memberClientGrants.clientId })
    .from(memberClientGrants)
    .where(eq(memberClientGrants.memberId, memberId));

/**
 * Clients, die der Nutzer sehen darf: `null` = alle der Organisation (Admin oder keine Freigaben), sonst die
 * freigegebenen. Kein Mitglied: leere Liste. Kunden-Org: nur der verknüpfte Client. Für Client-Daten ohne Profil
 * (Presets, Regeln je Client).
 */
export async function visibleClientIds(
  db: Db,
  input: { userId: string; orgId: string },
): Promise<string[] | null> {
  const membership = await getMembership(db, input.userId, input.orgId);
  if (membership === null) return [];
  if (membership.customerOrg) return membership.customerOf ? [membership.customerOf.clientId] : [];
  if (membership.role === 'admin') return null;
  const rows = await grantedClientIds(db, membership.id);
  return rows.length === 0 ? null : rows.map((row) => row.clientId);
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
 * Mitgliedschaften mit unbekannter Rolle werden ausgelassen (die DB lässt keine zu). In Kunden-Orgs ist die Rolle
 * immer `viewer` (wie `getOrgRole`).
 */
export async function listMemberships(db: Db, userId: string): Promise<Membership[]> {
  const rows = await db
    .select({
      organizationId: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      type: organizations.type,
      role: members.role,
      linkedClientId: clients.id,
    })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .leftJoin(clients, eq(clients.clientOrganizationId, members.organizationId))
    .where(eq(members.userId, userId))
    .orderBy(asc(members.createdAt), asc(organizations.id));
  return rows.flatMap(({ linkedClientId, role, ...row }) =>
    isOrgRole(role)
      ? [{ ...row, role: isCustomerOrg(row.type, linkedClientId) ? ('viewer' as const) : role }]
      : [],
  );
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
  const membership = await getMembership(db, input.userId, input.orgId);
  if (membership === null) return null;
  const { role } = membership;
  if (membership.customerOrg) {
    if (input.includeHidden || input.includeRemoved) {
      throw new AccessDeniedError(
        'Kunden-Orgs sehen keine ausgeblendeten oder entfernten Profile.',
      );
    }
    if (membership.customerOf === null) return [sql`false`];
    return [
      eq(amazonAdsProfiles.organizationId, membership.customerOf.ownerOrgId),
      eq(amazonAdsProfiles.clientId, membership.customerOf.clientId),
      isNull(amazonAdsProfiles.removedAt),
      eq(amazonAdsProfiles.isHidden, false),
    ];
  }
  if (input.includeHidden && role !== 'admin') {
    throw new AccessDeniedError('Nur Org-Admins dürfen ausgeblendete Profile sehen.');
  }
  if (input.includeRemoved && role !== 'admin') {
    throw new AccessDeniedError('Nur Org-Admins dürfen entfernte Profile sehen.');
  }

  const conditions: SQL[] = [eq(amazonAdsProfiles.organizationId, input.orgId)];
  if (!input.includeRemoved) conditions.push(isNull(amazonAdsProfiles.removedAt));
  if (!input.includeHidden) conditions.push(eq(amazonAdsProfiles.isHidden, false));
  if (role !== 'admin') {
    const granted = grantedClientIds(db, membership.id);
    conditions.push(
      sql`(not exists (${granted}) or ${amazonAdsProfiles.clientId} in (${granted}))`,
    );
  }
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

export interface VisibleProfileSummary {
  id: string;
  /** `null` bei Profilen ohne Connection (Datei-Import). */
  amazonProfileId: string | null;
  accountName: string;
  countryCode: string;
  currencyCode: string;
  timezone: string;
  accountType: string;
  clientId: string | null;
}

export interface VisibleClient {
  id: string;
  name: string;
  slug: string;
}

/**
 * Auswahl für die Filterleiste (`phase-2.md` F2): sichtbare Profile und die Clients, denen mindestens eines
 * davon gehört. Für alle Rollen; Clients ohne sichtbares Profil erscheinen nicht. Profile ohne Client haben
 * `clientId: null` („Ohne Client“). Kein Mitglied: leere Listen.
 */
export async function listVisibleClientsAndProfiles(
  db: Db,
  input: ProfileVisibilityInput,
): Promise<{ clients: VisibleClient[]; profiles: VisibleProfileSummary[] }> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return { clients: [], profiles: [] };
  const profiles = await db
    .select({
      id: amazonAdsProfiles.id,
      amazonProfileId: amazonAdsProfiles.amazonProfileId,
      accountName: amazonAdsProfiles.accountName,
      countryCode: amazonAdsProfiles.countryCode,
      currencyCode: amazonAdsProfiles.currencyCode,
      timezone: amazonAdsProfiles.timezone,
      accountType: amazonAdsProfiles.accountType,
      clientId: amazonAdsProfiles.clientId,
    })
    .from(amazonAdsProfiles)
    .where(inArray(amazonAdsProfiles.id, scope.ids))
    .orderBy(asc(amazonAdsProfiles.accountName), asc(amazonAdsProfiles.id));
  const clientIds = [...new Set(profiles.flatMap((p) => (p.clientId ? [p.clientId] : [])))];
  const visibleClients =
    clientIds.length === 0
      ? []
      : await db
          .select({ id: clients.id, name: clients.name, slug: clients.slug })
          .from(clients)
          // Ohne Filter nach `orgId`: Die IDs stammen aus dem Scope, bei Kunden-Orgs gehört der Client der Eigentümer-Org.
          .where(inArray(clients.id, clientIds))
          .orderBy(asc(clients.name), asc(clients.id));
  return { clients: visibleClients, profiles };
}
