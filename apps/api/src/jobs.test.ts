import { describe, expect, it } from 'vitest';
import { createUnavailableJobQueue } from './jobs';
import type { LogEntry } from './logger';

describe('createUnavailableJobQueue', () => {
  it('meldet, dass der Profil-Sync bis 0.7 (pg-boss) nicht eingeplant wird', async () => {
    const logs: LogEntry[] = [];
    const jobs = createUnavailableJobQueue((entry) => logs.push(entry));
    await jobs.enqueueProfilesSync({ organizationId: 'org-1', connectionId: 'conn-1' });
    expect(logs).toEqual([
      {
        level: 'warn',
        msg: 'jobs.not_available',
        job: 'profiles-sync',
        organizationId: 'org-1',
        connectionId: 'conn-1',
      },
    ]);
  });
});
