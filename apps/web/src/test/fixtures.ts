import { FEATURE_KEYS, type FeatureKey, type MeResponse, type OrgRole } from '@profitbash/shared';

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
