import { describe, expect, it } from 'vitest';
import { hasOrgRole } from './roles';

describe('hasOrgRole', () => {
  it.each([
    ['admin', 'admin', true],
    ['admin', 'editor', true],
    ['admin', 'viewer', true],
    ['editor', 'admin', false],
    ['editor', 'editor', true],
    ['editor', 'viewer', true],
    ['viewer', 'admin', false],
    ['viewer', 'editor', false],
    ['viewer', 'viewer', true],
  ] as const)('%s erfüllt mindestens %s: %s', (role, minimum, expected) => {
    expect(hasOrgRole(role, minimum)).toBe(expected);
  });

  it('ohne Rolle (kein Mitglied) ist nichts erfüllt', () => {
    expect(hasOrgRole(null, 'viewer')).toBe(false);
  });
});
