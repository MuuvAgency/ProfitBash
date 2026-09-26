/** Höchstlänge eines Slugs (Clients, später weitere Entities). */
export const SLUG_MAX_LENGTH = 64;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const TRANSLITERATIONS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/**
 * Slug aus einem Namen: Kleinbuchstaben, Ziffern und einzelne Bindestriche. Umlaute werden
 * ausgeschrieben, übrige Akzente entfernt. Liefert `''`, wenn nichts Verwertbares übrig bleibt.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[äöüß]/g, (char) => TRANSLITERATIONS[char] ?? char)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
}

export function isSlug(value: string): boolean {
  return value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}
