import { describe, expect, it } from 'vitest';
import { jobRunFixture } from '../test/fixtures';
import { JOB_RUNS_POLL_INTERVAL_MS, jobRunsPollInterval } from './queries';

describe('jobRunsPollInterval', () => {
  it('fragt nach, solange ein Lauf läuft', () => {
    const runs = [jobRunFixture(), jobRunFixture({ status: 'running', finishedAt: null })];
    expect(jobRunsPollInterval(runs)).toBe(JOB_RUNS_POLL_INTERVAL_MS);
  });

  it('fragt nicht nach, wenn alle Läufe beendet sind oder noch nichts geladen ist', () => {
    expect(jobRunsPollInterval([jobRunFixture(), jobRunFixture({ status: 'failed' })])).toBe(false);
    expect(jobRunsPollInterval(undefined)).toBe(false);
  });
});
