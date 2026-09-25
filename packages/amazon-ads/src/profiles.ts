import { z } from 'zod';
import type { Logger } from './logger';

/**
 * Amazon-Ads-Profile (`GET /v2/profiles`), ein Profil je Werbekonto und Marktplatz.
 * Doku: https://advertising.amazon.com/API/docs/en-us/guides/get-started/retrieve-profiles
 */

/**
 * Amazon-ID als String. `parseJsonLossless` liefert unsichere Ganzzahlen bereits als String;
 * sichere Ganzzahlen werden hier umgewandelt. Dezimalzahlen sind keine gültige ID.
 */
export const amazonIdSchema = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
  .transform((value) => String(value));

export const KNOWN_ACCOUNT_TYPES = ['seller', 'vendor', 'agency'] as const;

/** Nur die Felder, die wir nutzen. `dailyBudget` (Float) wird bewusst nicht übernommen. */
export const profileResponseSchema = z.array(
  z.object({
    profileId: amazonIdSchema,
    countryCode: z.string().min(1),
    currencyCode: z.string().min(1),
    timezone: z.string().min(1),
    accountInfo: z.object({
      marketplaceStringId: z.string().min(1).optional(),
      id: z.union([z.string().min(1), amazonIdSchema]).optional(),
      /** Text statt Enum: Ein neuer Amazon-Wert darf den Sync nicht brechen. */
      type: z.string().min(1),
      name: z.string().min(1).optional(),
    }),
  }),
);

export interface AmazonAdsProfile {
  amazonProfileId: string;
  /** `accountInfo.id` (Seller-/Vendor-/Entity-ID) */
  amazonAccountId: string | null;
  accountName: string;
  countryCode: string;
  currencyCode: string;
  timezone: string;
  marketplaceId: string | null;
  /** `seller` | `vendor` | `agency` oder ein neuer Amazon-Wert (wird durchgereicht und geloggt) */
  accountType: string;
}

export function normalizeProfiles(
  response: z.output<typeof profileResponseSchema>,
  logger: Logger,
): AmazonAdsProfile[] {
  return response.map((profile) => {
    const { accountInfo } = profile;
    const amazonAccountId = accountInfo.id === undefined ? null : String(accountInfo.id);
    if (!(KNOWN_ACCOUNT_TYPES as readonly string[]).includes(accountInfo.type)) {
      logger({
        level: 'warn',
        msg: 'amazon_ads.unknown_enum_value',
        operation: 'profiles.list',
        field: 'accountInfo.type',
        value: accountInfo.type.slice(0, 64),
        amazonProfileId: profile.profileId,
      });
    }
    return {
      amazonProfileId: profile.profileId,
      amazonAccountId,
      accountName: accountInfo.name ?? amazonAccountId ?? profile.profileId,
      countryCode: profile.countryCode,
      currencyCode: profile.currencyCode,
      timezone: profile.timezone,
      marketplaceId: accountInfo.marketplaceStringId ?? null,
      accountType: accountInfo.type,
    };
  });
}
