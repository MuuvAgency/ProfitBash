import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorLogFields } from './errors';
import { organizations } from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.close();
});

describe('errorLogFields', () => {
  it('loggt fehlgeschlagene Abfragen ohne Parameterwerte', async () => {
    const secret = 'geheimer-wert-der-nicht-ins-log-darf';
    const values = { name: secret, slug: 'doppelt', type: 'internal', createdAt: new Date() };
    await testDb.db.insert(organizations).values(values);
    const error = await testDb.db
      .insert(organizations)
      .values(values)
      .then(
        () => null,
        (err: unknown) => err,
      );

    const fields = errorLogFields(error);
    expect(fields).toMatchObject({
      error: 'Datenbankabfrage fehlgeschlagen.',
      dbCode: '23505',
      dbConstraint: 'organizations_slug_unique',
    });
    expect(fields.query).toMatch(/insert into "organizations"/);
    expect(JSON.stringify(fields)).not.toContain(secret);
  });

  it('übernimmt Meldung und Stack anderer Fehler', () => {
    const error = new Error('kaputt');
    expect(errorLogFields(error)).toEqual({ error: 'kaputt', stack: error.stack });
    expect(errorLogFields('text')).toEqual({ error: 'text' });
  });
});
