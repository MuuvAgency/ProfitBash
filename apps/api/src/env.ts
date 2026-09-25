import {
  appUrlSchema,
  databaseUrlSchema,
  loadEnv,
  nodeEnvSchema,
  workerModeSchema,
} from '@profitbash/shared';

export const apiEnvSchema = nodeEnvSchema
  .extend(appUrlSchema.shape)
  .extend(workerModeSchema.shape)
  .extend(databaseUrlSchema.shape);

export type ApiEnv = ReturnType<typeof loadApiEnv>;

export function loadApiEnv() {
  return loadEnv(apiEnvSchema);
}
