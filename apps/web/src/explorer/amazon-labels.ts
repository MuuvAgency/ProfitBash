/**
 * Lesbare Amazon-Werte im Explorer (`phase-2.md` 2.13): Match-Typ, Targeting und Gebotsstrategie übersetzt, Ausdrücke von
 * Targets ohne Keyword als Text statt JSON. Unbekannte Werte erscheinen wie geliefert (Amazon ergänzt gelegentlich).
 */

export type AmazonValueKind = 'matchType' | 'targetingType' | 'biddingStrategy';

export interface Labels {
  t: (key: string, values?: Record<string, unknown>) => string;
  te: (key: string) => boolean;
}

export function amazonLabel(
  kind: AmazonValueKind,
  value: string | null | undefined,
  { t, te }: Labels,
): string | null {
  if (!value) return null;
  const key = `explorer.amazon.${kind}.${value}`;
  return te(key) ? t(key) : value;
}

/** Auto-Targeting (SP) und Themen (SB) tragen nur einen Match-Typ, kein Keyword. */
const AUTO_MATCH_TYPES = new Set([
  'SEARCH_CLOSE_MATCH',
  'SEARCH_LOOSE_MATCH',
  'ASIN_SUBSTITUTE_RELATED',
  'ASIN_ACCESSORY_RELATED',
]);
const THEME_MATCH_TYPES = new Set([
  'KEYWORDS_RELATED_TO_YOUR_BRAND',
  'KEYWORDS_RELATED_TO_YOUR_LANDING_PAGES',
]);

const text = (value: unknown) =>
  typeof value === 'string' && value !== ''
    ? value
    : typeof value === 'number'
      ? String(value)
      : null;

/**
 * Target als Text aus den Attributen einer Zeile (`keywordText`, `matchType`, `expression` = `targetDetails` des Exports).
 * Die Art ergibt sich aus den Feldern des Ausdrucks, denn Negatives und Suchbegriffe tragen keinen `targetType`.
 */
export function targetLabel(attributes: Record<string, unknown>, labels: Labels): string | null {
  const { t } = labels;
  const expression =
    attributes.expression &&
    typeof attributes.expression === 'object' &&
    !Array.isArray(attributes.expression)
      ? (attributes.expression as Record<string, unknown>)
      : {};
  const matchType = text(attributes.matchType) ?? text(expression.matchType);
  const match = amazonLabel('matchType', matchType, labels);

  const keyword = text(attributes.keywordText) ?? text(expression.keyword);
  if (keyword) return match ? `${keyword} · ${match}` : keyword;

  const asin = text(expression.asin);
  if (asin) return t('explorer.amazon.target.asin', { asin });

  const category = text(expression.productCategoryResolved) ?? text(expression.productCategoryId);
  if (category) {
    const name = t('explorer.amazon.target.category', { name: category });
    // Verfeinerungen (z. B. Marke, Preis) dazu, sonst hießen verschiedene Targets derselben Kategorie gleich.
    const refinements = fieldList(expression, ['productCategoryId', 'productCategoryResolved']);
    return refinements ? `${name} (${refinements})` : name;
  }

  const event = text(expression.event);
  if (event) {
    const eventKey = `explorer.amazon.audienceEvent.${event}`;
    const shown = labels.te(eventKey) ? t(eventKey) : event;
    const days = text(expression.lookback);
    return days
      ? t('explorer.amazon.target.audience', { event: shown, days })
      : t('explorer.amazon.target.audienceWithoutDays', { event: shown });
  }

  if (matchType && AUTO_MATCH_TYPES.has(matchType)) {
    return t('explorer.amazon.target.auto', { match });
  }
  if (matchType && THEME_MATCH_TYPES.has(matchType)) {
    return t('explorer.amazon.target.theme', { match });
  }
  if (match) return match;

  // Unbekannte Form: Schlüssel und Werte als Liste statt JSON.
  return fieldList(expression, []);
}

/** Einfache Felder eines Ausdrucks als „Schlüssel: Wert“-Liste (ohne die genannten), `null` ohne solche Felder. */
function fieldList(expression: Record<string, unknown>, skip: string[]): string | null {
  const parts = Object.entries(expression)
    .filter(([key]) => !skip.includes(key))
    .map(([key, value]) => {
      const shown = text(value) ?? (typeof value === 'boolean' ? String(value) : null);
      return shown === null ? null : `${key}: ${shown}`;
    })
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(', ') : null;
}
