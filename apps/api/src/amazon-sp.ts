import type { ConnectionRef, RefreshTokenStore } from '@profitbash/amazon-ads';
import {
  createAmazonSpClient,
  createMockAmazonSpClient,
  type AmazonSpClient,
  type AmazonSpClientOptions,
  type AmazonSpCredentials,
  type AmazonSpMarketplaceParticipation,
} from '@profitbash/amazon-sp';
import { createConnectionTokenStore, getSpCredentials, type Db } from '@profitbash/db';
import type { Keyring } from '@profitbash/shared/crypto';
import type { Logger } from './logger';

export interface AmazonSpDeps {
  /** Client für gespeicherte Connections (Zugangsdaten und Refresh-Token aus der Datenbank). */
  client: AmazonSpClient;
  /**
   * Prüft eingegebene Zugangsdaten, bevor etwas gespeichert wird („Token eintragen“): ein Aufruf der
   * Marktplatz-Teilnahmen mit einem Wegwerf-Client. Wirft die Fehler des Clients.
   */
  verify(
    input: AmazonSpCredentials & { region: ConnectionRef['region']; refreshToken: string },
  ): Promise<AmazonSpMarketplaceParticipation[]>;
}

/** Wählt Mock (`AMAZON_SP_USE_MOCK`) oder echten SP-Client und verbindet ihn mit der Datenbank. */
export function createAmazonSpDeps(options: {
  useMock: boolean;
  db: Db;
  keyring: Keyring;
  logger?: Logger;
}): AmazonSpDeps {
  const { db, keyring, logger } = options;
  const create = (
    source: Pick<AmazonSpClientOptions, 'credentialsFor' | 'store'>,
  ): AmazonSpClient =>
    (options.useMock ? createMockAmazonSpClient : createAmazonSpClient)({
      ...source,
      ...(logger && { logger }),
    });
  // Typ-Absicherung: Der Token-Store aus @profitbash/db muss die Schnittstelle des Clients erfüllen.
  const store: RefreshTokenStore = createConnectionTokenStore({ db, keyring });
  return {
    client: create({
      store,
      credentialsFor: (connection) => getSpCredentials(db, keyring, connection),
    }),
    verify: ({ region, refreshToken, ...credentials }) =>
      create({
        credentialsFor: () => Promise.resolve(credentials),
        store: {
          withRefreshToken: async (_connection, refresh) => (await refresh(refreshToken)).result,
        },
      }).getMarketplaceParticipations({ id: 'verify', organizationId: 'verify', region }),
  };
}
