import { isDeepStrictEqual } from 'node:util';
import type { CheckResult } from '@profitbash/engine';
import {
  CHECK_SEVERITY,
  checkSettingsSchema,
  DEFAULT_CHECK_SETTINGS,
  type CheckFindingFilter,
  type CheckKind,
  type CheckSettings,
} from '@profitbash/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  sql,
} from 'drizzle-orm';
import { getOrgRole, visibleProfilesScope } from './access';
import { chunks } from './ad-change-entities';
import { recordAuditEvent, type DbOrTx } from './audit';
import { AutomationError } from './automation';
import type { Db } from './client';
import {
  amazonAdsCampaigns,
  amazonAdsProfiles,
  amazonAdsTargets,
  automationCheckSettings,
  automationFindings,
} from './schema';

/**
 * Prüfungen „kein Geld verbrennen“ (`docs/tasks/phase-5.md` 5.10): Einstellungen je Organisation (nur Admins
 * ändern sie) und die aktuellen Befunde je Profil. Befunde schreibt der Lauf der Automatik (`syncAutomationFindings`,
 * Systemzugriff); lesen und quittieren laufen über `visibleProfilesScope()` (ADR 002). Das Recht (`view` bzw.
 * `write` im Feature `automations`) prüft die API.
 */

const f = automationFindings;

export interface AutomationChecksAccess {
  userId: string;
  orgId: string;
}

/** Einstellungen der Organisation ohne Rechteprüfung; ohne Zeile oder mit unlesbarem Dokument die Startwerte. */
export async function loadCheckSettings(db: DbOrTx, orgId: string): Promise<CheckSettings> {
  const [row] = await db
    .select({ settings: automationCheckSettings.settings })
    .from(automationCheckSettings)
    .where(eq(automationCheckSettings.organizationId, orgId));
  const parsed = checkSettingsSchema.safeParse(row?.settings);
  return parsed.success ? parsed.data : DEFAULT_CHECK_SETTINGS;
}

/**
 * Speichert die Einstellungen (nur Org-Admins, sonst `FORBIDDEN`), Audit `automation_checks.update`; ohne Änderung
 * schreibt es nichts. Sie wirken mit dem nächsten Lauf. `null` für Nicht-Mitglieder.
 */
export async function saveCheckSettings(
  db: Db,
  input: AutomationChecksAccess & { settings: CheckSettings },
): Promise<CheckSettings | null> {
  const role = await getOrgRole(db, input.userId, input.orgId);
  if (role === null) return null;
  if (role !== 'admin') {
    throw new AutomationError('FORBIDDEN', 'Nur Admins ändern die Einstellungen der Prüfungen.');
  }
  // shortcut: letzter Schreiber gewinnt (wie die Leitplanken).
  return db.transaction(async (tx) => {
    const before = await loadCheckSettings(tx, input.orgId);
    if (isDeepStrictEqual(before, input.settings)) return before;
    const values = { settings: input.settings, updatedBy: input.userId };
    await tx
      .insert(automationCheckSettings)
      .values({ organizationId: input.orgId, ...values })
      .onConflictDoUpdate({ target: automationCheckSettings.organizationId, set: values });
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'automation_checks.update',
      target: { type: 'automation_checks', id: input.orgId, before, after: input.settings },
    });
    return input.settings;
  });
}

export type FindingInput = CheckResult;

const keyOf = (x: { kind: string; entityId: string; key: string }) =>
  `${x.kind}:${x.entityId}:${x.key}`;

/**
 * Gleicht die Befunde eines Profils mit dem Ergebnis eines Laufs ab: Bestehende behalten ID, erstes Auftreten und
 * Quittung (Kennzahlen werden aktualisiert), neue kommen dazu, alle übrigen werden gelöscht. `added`: neue Befunde,
 * `addedWarnings`: davon Warnungen (lösen die Benachrichtigung aus).
 */
export async function syncAutomationFindings(
  db: DbOrTx,
  input: {
    organizationId: string;
    profileId: string;
    findings: readonly FindingInput[];
    now: Date;
  },
): Promise<{ total: number; added: number; addedWarnings: number }> {
  const ofProfile = and(
    eq(f.profileId, input.profileId),
    eq(f.organizationId, input.organizationId),
  );
  const existing = await db
    .select({ id: f.id, kind: f.kind, entityId: f.entityId, key: f.key })
    .from(f)
    .where(ofProfile);
  const known = new Map(existing.map((row) => [keyOf(row), row.id]));
  const kept: string[] = [];
  const added: FindingInput[] = [];
  for (const finding of input.findings) {
    const id = known.get(keyOf(finding));
    if (id === undefined) {
      added.push(finding);
      continue;
    }
    kept.push(id);
    await db.update(f).set({ detail: finding.detail, lastSeenAt: input.now }).where(eq(f.id, id));
  }
  await db.delete(f).where(and(ofProfile, kept.length > 0 ? notInArray(f.id, kept) : undefined));
  for (const part of chunks(added)) {
    await db.insert(f).values(
      part.map((finding) => ({
        ...finding,
        organizationId: input.organizationId,
        profileId: input.profileId,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
      })),
    );
  }
  return {
    total: input.findings.length,
    added: added.length,
    addedWarnings: added.filter((x) => CHECK_SEVERITY[x.kind] === 'warning').length,
  };
}

