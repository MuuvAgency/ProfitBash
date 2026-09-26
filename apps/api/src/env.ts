import { parseKeyring } from '@profitbash/shared/crypto';
import {
  amazonAdsEnvSchema,
  appUrlSchema,
  authSecretSchema,
  databaseDirectUrlSchema,
  databaseUrlSchema,
  encryptionEnvSchema,
  healthchecksEnvSchema,
  loadEnv,
  nodeEnvSchema,
  oauthStateSecretSchema,
  refineAmazonAdsCredentials,
  refineKeyring,
  workerModeSchema,
  type LoadEnvOptions,
} from '@profitbash/shared/env';
import { z } from 'zod';

/** Pfad des OAuth-Callbacks. `AMAZON_ADS_REDIRECT_URI` muss genau hierauf zeigen. */
export const AMAZON_OAUTH_CALLBACK_PATH = '/api/amazon/oauth/callback';

export const apiEnvSchema = nodeEnvSchema
  .extend(appUrlSchema.shape)
  .extend(workerModeSchema.shape)
  .extend(databaseUrlSchema.shape)
  // pg-boss (Einplanen und bei WORKER_MODE=inline der Worker) braucht die direkte Verbindung.
  .extend(databaseDirectUrlSchema.shape)
  .extend(authSecretSchema.shape)
  .extend(encryptionEnvSchema.shape)
  .extend(oauthStateSecretSchema.shape)
  .extend(amazonAdsEnvSchema.shape)
  .extend(healthchecksEnvSchema.shape)
  .extend({
    /** Von Railway gesetzt; hat in Produktion Vorrang vor `API_PORT`. Leer gilt als nicht gesetzt. */
    PORT: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.coerce.number().int().min(1).max(65535).optional(),
    ),
    /** Von Railway gesetzt; dient als Version in `/api/health`. */
    RAILWAY_GIT_COMMIT_SHA: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    refineKeyring(env, ctx);
    refineAmazonAdsCredentials(env, ctx);
    // zod ruft superRefine auch nach Formatfehlern auf; die meldet das Feld dann selbst.
    if (!URL.canParse(env.APP_URL) || !URL.canParse(env.AMAZON_ADS_REDIRECT_URI)) return;
    // Der Callback braucht den Session-Cookie der App, also dieselbe Origin wie APP_URL.
    const redirect = new URL(env.AMAZON_ADS_REDIRECT_URI);
    if (
      redirect.origin !== new URL(env.APP_URL).origin ||
      redirect.pathname !== AMAZON_OAUTH_CALLBACK_PATH
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['AMAZON_ADS_REDIRECT_URI'],
        message: `muss auf \${APP_URL}${AMAZON_OAUTH_CALLBACK_PATH} zeigen (gleiche Origin wie die Session)`,
      });
    }
  });

export type ApiEnv = ReturnType<typeof loadApiEnv>;

export function loadApiEnv(options?: LoadEnvOptions) {
  const env = loadEnv(apiEnvSchema, options);
  // Bereits im Schema geprüft (refineKeyring), wirft hier also nicht mehr.
  // PORT gilt nur in Produktion (Railway). In der Entwicklung setzen Werkzeuge PORT oft für den
  // Web-Server; der Vite-Proxy leitet /api aber an API_PORT.
  const port = env.NODE_ENV === 'production' ? (env.PORT ?? env.API_PORT) : env.API_PORT;
  return { ...env, keyring: parseKeyring(env), port };
}
