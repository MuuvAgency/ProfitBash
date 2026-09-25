import { createDb } from '@profitbash/db';
import {
  appUrlSchema,
  authSecretSchema,
  databaseUrlSchema,
  loadEnv,
  nodeEnvSchema,
  seedAdminSchema,
} from '@profitbash/shared/env';
import { createAuth } from './auth';
import { seed } from './seed';

const env = loadEnv(
  nodeEnvSchema
    .extend(appUrlSchema.shape)
    .extend(databaseUrlSchema.shape)
    .extend(authSecretSchema.shape)
    .extend(seedAdminSchema.shape),
);

const { db, close } = createDb(env.DATABASE_URL, { max: 2 });
try {
  const auth = createAuth({ db, secret: env.BETTER_AUTH_SECRET, baseURL: env.APP_URL });
  const result = await seed({
    db,
    auth,
    admin: { email: env.SEED_ADMIN_EMAIL, password: env.SEED_ADMIN_PASSWORD },
  });
  console.log(
    `Seed fertig: Admin ${result.createdUser ? 'angelegt' : 'vorhanden'} (${env.SEED_ADMIN_EMAIL}), ` +
      `Organisation Muuv ${result.createdOrganization ? 'angelegt' : 'vorhanden'}.`,
  );
} finally {
  await close();
}
