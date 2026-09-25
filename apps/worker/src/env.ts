import { databaseDirectUrlSchema, loadEnv, nodeEnvSchema } from '@profitbash/shared/env';

export const workerEnvSchema = nodeEnvSchema.extend(databaseDirectUrlSchema.shape);

export function loadWorkerEnv() {
  return loadEnv(workerEnvSchema);
}
