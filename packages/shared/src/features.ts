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
