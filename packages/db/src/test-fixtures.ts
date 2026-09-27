import type { Db } from './client';
import { amazonAdsProfiles, connections, organizations } from './schema';

/**
 * Stammdaten für DB-Tests (Organisation, Connection, Profil). Nur für Tests, nicht aus `index.ts`
 * exportiert.
 */

export async function createTestOrganization(db: Db, slug: string): Promise<string> {
  const [org] = await db
    .insert(organizations)
    .values({ name: slug, slug, type: 'internal', createdAt: new Date() })
    .returning({ id: organizations.id });
  if (!org) throw new Error('Organisation fehlt');
  return org.id;
}

export async function createTestConnection(
  db: Db,
  organizationId: string,
  externalAccountId: string,
): Promise<string> {
  const [row] = await db
    .insert(connections)
    .values({
      organizationId,
      provider: 'amazon_ads',
      region: 'eu',
      externalAccountId,
      refreshTokenEncrypted: 'verschlüsselt',
    })
    .returning({ id: connections.id });
  if (!row) throw new Error('Connection fehlt');
  return row.id;
}

export async function createTestProfile(
  db: Db,
  input: {
    organizationId: string;
    connectionId: string;
    amazonProfileId: string;
    currencyCode?: string;
  },
): Promise<string> {
  const [row] = await db
    .insert(amazonAdsProfiles)
    .values({
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      amazonProfileId: input.amazonProfileId,
      accountName: `Konto ${input.amazonProfileId}`,
      countryCode: 'DE',
      currencyCode: input.currencyCode ?? 'EUR',
      timezone: 'Europe/Berlin',
      accountType: 'seller',
    })
    .returning({ id: amazonAdsProfiles.id });
  if (!row) throw new Error('Profil fehlt');
  return row.id;
}
