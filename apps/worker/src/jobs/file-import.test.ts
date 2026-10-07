import { createFileImport, createFileProfile, schema } from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import { SheetReadError } from '@profitbash/sheets';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJobRunner, type JobRunResult } from '../run-job';
import { createOrganization } from '../testing';
import {
  FileImportRejectedError,
  importProfileFiles,
  type FileImportJobDeps,
  type FileImporters,
} from './file-import';

const { fileImportContents, fileImports, jobRuns, members, users } = schema;

let testDb: TestDatabase;
const ids = { org: '', admin: '', profile: '' };
const logs: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.org = await createOrganization(db, 'muuv');
  const [admin] = await db
    .insert(users)
    .values({ name: 'Ada', email: 'ada@muuv.test' })
    .returning({ id: users.id });
  ids.admin = admin!.id;
  await db
    .insert(members)
    .values({ organizationId: ids.org, userId: ids.admin, role: 'admin', createdAt: new Date() });
  ids.profile = (
    await createFileProfile(db, {
      userId: ids.admin,
      orgId: ids.org,
      input: {
        accountName: 'Datei',
        countryCode: 'DE',
        currencyCode: 'EUR',
        timezone: 'Europe/Berlin',
        accountType: 'seller',
      },
    })
  ).id;
});

afterAll(() => testDb?.close());

beforeEach(async () => {
  await testDb.db.delete(fileImports);
  await testDb.db.delete(jobRuns);
  logs.length = 0;
});

const upload = (kind: 'bulk' | 'daily_report', fileName: string, text = 'inhalt') =>
  createFileImport(testDb.db, {
    userId: ids.admin,
    orgId: ids.org,
    profileId: ids.profile,
    kind,
    fileName,
    content: new TextEncoder().encode(text),
    enqueue: async () => {},
  });

function run(importers: FileImporters, overrides: Partial<FileImportJobDeps> = {}) {
  const runJob = createJobRunner({ db: testDb.db, logger: (entry) => logs.push(entry) });
  const followUps: unknown[] = [];
  const deps: FileImportJobDeps = {
    db: testDb.db,
    logger: (entry) => logs.push(entry),
    importers,
    now: () => new Date('2026-09-29T10:00:00Z'),
    enqueueFollowUp: async (job) => {
      followUps.push(job);
    },
    ...overrides,
  };
  const result: Promise<JobRunResult> = importProfileFiles(runJob, deps, {
    organizationId: ids.org,
    profileId: ids.profile,
  });
  return { result, followUps };
}

const rows = () =>
  testDb.db
    .select({
      fileName: fileImports.fileName,
      status: fileImports.status,
      error: fileImports.error,
      counters: fileImports.counters,
      jobRunId: fileImports.jobRunId,
    })
    .from(fileImports)
    .orderBy(asc(fileImports.createdAt));

