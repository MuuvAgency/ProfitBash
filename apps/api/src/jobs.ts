import type { Logger } from './logger';

export interface ProfilesSyncJob {
  organizationId: string;
  connectionId: string;
}

/**
 * Hintergrundjobs, die die API anstößt. Die Umsetzung mit pg-boss (`runJob`, `singletonKey` je
 * Connection) folgt in 0.7 im Worker; bis dahin nutzt der Server `createUnavailableJobQueue`.
 */
export interface JobQueue {
  enqueueProfilesSync(job: ProfilesSyncJob): Promise<void>;
}

/** Platzhalter bis 0.7: plant nichts ein und meldet das im Log. */
export function createUnavailableJobQueue(logger: Logger): JobQueue {
  return {
    enqueueProfilesSync(job) {
      logger({ level: 'warn', msg: 'jobs.not_available', job: 'profiles-sync', ...job });
      return Promise.resolve();
    },
  };
}
