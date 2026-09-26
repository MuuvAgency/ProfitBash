import { describe, expect, it } from 'vitest';
import { jobRunFixture } from '../test/fixtures';
import { JOB_RUNS_POLL_INTERVAL_MS, jobRunsPollInterval } from './queries';

const now = Date.parse('2026-09-26T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const done = [jobRunFixture(), jobRunFixture({ status: 'failed' })];

describe('jobRunsPollInterval', () => {
  it('fragt nach, solange ein Lauf läuft', () => {
    const runs = [...done, jobRunFixture({ status: 'running', startedAt: minutesAgo(2) })];
    expect(jobRunsPollInterval(runs, { now })).toBe(JOB_RUNS_POLL_INTERVAL_MS);
  });

  it('fragt nicht nach, wenn alle Läufe beendet sind oder noch nichts geladen ist', () => {
    expect(jobRunsPollInterval(done, { now })).toBe(false);
    expect(jobRunsPollInterval(undefined, { now })).toBe(false);
  });

  it('ignoriert Läufe, die seit über einer Stunde „laufen“ (abgebrochen, räumt der Cleanup auf)', () => {
    const stuck = jobRunFixture({ status: 'running', startedAt: minutesAgo(61), finishedAt: null });
    expect(jobRunsPollInterval([stuck], { now })).toBe(false);
  });

  it('fragt eine Minute lang nach, nachdem ein Sync angefordert wurde (der Lauf fehlt noch)', () => {
    expect(jobRunsPollInterval(done, { now, requestedAt: now - 10_000 })).toBe(
      JOB_RUNS_POLL_INTERVAL_MS,
    );
    expect(jobRunsPollInterval(done, { now, requestedAt: now - 61_000 })).toBe(false);
  });
});
