import { describe, expect, it } from 'vitest';
import { resolveFeatureAccess } from './features';

describe('resolveFeatureAccess', () => {
  it('admin und editor dürfen in gebuchten Features lesen und schreiben', () => {
    for (const role of ['admin', 'editor'] as const) {
      const access = resolveFeatureAccess(role, ['dashboard']);
      expect(access.dashboard).toEqual({ view: true, write: true, entitled: true });
    }
  });

  it('viewer darf in gebuchten Features nur lesen', () => {
    const access = resolveFeatureAccess('viewer', ['dashboard']);
    expect(access.dashboard).toEqual({ view: true, write: false, entitled: true });
  });

  it('nicht gebuchte Features sind für jede Rolle gesperrt', () => {
    const access = resolveFeatureAccess('admin', ['dashboard']);
    expect(access.profit).toEqual({ view: false, write: false, entitled: false });
  });

  it('ohne Mitgliedschaft gibt es keine Rechte, auch wenn gebucht', () => {
    const access = resolveFeatureAccess(null, ['dashboard']);
    expect(access.dashboard).toEqual({ view: false, write: false, entitled: true });
  });

  it('liefert jeden Feature-Key und ignoriert unbekannte Keys aus der DB', () => {
    const access = resolveFeatureAccess('admin', ['dashboard', 'gibt-es-nicht']);
    expect(Object.keys(access).sort()).toEqual(
      [
        'automations',
        'budgets',
        'changes',
        'dashboard',
        'dsp-explorer',
        'goals',
        'profit',
        'sp-explorer',
        'tags',
        'tools',
      ].sort(),
    );
    expect(access).not.toHaveProperty('gibt-es-nicht');
  });
});
