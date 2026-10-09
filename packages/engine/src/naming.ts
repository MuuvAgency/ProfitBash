import type { NamingPlaceholder } from '@profitbash/shared/structure-catalog';

/**
 * Kampagnennamen aus dem Namensschema (`docs/tasks/phase-4.md` 4.2, F3), ohne I/O. Das Muster kommt aus dem
 * Struktur-Katalog der Organisation (`{adType} | {block} | {group} | {target}`); die Plan-Engine (4.3) setzt die Werte
 * je Kampagne ein und macht den Namen im Profil eindeutig.
 */

/**
 * Höchstlänge eines Kampagnennamens. Annahme nach der Werbekonsole (128 Zeichen für SP, SB und SD); gegen die
 * Limits-Seite von Amazon zu prüfen (`phase-4.md`, „Offen vor dem Bau“).
 */
export const MAX_CAMPAIGN_NAME_LENGTH = 128;

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

/** Prüft einen Namen gegen die Grenzen von Amazon. */
export function campaignNameIssues(name: string): CampaignNameIssue[] {
  if (name.trim() === '') return ['empty'];
  const issues: CampaignNameIssue[] = [];
  if ([...name].length > MAX_CAMPAIGN_NAME_LENGTH) issues.push('tooLong');
  // Steuerzeichen (Tab, Zeilenumbruch …) gehen in der Bulk-Datei und in der Konsole kaputt.
  if (/\p{Cc}/u.test(name)) issues.push('invalidCharacters');
  return issues;
}

/**
 * Eindeutig gegenüber `taken` (ohne Groß/Klein, wie Amazon Kampagnennamen im Profil vergleicht): Ist der Name
 * vergeben, kommt ` 2`, ` 3` … dazu; dafür wird das Ende des Namens so gekürzt, dass er in die Höchstlänge passt.
 */
export function uniqueCampaignName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((entry) => entry.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let number = 2; ; number++) {
    const suffix = ` ${number}`;
    const base = [...name]
      .slice(0, MAX_CAMPAIGN_NAME_LENGTH - suffix.length)
      .join('')
      .trimEnd();
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