describe('importProfileFiles', () => {
  it('importiert alle offenen Dateien des Profils nacheinander und summiert die Zähler', async () => {
    await upload('bulk', 'bulk.xlsx', 'bulk-inhalt');
    await upload('daily_report', 'bericht.csv', 'bericht-inhalt');
    const seen: string[] = [];
    const { result } = run({
      bulk: async (input) => {
        seen.push(`${input.fileName}:${new TextDecoder().decode(input.content)}`);
        expect(input).toMatchObject({ organizationId: ids.org, profileId: ids.profile });
        return { campaigns: 3, created: 2 };
      },
      daily_report: async (input) => {
        seen.push(`${input.fileName}:${new TextDecoder().decode(input.content)}`);
        return { rows: 10, created: 1 };
      },
    });

    const outcome = await result;
    expect(outcome.status).toBe('success');
    expect(seen).toEqual(['bulk.xlsx:bulk-inhalt', 'bericht.csv:bericht-inhalt']);
    expect(await rows()).toEqual([
      expect.objectContaining({
        fileName: 'bulk.xlsx',
        status: 'imported',
        error: null,
        counters: { campaigns: 3, created: 2 },
        jobRunId: outcome.runId,
      }),
      expect.objectContaining({
        fileName: 'bericht.csv',
        status: 'imported',
        counters: { rows: 10, created: 1 },
      }),
    ]);
    const [jobRun] = await testDb.db.select().from(jobRuns);
    expect(jobRun).toMatchObject({
      job: 'file-import',
      organizationId: ids.org,
      scope: ids.profile,
      status: 'success',
      counters: { files: 2, imported: 2, filesFailed: 0, campaigns: 3, created: 3, rows: 10 },
    });
    expect(await testDb.db.select().from(fileImportContents)).toEqual([]);
  });

  it('meldet abgelehnte und unlesbare Dateien mit Grund, macht mit der nächsten weiter und schlägt Alarm', async () => {
    await upload('daily_report', 'falsch.csv');
    await upload('daily_report', 'kaputt.csv');
    await upload('daily_report', 'gut.csv');
    const { result } = run({
      daily_report: async (input) => {
        if (input.fileName === 'falsch.csv') {
          throw new FileImportRejectedError('Spalte „Datum“ fehlt.');
        }
        if (input.fileName === 'kaputt.csv') {
          throw new SheetReadError('INVALID_CSV', 'Ein Anführungszeichen ist nicht geschlossen.');
        }
        return { rows: 1 };
      },
    });

    const outcome = await result;
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(await rows()).toEqual([
      expect.objectContaining({
        fileName: 'falsch.csv',
        status: 'failed',
        error: 'Spalte „Datum“ fehlt.',
      }),
      expect.objectContaining({
        fileName: 'kaputt.csv',
        status: 'failed',
        error: 'Ein Anführungszeichen ist nicht geschlossen.',
      }),
      expect.objectContaining({ fileName: 'gut.csv', status: 'imported' }),
    ]);
    const [jobRun] = await testDb.db.select().from(jobRuns);
    expect(jobRun).toMatchObject({
      status: 'failed',
      counters: { files: 3, imported: 1, filesFailed: 2, rows: 1 },
    });
    expect(jobRun?.error).toContain('2');
  });

  it('nennt bei unerwarteten Fehlern keinen internen Text, loggt ihn aber', async () => {
    await upload('bulk', 'bulk.xlsx');
    const { result } = run({
      bulk: async () => {
        throw new Error('duplicate key value violates unique constraint "geheim"');
      },
    });
    await result;
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'failed' });
    expect(row?.error).not.toContain('geheim');
    expect(row?.error).toContain('Unerwarteter Fehler');
    expect(logs.some((entry) => entry.msg === 'file_import.failed')).toBe(true);
  });

  it('lehnt Dateiarten ohne Importer ab (bis 1.11d/1.11e)', async () => {
    await upload('bulk', 'bulk.xlsx');
    await run({}).result;
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'failed' });
    expect(row?.error).toContain('noch nicht');
  });

  it('endet ohne offene Dateien erfolgreich mit Nullen', async () => {
    const outcome = await run({}).result;
    expect(outcome.status).toBe('success');
    const [jobRun] = await testDb.db.select().from(jobRuns);
    expect(jobRun?.counters).toEqual({ files: 0, imported: 0, filesFailed: 0 });
  });

  it('plant sich nach dem Zeitbudget neu ein, statt weiterzuarbeiten', async () => {
    await upload('daily_report', 'eins.csv');
    await upload('daily_report', 'zwei.csv');
    let clock = new Date('2026-09-29T10:00:00Z').getTime();
    const { result, followUps } = run(
      {
        daily_report: async () => {
          clock += 6 * 60_000;
          return { rows: 1 };
        },
      },
      { now: () => new Date(clock) },
    );
    await result;
    expect(followUps).toEqual([{ organizationId: ids.org, profileId: ids.profile }]);
    const statuses = (await rows()).map((r) => r.status);
    expect(statuses).toEqual(['imported', 'pending']);
    const [imported] = await testDb.db
      .select({ status: fileImports.status })
      .from(fileImports)
      .where(eq(fileImports.fileName, 'zwei.csv'));
    expect(imported?.status).toBe('pending');
  });
});
