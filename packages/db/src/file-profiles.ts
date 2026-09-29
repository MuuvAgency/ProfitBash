import { marketplaceFor, type FileProfileCreate } from '@profitbash/shared';
import { AccessDeniedError, getOrgRole } from './access';
import { recordAuditEvent } from './audit';
import type { Db } from './client';
import { amazonAdsProfiles } from './schema';

/**
 * Profile ohne Connection (`phase-1.md` 1.11a): Ihre Daten kommen per Datei-Import aus der Werbekonsole.
 * Sie liegen in derselben Tabelle wie die API-Profile, damit Dashboard, Explorer und die Schreibschicht
 * (1.5) sie ohne Sonderweg nutzen und ein späterer API-Sync sie übernehmen kann (1.11g). Anlegen ist Org-Admins
 * vorbehalten (wie Connections).
 */

export interface FileProfileActor {
  userId: string;
  orgId: string;
}

async function requireAdmin(db: Db, actor: FileProfileActor): Promise<void> {
  const role = await getOrgRole(db, actor.userId, actor.orgId);
  if (role !== 'admin') {
    throw new AccessDeniedError('Nur Org-Admins verwalten Profile ohne Connection.');
  }
}

export async function createFileProfile(
  db: Db,
  input: FileProfileActor & { input: FileProfileCreate },
): Promise<{ id: string }> {
  await requireAdmin(db, input);
  const values = input.input;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(amazonAdsProfiles)
      .values({
        organizationId: input.orgId,
        connectionId: null,
        amazonProfileId: null,
        accountName: values.accountName,
        countryCode: values.countryCode,
        currencyCode: values.currencyCode,
        timezone: values.timezone,
        marketplaceId: marketplaceFor(values.countryCode)?.marketplaceId ?? null,
        accountType: values.accountType,
      })
      .returning({ id: amazonAdsProfiles.id });
    if (!row) throw new Error('Anlage des Profils lieferte keine Zeile.');
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'profile.create',
      target: { type: 'amazon_ads_profile', id: row.id, source: 'file', after: values },
    });
    return row;
  });
}
