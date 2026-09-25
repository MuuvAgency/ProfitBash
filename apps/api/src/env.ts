import {
  appUrlSchema,
  authSecretSchema,
  databaseUrlSchema,
  loadEnv,
  nodeEnvSchema,
  workerModeSchema,
} from '@profitbash/shared/env';
import { z } from 'zod';

export const apiEnvSchema = nodeEnvSchema
  .extend(appUrlSchema.shape)
  .extend(workerModeSchema.shape)
  .extend(databaseUrlSchema.shape)
  .extend(authSecretSchema.shape)
  .extend({
    /** Von Railway gesetzt; dient als Version in `/api/health`. */
    RAILWAY_GIT_COMMIT_SHA: z.string().optional(),
  });

export type ApiEnv = ReturnType<typeof loadApiEnv>;

export function loadApiEnv() {
  return loadEnv(apiEnvSchema);
}
