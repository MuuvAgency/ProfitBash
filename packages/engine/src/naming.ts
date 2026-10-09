import type { NamingPlaceholder } from '@profitbash/shared/structure-catalog';

/**
 * Kampagnennamen aus dem Namensschema (`docs/tasks/phase-4.md` 4.2, F3), ohne I/O. Das Muster kommt aus dem
 * Struktur-Katalog der Organisation (`{adType} | {block} | {group} | {target}`); die Plan-Engine (4.3) setzt die Werte
 * je Kampagne ein und macht den Namen im Profil eindeutig.
 */

/**
 * Höchstlänge eines Kampagnennamens laut Limits-Seite von Amazon („Entity name character constraints“, gelesen am
 * 2026-10-09): 128 Zeichen für Seller, 116 für Vendoren (`campaignNameMaxLength`).
 */
export const MAX_CAMPAIGN_NAME_LENGTH = 128;
export const MAX_VENDOR_CAMPAIGN_NAME_LENGTH = 116;

/** Höchstlänge je Kontoart des Profils (`amazon_ads_profiles.account_type`). */
export const campaignNameMaxLength = (accountType: string): number =>
  accountType === 'vendor' ? MAX_VENDOR_CAMPAIGN_NAME_LENGTH : MAX_CAMPAIGN_NAME_LENGTH;

/**
 * Zeichen, die Amazon in Kampagnen- und Ad-Group-Namen annimmt (Limits-Seite, 2026-10-09): Leerzeichen, a–z, A–Z,
 * Ziffern, die Zeichen `- $ " ' & ( ) * + , . / : ; = ? @ \ [ ] _ \` ~ { } |`, ausgewählte Bereiche aus Latin-1 und
 * Latin Extended-A (Umlaute, ß, Akzente, polnische und türkische Buchstaben, Œ, Ÿ) sowie Hiragana, Katakana, Kanji,
 * Devanagari, Tamil und Arabisch. Nicht dabei sind z. B. `·`, `%`, `!`, `#` und Emoji.
 */
const NAME_CHARACTERS = new RegExp(
  '^[ a-zA-Z0-9\\-$"\'&()*+,./:;=?@\\\\[\\]_`~{}|' +
    '\\u00AE\\u00C0-\\u00CF\\u00D1-\\u00D6\\u00D9-\\u00DC\\u00DF\\u00E0-\\u00EF\\u00F1-\\u00F6\\u00F9-\\u00FC\\u00FF' +
    '\\u0104-\\u0107\\u0118\\u0119\\u0130\\u0131\\u0141-\\u0144\\u0152\\u0153\\u015A-\\u015F\\u0178\\u0179-\\u017E' +
    '\\u3000-\\u30FF\\u4E00-\\u9FFF\\u0900-\\u097F\\u0B80-\\u0BFF\\u0600-\\u06FF]*$',
  'u',
);

export type NamingValues = Partial<Record<NamingPlaceholder, string | null | undefined>>;
export type CampaignNameIssue = 'empty' | 'tooLong' | 'invalidCharacters';

const clean = (value: string | null | undefined) =>
  (value ?? '').normalize('NFC').split(/\s+/u).filter(Boolean).join(' ');

/**
 * Setzt die Werte ein. Ein leerer Platzhalter fällt samt dem Trenner davor weg, damit `SP | AUTO | Flaschen` ohne Ziel
 * nicht auf ` | ` endet. Trenner sind nur Leerraum und `| - _ / · : , ;`; anderer fester Text (Klammern, Buchstaben)
 * bleibt immer stehen. Unbekannte Platzhalter bleiben leer.
 */
export function renderCampaignName(pattern: string, values: NamingValues): string {
  let result = '';
  let last = 0;
  for (const match of pattern.matchAll(/([\s|\-_/·:,;]*)\{([^{}]*)\}/gu)) {
    result += pattern.slice(last, match.index);
    last = match.index + match[0].length;
    const value = clean(values[match[2] as NamingPlaceholder]);
    // Vor dem ersten Inhalt gibt es nichts zu trennen.
    if (value) result += (result.trim() ? match[1]! : '') + value;
  }
  return clean(result + pattern.slice(last));
}

/** Prüft einen Namen gegen die Grenzen von Amazon (Länge je Kontoart, erlaubte Zeichen). */
export function campaignNameIssues(
  name: string,
  maxLength: number = MAX_CAMPAIGN_NAME_LENGTH,
): CampaignNameIssue[] {
  if (name.trim() === '') return ['empty'];
  const issues: CampaignNameIssue[] = [];
  if ([...name].length > maxLength) issues.push('tooLong');
  if (!NAME_CHARACTERS.test(name)) issues.push('invalidCharacters');
  return issues;
}

/**
 * Eindeutig gegenüber `taken` (ohne Groß/Klein, wie Amazon Kampagnennamen im Profil vergleicht): Ist der Name
 * vergeben, kommt ` 2`, ` 3` … dazu; dafür wird das Ende des Namens so gekürzt, dass er in die Höchstlänge passt.
 */
export function uniqueCampaignName(
  name: string,
  taken: Iterable<string>,
  maxLength: number = MAX_CAMPAIGN_NAME_LENGTH,
): string {
  const used = new Set([...taken].map((entry) => entry.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let number = 2; ; number++) {
    const suffix = ` ${number}`;
    const base = [...name]
      .slice(0, maxLength - suffix.length)
      .join('')
      .trimEnd();
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
