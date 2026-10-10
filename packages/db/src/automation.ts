import {
  DEFAULT_AUTOMATION_MODE,
  DEFAULT_GUARDRAILS,
  guardrailOverridesSchema,
  guardrailsSchema,
  type AutomationMode,
  type GuardrailOverrides,
  type Guardrails,
} from '@profitbash/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { getOrgRole, listVisibleClientsAndProfiles, visibleProfilesScope } from './access';
import { recordAuditEvent } from './audit';
import type { Db } from './client';
import {
  amazonAdsProfiles,
  automationDefaults,
  clientAutomationSettings,
  members,
  users,
} from './schema';

/**
 * Leitplanken und Modus der Automatik (`docs/tasks/phase-5.md` 5.4): Startwerte der Organisation ändern nur
 * Org-Admins; Modus, zuständigen Nutzer und überschriebene Werte eines Clients setzt, wer mindestens ein Profil des
 * Clients sieht (Dominik, 2026-10-10). Das Recht (`view` bzw. `write` im Feature `automations`) prüft die API.
 */

export class AutomationError extends Error {
  constructor(
    public readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_RESPONSIBLE',
    message: string,
  ) {
    super(message);
    this.name = 'AutomationError';
  }
}

export interface AutomationAccessInput {
  userId: string;
  orgId: string;
}

export interface ClientAutomationRecord {
  mode: AutomationMode;
  responsibleUserId: string | null;
  overrides: GuardrailOverrides;
}

export interface AutomationSettingsRecord {
  defaults: Guardrails;
  canEditDefaults: boolean;
  clients: ({ id: string; name: string } & ClientAutomationRecord)[];
  members: { userId: string; name: string }[];
}

type Reader = Pick<Db, 'select'>;

const WRITE_ROLES = ['admin', 'editor'];

/** Leitplanken der Organisation ohne Rechteprüfung; ohne Zeile oder mit unlesbarem Dokument die Startwerte. */
export async function loadGuardrailDefaults(db: Reader, orgId: string): Promise<Guardrails> {
  const [row] = await db
    .select({ guardrails: automationDefaults.guardrails })
    .from(automationDefaults)
    .where(eq(automationDefaults.organizationId, orgId));
  const parsed = guardrailsSchema.safeParse(row?.guardrails);
  return parsed.success ? parsed.data : DEFAULT_GUARDRAILS;
}

function toClientRecord(
  row: typeof clientAutomationSettings.$inferSelect | undefined,
): ClientAutomationRecord {
  const overrides = guardrailOverridesSchema.safeParse(row?.overrides);
  return {
    mode: (row?.mode as AutomationMode | undefined) ?? DEFAULT_AUTOMATION_MODE,
    responsibleUserId: row?.responsibleUserId ?? null,
    overrides: overrides.success ? overrides.data : {},
  };
}

/** Startwerte, sichtbare Clients mit ihren Einstellungen und die Mitglieder mit Schreibrecht. `null` für Nicht-Mitglieder. */
export async function getAutomationSettings(
  db: Db,
  access: AutomationAccessInput,
): Promise<AutomationSettingsRecord | null> {
  const role = await getOrgRole(db, access.userId, access.orgId);
  if (role === null) return null;
  const { clients } = await listVisibleClientsAndProfiles(db, access);
  const rows = await db
    .select()
    .from(clientAutomationSettings)
    .where(eq(clientAutomationSettings.organizationId, access.orgId));
  const byClient = new Map(rows.map((row) => [row.clientId, row]));
  const writers = await db
    .select({ userId: users.id, name: users.name })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, access.orgId), inArray(members.role, WRITE_ROLES)))
    .orderBy(asc(users.name), asc(users.id));
  return {
    defaults: await loadGuardrailDefaults(db, access.orgId),
    canEditDefaults: role === 'admin',
    clients: clients.map((c) => ({ id: c.id, name: c.name, ...toClientRecord(byClient.get(c.id)) })),
    members: writers,
  };
}

