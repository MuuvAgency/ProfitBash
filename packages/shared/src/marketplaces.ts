import { z } from 'zod';

/**
 * Amazon-Marktplätze mit den Werten, die Amazon für ein Werbeprofil liefert (`/v2/profiles`). Dient als
 * Vorschlag beim Anlegen von Profilen ohne Connection (Datei-Import, `phase-1.md` 1.11a): So stimmen Land,
 * Währung und Zeitzone mit dem späteren API-Profil überein. Ländercodes in Amazons Schreibweise (`UK`).
 */
export interface AmazonMarketplace {
  countryCode: string;
  currencyCode: string;
  timezone: string;
  marketplaceId: string;
}

export const AMAZON_MARKETPLACES: readonly AmazonMarketplace[] = [
  {
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    marketplaceId: 'A1PA6795UKMFR9',
  },
  {
    countryCode: 'FR',
    currencyCode: 'EUR',
    timezone: 'Europe/Paris',
    marketplaceId: 'A13V1IB3VIYZZH',
  },
  {
    countryCode: 'IT',
    currencyCode: 'EUR',
    timezone: 'Europe/Rome',
    marketplaceId: 'APJ6JRA9NG5V4',
  },
  {
    countryCode: 'ES',
    currencyCode: 'EUR',
    timezone: 'Europe/Madrid',
    marketplaceId: 'A1RKKUPIHCS9HS',
  },
  {
    countryCode: 'NL',
    currencyCode: 'EUR',
    timezone: 'Europe/Amsterdam',
    marketplaceId: 'A1805IZSGTT6HS',
  },
  {
    countryCode: 'BE',
    currencyCode: 'EUR',
    timezone: 'Europe/Brussels',
    marketplaceId: 'AMEN7PMS3EDWL',
  },
  {
    countryCode: 'IE',
    currencyCode: 'EUR',
    timezone: 'Europe/Dublin',
    marketplaceId: 'A28R8C7NBKEWEA',
  },
  {
    countryCode: 'UK',
    currencyCode: 'GBP',
    timezone: 'Europe/London',
    marketplaceId: 'A1F83G8C2ARO7P',
  },
  {
    countryCode: 'SE',
    currencyCode: 'SEK',
    timezone: 'Europe/Stockholm',
    marketplaceId: 'A2NODRKZP88ZB9',
  },
  {
    countryCode: 'PL',
    currencyCode: 'PLN',
    timezone: 'Europe/Warsaw',
    marketplaceId: 'A1C3SOZRARQ6R3',
  },
  {
    countryCode: 'TR',
    currencyCode: 'TRY',
    timezone: 'Europe/Istanbul',
    marketplaceId: 'A33AVAJ2PDY3EV',
  },
  {
    countryCode: 'US',
    currencyCode: 'USD',
    timezone: 'America/Los_Angeles',
    marketplaceId: 'ATVPDKIKX0DER',
  },
  {
    countryCode: 'CA',
    currencyCode: 'CAD',
    timezone: 'America/Los_Angeles',
    marketplaceId: 'A2EUQ1WTGCTBG2',
  },
];

export function marketplaceFor(countryCode: string): AmazonMarketplace | undefined {
  return AMAZON_MARKETPLACES.find((m) => m.countryCode === countryCode);
}

/** Kontotypen, die ein Profil ohne Connection haben kann (wie `accountInfo.type` bei Amazon). */
export const FILE_PROFILE_ACCOUNT_TYPES = ['seller', 'vendor', 'agency'] as const;

let canonicalTimeZones: ReadonlySet<string> | undefined;

/**
 * Nur kanonische IANA-Namen (`Europe/Berlin`). `Intl` nimmt auch Offsets (`+01:00`), Kürzel (`CET`) und
 * Kleinschreibung an; Postgres liest Offsets aber nach POSIX mit umgekehrtem Vorzeichen, die Tagesgrenzen
 * des Profils lägen dann falsch.
 */
export function isCanonicalTimeZone(value: string): boolean {
  canonicalTimeZones ??= new Set(Intl.supportedValuesOf('timeZone'));
  return canonicalTimeZones.has(value);
}

export const fileProfileCreateSchema = z
  .strictObject({
    accountName: z.string().trim().min(1).max(120),
    countryCode: z
      .string()
      .refine((code) => marketplaceFor(code) !== undefined, { message: 'unbekannter Marktplatz' }),
    currencyCode: z.string(),
    timezone: z.string().refine(isCanonicalTimeZone, { message: 'unbekannte Zeitzone' }),
    accountType: z.enum(FILE_PROFILE_ACCOUNT_TYPES),
  })
  // Amazon legt die Währung je Marktplatz fest; ein Tippfehler landete sonst in allen Umrechnungen.
  .refine((input) => marketplaceFor(input.countryCode)?.currencyCode === input.currencyCode, {
    message: 'Währung passt nicht zum Marktplatz',
    path: ['currencyCode'],
  })
  .meta({ id: 'FileProfileCreate' });
export type FileProfileCreate = z.infer<typeof fileProfileCreateSchema>;
