import { createI18n } from 'vue-i18n';
import { de, type MessageSchema } from './de';

/** UI-Sprache ist Deutsch. Das Zahlenformat folgt separat der Einstellung `locale` (de-DE, en-GB, en-US). */
export const i18n = createI18n<[MessageSchema], 'de', false>({
  legacy: false,
  locale: 'de',
  fallbackLocale: 'de',
  messages: { de },
});

const ERROR_ALIASES: Record<string, keyof MessageSchema['errors']> = {
  HTTP_429: 'TOO_MANY_REQUESTS',
  INTERNAL_ERROR: 'SERVER',
};

/** i18n-Key für einen API-Fehlercode. Unbekannte Codes bekommen einen allgemeinen Text. */
export function errorMessageKey(code: string): string {
  if (code in de.errors) return `errors.${code}`;
  const alias = ERROR_ALIASES[code] ?? (/^HTTP_5\d\d$/.test(code) ? 'SERVER' : 'UNKNOWN');
  return `errors.${alias}`;
}
