import { canWrite, type OrgRole } from './roles';

/**
 * Feature-Keys für Entitlements und Rechte (siehe docs/plan.md §3).
 * Neue Features: hier ergänzen. In der DB ist der Key Text, es braucht keine Enum-Migration.
 */
export const FEATURE_KEYS = [
  'dashboard',
  'sp-explorer',
  'changes',
  'tags',
  'tools',
  'budgets',
  'automations',
  'goals',
  'profit',
  'dsp-explorer',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export function isFeatureKey(value: string): value is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(value);
}

export interface FeatureAccess {
  /** Der Nutzer darf das Feature sehen. */
  view: boolean;
  /** Der Nutzer darf im Feature Änderungen vornehmen. */
  write: boolean;
  /** Die Organisation hat das Feature gebucht. */
  entitled: boolean;
}

/**
 * Rechte je Feature aus der Org-Rolle und den gebuchten Features (`org_entitlements.enabled`).
 * Nicht gebuchte Features sind für alle gesperrt; `viewer` darf nur lesen; ohne Mitgliedschaft
 * (`role = null`) gibt es keine Rechte.
 */
export function resolveFeatureAccess(
  role: OrgRole | null,
  enabledFeatures: Iterable<string>,
): Record<FeatureKey, FeatureAccess> {
  const enabled = new Set(enabledFeatures);
  return Object.fromEntries(
    FEATURE_KEYS.map((feature) => {
      const entitled = enabled.has(feature);
      const member = role !== null;
      return [
        feature,
        { view: entitled && member, write: entitled && member && canWrite(role), entitled },
      ];
    }),
  ) as Record<FeatureKey, FeatureAccess>;
}
