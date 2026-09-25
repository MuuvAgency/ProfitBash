import { databaseDirectUrlSchema, loadEnv, nodeEnvSchema } from '@profitbash/shared';

export const workerEnvSchema = nodeEnvSchema.extend(databaseDirectUrlSchema.shape);

export function loadWorkerEnv() {
  return loadEnv(workerEnvSchema);
}
