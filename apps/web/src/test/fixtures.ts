import {
  FEATURE_KEYS,
  type Client,
  type Connection,
  type FeatureKey,
  type JobRun,
  type MeResponse,
  type OrgRole,
  type Profile,
} from '@profitbash/shared';

export interface MeFixtureOptions {
  platformRole?: MeResponse['user']['role'];
  orgRole?: OrgRole;
  /** Features mit `view = true`; Standard: alle. */
  features?: readonly FeatureKey[];
  /** `false`: Nutzer ohne Organisation. */
  withOrganization?: boolean;
}

/** `/api/me`-Antwort für Tests. Standard: Org-Admin von Muuv mit allen Features. */
export function meFixture(options: MeFixtureOptions = {}): MeResponse {
  const {
    platformRole = 'user',
    orgRole = 'admin',
    features = FEATURE_KEYS,
    withOrganization = true,
  } = options;
  const visible = new Set<string>(features);
  return {
    user: { id: 'user-1', email: 'dominik@muuv.test', name: 'Dominik', role: platformRole },
    organizations: withOrganization
      ? [{ id: 'org-1', name: 'Muuv', slug: 'muuv', type: 'internal', role: orgRole }]
      : [],
    activeOrganizationId: withOrganization ? 'org-1' : null,
    features: Object.fromEntries(
      FEATURE_KEYS.map((key) => [
        key,
        {
          view: withOrganization && visible.has(key),
          write: withOrganization && visible.has(key) && orgRole !== 'viewer',
          entitled: visible.has(key),
        },
      ]),
    ) as MeResponse['features'],
    preferences: { theme: 'system', locale: 'de-DE', density: 'comfortable' },
  };
}

export const CONNECTION_ID = '0b9e1c7e-5a1d-4f3e-9c1a-2f6d8e4b7a01';

export function connectionFixture(overrides: Partial<Connection> = {}): Connection {
  return {
    id: CONNECTION_ID,
    provider: 'amazon_ads',
    region: 'eu',
    externalAccountId: 'amzn1.account.MOCK',
    externalAccountEmail: 'ads@muuv.test',
    status: 'active',
    lastRefreshedAt: '2026-09-26T08:15:00.000Z',
    consentedAt: '2026-09-20T10:00:00.000Z',
    refreshTokenExpiresAt: '2027-09-20T10:00:00.000Z',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-26T08:15:00.000Z',
    ...overrides,
  };
}

let profileCounter = 0;

export function profileFixture(overrides: Partial<Profile> = {}): Profile {
  profileCounter += 1;
  const suffix = String(profileCounter).padStart(12, '0');
  return {
    id: `7c3f2a10-1b2c-4d5e-8f90-${suffix}`,
    connectionId: CONNECTION_ID,
    clientId: null,
    amazonProfileId: `33871${suffix}`,
    amazonAccountId: 'A2EUQ1WTGCTBG2',
    accountName: 'Nordwind GmbH',
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    marketplaceId: 'A1PA6795UKMFR9',
    accountType: 'seller',
    isHidden: false,
    removedAt: null,
    syncedAt: '2026-09-26T03:00:00.000Z',
    metricsImportedThrough: '2026-09-25',
    lastBulkImportAt: null,
    ...overrides,
  };
}

export function clientFixture(overrides: Partial<Client> = {}): Client {
  return {
    id: '5d1e8a2b-3c4f-4a6b-9d7e-1f2a3b4c5d6e',
    name: 'Nordwind',
    slug: 'nordwind',
    createdAt: '2026-09-21T09:00:00.000Z',
    updatedAt: '2026-09-21T09:00:00.000Z',
    ...overrides,
  };
}

let jobRunCounter = 0;

/** Erfolgreicher Profil-Sync der Fixture-Connection; `overrides` für Status, Fehler usw. */
export function jobRunFixture(overrides: Partial<JobRun> = {}): JobRun {
  jobRunCounter += 1;
  return {
    id: `9a8b7c6d-1e2f-4a3b-8c4d-${String(jobRunCounter).padStart(12, '0')}`,
    job: 'profiles-sync',
    scope: CONNECTION_ID,
    profile: null,
    connection: {
      id: CONNECTION_ID,
      externalAccountId: 'amzn1.account.MOCK',
      externalAccountEmail: 'ads@muuv.test',
    },
    status: 'success',
    startedAt: '2026-09-26T03:00:00.000Z',
    finishedAt: '2026-09-26T03:00:04.200Z',
    error: null,
    counters: { profiles: 4, created: 0, reassigned: 0, removed: 0, removalDeferred: 0 },
    ...overrides,
  };
}