export interface CheckFindingRecord {
  id: string;
  profileId: string;
  accountName: string;
  currencyCode: string;
  kind: CheckKind;
  severity: 'warning' | 'info';
  entityType: 'campaign' | 'target' | 'profile';
  entityId: string;
  campaignName: string | null;
  keywordText: string | null;
  key: string;
  detail: Record<string, unknown>;
  firstSeenAt: Date;
  acknowledgedAt: Date | null;
}

export const CHECK_FINDING_LIST_LIMIT = 500;

/**
 * Einstellungen und Befunde der sichtbaren Profile, offen oder quittiert: Warnungen vor Hinweisen, dann neueste
 * zuerst, höchstens `CHECK_FINDING_LIST_LIMIT`; `total` zählt alle. `null` für Nicht-Mitglieder.
 */
export async function getAutomationChecks(
  db: Db,
  input: AutomationChecksAccess & { status: CheckFindingFilter },
): Promise<{
  settings: CheckSettings;
  canEditSettings: boolean;
  findings: CheckFindingRecord[];
  total: number;
} | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const where = and(
    inArray(f.profileId, scope.ids),
    input.status === 'open' ? isNull(f.acknowledgedAt) : isNotNull(f.acknowledgedAt),
  );
  const [counted] = await db.select({ total: count() }).from(f).where(where);
  const infoKinds = Object.entries(CHECK_SEVERITY).flatMap(([kind, severity]) =>
    severity === 'info' ? [kind] : [],
  );
  const rows = await db
    .select({
      finding: f,
      accountName: amazonAdsProfiles.accountName,
      currencyCode: amazonAdsProfiles.currencyCode,
      campaignName: amazonAdsCampaigns.name,
      keywordText: amazonAdsTargets.keywordText,
    })
    .from(f)
    .innerJoin(amazonAdsProfiles, eq(amazonAdsProfiles.id, f.profileId))
    .leftJoin(amazonAdsCampaigns, eq(amazonAdsCampaigns.id, f.campaignId))
    .leftJoin(
      amazonAdsTargets,
      and(eq(f.entityType, 'target'), eq(amazonAdsTargets.id, f.entityId)),
    )
    .where(where)
    .orderBy(asc(sql`${inArray(f.kind, infoKinds)}`), desc(f.firstSeenAt), asc(f.kind), asc(f.id))
    .limit(CHECK_FINDING_LIST_LIMIT);
  return {
    settings: await loadCheckSettings(db, input.orgId),
    canEditSettings: (await getOrgRole(db, input.userId, input.orgId)) === 'admin',
    total: counted!.total,
    findings: rows.map(({ finding, ...names }) => {
      const kind = finding.kind as CheckKind;
      return {
        id: finding.id,
        profileId: finding.profileId,
        ...names,
        kind,
        severity: CHECK_SEVERITY[kind] ?? 'info',
        entityType: finding.entityType as CheckFindingRecord['entityType'],
        entityId: finding.entityId,
        key: finding.key,
        detail: finding.detail,
        firstSeenAt: finding.firstSeenAt,
        acknowledgedAt: finding.acknowledgedAt,
      };
    }),
  };
}

/**
 * Quittiert offene Befunde sichtbarer Profile (Audit `automation_findings.acknowledge`). Ein quittierter Befund
 * bleibt es, solange er in jedem Lauf wieder auftritt (Dominik, 2026-10-11). `null` für Nicht-Mitglieder.
 */
export async function acknowledgeAutomationFindings(
  db: Db,
  input: AutomationChecksAccess & { ids: readonly string[] },
): Promise<{ changed: number; skipped: number } | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(f)
      .set({ acknowledgedBy: input.userId, acknowledgedAt: new Date() })
      .where(
        and(
          inArray(f.id, [...input.ids]),
          inArray(f.profileId, scope.ids),
          isNull(f.acknowledgedAt),
        ),
      )
      .returning({ id: f.id });
    if (rows.length > 0) {
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'automation_findings.acknowledge',
        target: { type: 'automation_findings', id: input.orgId, count: rows.length },
      });
    }
    return { changed: rows.length, skipped: input.ids.length - rows.length };
  });
}
