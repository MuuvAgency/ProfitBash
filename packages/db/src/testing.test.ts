import { describe, expect, it } from 'vitest';
import { assertSafeTestDatabase } from './testing';

const test = 'postgres://u:p@localhost:5432/profitbash_test';

describe('assertSafeTestDatabase', () => {
  it('akzeptiert eine eigene Datenbank mit _test-Endung', () => {
    expect(
      assertSafeTestDatabase(test, ['postgres://u:p@localhost:5432/profitbash', undefined]),
    ).toEqual({ template: 'profitbash_test' });
  });

  it('lehnt Datenbanken ohne _test-Endung ab (z. B. versehentlich die Dev-DB)', () => {
    expect(() => assertSafeTestDatabase('postgres://u:p@localhost/profitbash', [])).toThrow(
      /Endung "_test"/,
    );
    expect(() => assertSafeTestDatabase('postgres://u:p@localhost/test_profitbash', [])).toThrow();
  });

  it('lehnt dieselbe Datenbank wie DATABASE_URL ab', () => {
    expect(() => assertSafeTestDatabase(test, [test])).toThrow(/nicht dieselbe Datenbank/);
    expect(() =>
      assertSafeTestDatabase(test, ['postgres://x:y@localhost/profitbash_test']),
    ).toThrow(/nicht dieselbe Datenbank/);
  });

  it('erlaubt gleichen Namen auf einem anderen Server', () => {
    expect(() =>
      assertSafeTestDatabase(test, ['postgres://u:p@db.example.com:5432/profitbash_test']),
    ).not.toThrow();
  });
});
