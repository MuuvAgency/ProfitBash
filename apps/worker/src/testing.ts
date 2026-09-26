// Test-Hilfen für den Worker. Nur aus Tests importieren.
import { randomBytes } from 'node:crypto';
import type { AmazonAdsProfile } from '@profitbash/amazon-ads';
import { schema, type Db } from '@profitbash/db';
import { connectionTokenAad, encrypt, parseKeyring } from '@profitbash/shared/crypto';

const { connections, organizations } = schema;

export const testKeyring = parseKeyring({
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  ENCRYPTION_KEY_ID: 'k1',
});

export async function createOrganization(db: Db, slug: string): Promise<string> {
  const [org] = await db
    .insert(organizations)
    .values({ name: slug, slug, type: 'internal', createdAt: new Date() })
    .returning({ id: organizations.id });
  if (!org) throw new Error('Organisation fehlt');
  return org.id;
}

/** Legt eine Amazon-Ads-Connection mit verschlüsseltem Refresh-Token an. */
export async function createConnection(
  db: Db,
  input: {
    organizationId: string;
    externalAccountId: string;
    status?: 'active' | 'reauth_required' | 'error';
    refreshToken?: string;
  },
): Promise<string> {
  const naturalKey = {
    organizationId: input.organizationId,
    provider: 'amazon_ads' as const,
    region: 'eu' as const,
    externalAccountId: input.externalAccountId,
  };
  const [row] = await db
    .insert(connections)
    .values({
      ...naturalKey,
      status: input.status ?? 'active',
      refreshTokenEncrypted: encrypt(input.refreshToken ?? 'Atzr|mock-refresh-test', {
        keyring: testKeyring,
        aad: connectionTokenAad(naturalKey),
      }),
    })
    .returning({ id: connections.id });
  if (!row) throw new Error('Connection fehlt');
  return row.id;
}

export function amazonProfile(
  amazonProfileId: string,
  overrides: Partial<AmazonAdsProfile> = {},
): AmazonAdsProfile {
  return {
    amazonProfileId,
    amazonAccountId: 'A1SELLER',
    accountName: `Konto ${amazonProfileId}`,
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    marketplaceId: 'A1PA6795UKMFR9',
    accountType: 'seller',
    ...overrides,
  };
}
