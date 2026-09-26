import { parseKeyring } from '@profitbash/shared/crypto';
import {
  databaseUrlSchema,
  encryptionEnvSchema,
  loadEnv,
  refineKeyring,
} from '@profitbash/shared/env';
import { createDb } from './client';
import { reencryptConnectionTokens } from './key-rotation';

// Schlüsselrotation (docs/deploy.md). Dev: `pnpm db:rotate-keys` (tsx).
// Prod: gebündelt als `apps/api/dist/rotate-keys.js`. Wiederholbar.
// Exit-Code 1, wenn Werte nicht lesbar sind: Dann den alten Schlüssel noch nicht entfernen.
const env = loadEnv(
  databaseUrlSchema.extend(encryptionEnvSchema.shape).superRefine((value, ctx) => {
    refineKeyring(value, ctx);
  }),
);
// Bereits im Schema geprüft (refineKeyring), wirft hier also nicht mehr.
const keyring = parseKeyring(env);

const { db, close } = createDb(env.DATABASE_URL, { max: 2 });
try {
  const result = await reencryptConnectionTokens({ db, keyring });
  console.log(
    `Schlüsselrotation (aktueller Schlüssel ${keyring.current.id}): ` +
      `${result.checked} Connections geprüft, ${result.reencrypted} neu verschlüsselt, ` +
      `${result.failed.length} nicht lesbar.`,
  );
  for (const failure of result.failed) {
    console.error(
      `  Nicht lesbar: Connection ${failure.connectionId} ` +
        `(Organisation ${failure.organizationId}): ${failure.reason}`,
    );
  }
  if (result.failed.length > 0) {
    console.error(
      'Alte Schlüssel erst aus ENCRYPTION_KEYS_PREVIOUS entfernen, wenn diese Connections ' +
        'neu verbunden oder gelöscht sind.',
    );
    process.exitCode = 1;
  }
} finally {
  await close();
}
