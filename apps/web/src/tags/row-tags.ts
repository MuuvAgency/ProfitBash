import type { TagData } from '../api/client';

/**
 * Tags einer Explorer-Zeile (`phase-3.md` 3.7): eigene Tags aus `attributes.tagIds` (nach Name), dazu die Tags, die
 * Amazon an der Kampagne kennt (`attributes.amazonTags`, nur Anzeige).
 */
export interface RowTags {
  own: TagData[];
  amazon: string[];
}

export function ownTagIds(attributes: Record<string, unknown>): string[] {
  const value = attributes.tagIds;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/** Amazon liefert Tags als Schlüssel-Wert-Paare; andere Formen werden so gut wie möglich gelesen. */
export function amazonTagLabels(value: unknown): string[] {
  const label = (key: string, tagValue: unknown) =>
    typeof tagValue === 'string' && tagValue !== '' ? `${key}: ${tagValue}` : key;
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry === 'string') return [entry];
      if (typeof entry === 'object' && entry !== null) {
        const { key, value: tagValue } = entry as { key?: unknown; value?: unknown };
        return typeof key === 'string' ? [label(key, tagValue)] : [];
      }
      return [];
    });
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).map(([key, tagValue]) => label(key, tagValue));
  }
  return [];
}

export function rowTags(
  attributes: Record<string, unknown>,
  tags: ReadonlyMap<string, TagData>,
): RowTags {
  const own = ownTagIds(attributes)
    .flatMap((id) => tags.get(id) ?? [])
    .sort((a, b) => a.name.localeCompare(b.name));
  return { own, amazon: amazonTagLabels(attributes.amazonTags) };
}

/** Text der Zelle für Filter, Sortierung und CSV: Namen der eigenen Tags, dann die von Amazon. */
export function rowTagsText(tags: RowTags): string | null {
  const names = [...tags.own.map((tag) => tag.name), ...tags.amazon];
  return names.length > 0 ? names.join(', ') : null;
}
