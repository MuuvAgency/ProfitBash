import { parseKeyring } from '@profitbash/shared/crypto';
import {
  amazonAdsEnvSchema,
  appUrlSchema,
  databaseDirectUrlSchema,
  databaseUrlSchema,
  encryptionEnvSchema,
  healthchecksEnvSchema,
  loadEnv,
  nodeEnvSchema,
  refineAmazonAdsCredentials,
  refineKeyring,
  workerModeSchema,
  type LoadEnvOptions,
} from '@profitbash/shared/env';
import type { z } from 'zod';
import type { JobName } from './run-job';

/**
 * Umgebung des eigenständigen Worker-Prozesses (`WORKER_MODE=separate`). Dieselben Regeln wie in der
 * API: Der Worker entschlüsselt Refresh-Tokens und spricht mit Amazon (bzw. dem Mock).
 */
export const workerEnvSchema = nodeEnvSchema
  .extend(appUrlSchema.shape)
  .extend(workerModeSchema.shape)
  .extend(databaseUrlSchema.shape)
  .extend(databaseDirectUrlSchema.shape)
  .extend(encryptionEnvSchema.shape)
  .extend(amazonAdsEnvSchema.shape)
  .extend(healthchecksEnvSchema.shape)
  .superRefine((env, ctx) => {
    refineKeyring(env, ctx);
    refineAmazonAdsCredentials(env, ctx);
  });

export type WorkerEnv = ReturnType<typeof loadWorkerEnv>;

export function loadWorkerEnv(options?: LoadEnvOptions) {
  const env = loadEnv(workerEnvSchema, options);
  // Bereits im Schema geprüft (refineKeyring), wirft hier also nicht mehr.
  return { ...env, keyring: parseKeyring(env) };
}

/** Ping-URLs je Job aus `HEALTHCHECKS_*` (API im Modus `inline` und Worker-Prozess). */
export function healthcheckUrls(
  env: z.output<typeof healthchecksEnvSchema>,
): Partial<Record<JobName, string | undefined>> {
  return {
    'token-refresh': env.HEALTHCHECKS_TOKEN_REFRESH_URL,
    'profiles-sync': env.HEALTHCHECKS_PROFILES_SYNC_URL,
    'entities-sync': env.HEALTHCHECKS_ENTITIES_SYNC_URL,
    'reports-sync': env.HEALTHCHECKS_REPORTS_SYNC_URL,
    // `amazon-requests-poll` pingt nicht (läuft oft und kurz); Fehler zeigt `reports-sync`.
  };
}