/**
 * Speichert die Leitplanken der Organisation (nur Org-Admins, sonst `FORBIDDEN`), Audit
 * `automation_defaults.update`. `null` für Nicht-Mitglieder.
 */
export async function saveGuardrailDefaults(
  db: Db,
  input: AutomationAccessInput & { guardrails: Guardrails },
): Promise<Guardrails | null> {
  const role = await getOrgRole(db, input.userId, input.orgId);
  if (role === null) return null;
  if (role !== 'admin') {
    throw new AutomationError('FORBIDDEN', 'Nur Admins ändern die Leitplanken der Organisation.');
  }
  // shortcut: letzter Schreiber gewinnt (kleines Formular, wenige Admins); bei Bedarf `version` wie beim Katalog.
  return db.transaction(async (tx) => {
    const before = await loadGuardrailDefaults(tx, input.orgId);
    const values = { guardrails: input.guardrails, updatedBy: input.userId };
    await tx
      .insert(automationDefaults)
      .values({ organizationId: input.orgId, ...values })
      .onConflictDoUpdate({
        target: automationDefaults.organizationId,
        set: { ...values, updatedAt: new Date() },
      });
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'automation_defaults.update',
      target: { type: 'automation_defaults', id: input.orgId, before, after: input.guardrails },
    });
    return input.guardrails;
  });
}

/**
 * Setzt Modus, zuständigen Nutzer und überschriebene Leitplanken eines Clients (Audit `client_automation.update`).
 * Im Modus `cart` ohne Angabe ist zuständig, wer speichert. `NOT_FOUND` für fremde Clients und solche ohne
 * sichtbares Profil, `INVALID_RESPONSIBLE` für Nutzer ohne Schreibrecht in der Organisation; `null` für Nicht-Mitglieder.
 */
export async function setClientAutomation(
  db: Db,
  input: AutomationAccessInput & { clientId: string } & ClientAutomationRecord,
): Promise<ClientAutomationRecord | null> {
  const visible = await visibleProfilesScope(db, input);
  if (visible === null) return null;
  return db.transaction(async (tx) => {
    const [seen] = await tx
      .select({ id: amazonAdsProfiles.id })
      .from(amazonAdsProfiles)
      .where(
        and(
          eq(amazonAdsProfiles.clientId, input.clientId),
          inArray(amazonAdsProfiles.id, visible.ids),
        ),
      )
      .limit(1);
    if (!seen) throw new AutomationError('NOT_FOUND', 'Client nicht gefunden.');
    const after: ClientAutomationRecord = {
      mode: input.mode,
      responsibleUserId: input.responsibleUserId ?? (input.mode === 'cart' ? input.userId : null),
      overrides: input.overrides,
    };
    if (after.responsibleUserId !== null) {
      const [writer] = await tx
        .select({ id: members.id })
        .from(members)
        .where(
          and(
            eq(members.organizationId, input.orgId),
            eq(members.userId, after.responsibleUserId),
            inArray(members.role, WRITE_ROLES),
          ),
        );
      if (!writer) {
        throw new AutomationError(
          'INVALID_RESPONSIBLE',
          'Zuständig kann nur ein Mitglied mit Schreibrecht sein.',
        );
      }
    }
    const [before] = await tx
      .select()
      .from(clientAutomationSettings)
      .where(eq(clientAutomationSettings.clientId, input.clientId));
    const values = { ...after, updatedBy: input.userId };
    await tx
      .insert(clientAutomationSettings)
      .values({ clientId: input.clientId, organizationId: input.orgId, ...values })
      .onConflictDoUpdate({
        target: clientAutomationSettings.clientId,
        set: { ...values, updatedAt: new Date() },
      });
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'client_automation.update',
      target: { type: 'client', id: input.clientId, before: toClientRecord(before), after },
    });
    return after;
  });
}
