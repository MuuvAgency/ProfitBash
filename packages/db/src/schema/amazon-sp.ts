import {
  boolean,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { clients, connections } from './app';
import { createdAt, id, organizationId, updatedAt } from './columns';

// ---------------------------------------------------------------------------
// Amazon SP-API (Phase 7): Zugangsdaten der App je Connection und Seller-Konten
// ---------------------------------------------------------------------------

/**
 * Client-ID und Secret der SP-API-App, über die eine Connection autorisiert wurde (`phase-7.md` F1: private
 * App, je Kunde eine eigene oder Public App). Das Secret ist verschlüsselt wie der Refresh-Token
 * (`spClientSecretAad`); die Schlüsselrotation verschlüsselt beide neu.
 */
export const amazonSpCredentials = pgTable(
  'amazon_sp_credentials',
  {
    connectionId: uuid('connection_id').primaryKey(),
    organizationId: organizationId(),
    clientId: text('client_id').notNull(),
    /** Verschlüsselt über `@profitbash/shared/crypto`. Nie im Klartext speichern, loggen oder ausliefern. */
    clientSecretEncrypted: text('client_secret_encrypted').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'amazon_sp_credentials_connection_org_fk',
      columns: [t.connectionId, t.organizationId],
      foreignColumns: [connections.id, connections.organizationId],
    }).onDelete('cascade'),
  ],
);

/**
 * Seller-Konto: ein Verkäuferkonto auf einem Marktplatz, Gegenstück zum Ads-Profil. Intern
 * `sellerAccountId`, bei Amazon `amazonSellerId` + `marketplaceId`. Sichtbarkeit nur über den Access-Layer
 * (`visibleSellerAccountsScope`).
 */
export const amazonSpAccounts = pgTable(
  'amazon_sp_accounts',
  {
    id: id(),
    organizationId: organizationId(),
    connectionId: uuid('connection_id').notNull(),
    /** Zugeordneter Client derselben Organisation (zusammengesetzter FK). */
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    amazonSellerId: text('amazon_seller_id').notNull(),
    marketplaceId: text('marketplace_id').notNull(),
    storeName: text('store_name').notNull(),
    countryCode: text('country_code').notNull(),
    currencyCode: text('currency_code').notNull(),
    timezone: text('timezone').notNull(),
    /** Vom Nutzer ausgeblendet. */
    isHidden: boolean('is_hidden').notNull().default(false),
    /** Der Verkäufer nimmt am Marktplatz nicht mehr teil. Wird beim erneuten Auftauchen zurückgesetzt. */
    removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }),
    syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('amazon_sp_accounts_org_seller_marketplace_uq').on(
      t.organizationId,
      t.amazonSellerId,
      t.marketplaceId,
    ),
    foreignKey({
      name: 'amazon_sp_accounts_connection_org_fk',
      columns: [t.connectionId, t.organizationId],
      foreignColumns: [connections.id, connections.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'amazon_sp_accounts_client_org_fk',
      columns: [t.clientId, t.organizationId],
      foreignColumns: [clients.id, clients.organizationId],
    }),
    index('amazon_sp_accounts_connection_idx').on(t.connectionId),
    index('amazon_sp_accounts_client_idx').on(t.clientId),
    // Ziel zusammengesetzter Fremdschlüssel der Verkaufsdaten (ab 7.3).
    unique('amazon_sp_accounts_id_org_uq').on(t.id, t.organizationId),
  ],
);
