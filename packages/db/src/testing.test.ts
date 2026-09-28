import { describe, expect, it } from 'vitest';
import { assertSafeTestDatabase, dropDatabaseForce } from './testing';

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

describe('dropDatabaseForce', () => {
  const denied = Object.assign(new Error('permission denied to terminate process'), {
    code: '42501',
  });

  it('wiederholt, wenn ein fremder Prozess (Autovacuum) nicht beendet werden darf', async () => {
    const statements: string[] = [];
    const pauses: number[] = [];
    let calls = 0;
    await dropDatabaseForce(
      async (statement) => {
        statements.push(statement);
        calls += 1;
        if (calls < 3) throw denied;
      },
      'profitbash_test_abc',
      { sleep: async (ms) => void pauses.push(ms) },
    );
    expect(statements).toEqual(
      Array(3).fill('DROP DATABASE IF EXISTS "profitbash_test_abc" WITH (FORCE)'),
    );
    expect(pauses).toHaveLength(2);
  });

  it('gibt nach den erlaubten Versuchen und bei anderen Fehlern auf', async () => {
    let calls = 0;
    const always = dropDatabaseForce(
      async () => {
        calls += 1;
        throw denied;
      },
      'profitbash_test_abc',
      { sleep: async () => {}, attempts: 4 },
    );
    await expect(always).rejects.toBe(denied);
    expect(calls).toBe(4);

    const other = Object.assign(new Error('kaputt'), { code: '3D000' });
    calls = 0;
    await expect(
      dropDatabaseForce(
        async () => {
          calls += 1;
          throw other;
        },
        'profitbash_test_abc',
        { sleep: async () => {} },
      ),
    ).rejects.toBe(other);
    expect(calls).toBe(1);
  });
});
