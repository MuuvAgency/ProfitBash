import type { TagColor } from '@profitbash/shared';

/**
 * Feste Palette der Tags (`TAG_COLORS`, Dominik 2026-10-09) als Klassen der Design-Tokens: Die Farbe steht als Punkt
 * vor dem Namen, der Text bleibt in der Tintenfarbe (lesbar in Hell und Dunkel).
 */
export const TAG_DOT_CLASS: Record<TagColor, string> = {
  violet: 'bg-violet',
  lime: 'bg-lime-deep',
  amber: 'bg-warn',
  red: 'bg-loss',
  ink: 'bg-ink',
  grey: 'bg-ink-tertiary',
};

/** Unbekannte Farbe (neuere Palette als die Oberfläche): neutral. */
export const tagDotClass = (color: string): string =>
  TAG_DOT_CLASS[color as TagColor] ?? TAG_DOT_CLASS.grey;
