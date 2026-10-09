import { describe, expect, it } from 'vitest';
import type { TagData } from '../api/client';
import { assignInChunks } from './queries';
import { amazonTagLabels, rowTags, rowTagsText } from './row-tags';

const tag = (id: string, name: string, color: TagData['color'] = 'violet'): TagData => ({
  id,
  name,
  color,
  counts: { campaign: 0, ad_group: 0, target: 0, product_ad: 0 },
  createdAt: '2026-10-09T08:00:00.000Z',
  updatedAt: '2026-10-09T08:00:00.000Z',
});
const tags = new Map([tag('t1', 'Winter'), tag('t2', 'Bestseller')].map((t) => [t.id, t]));

describe('rowTags', () => {
  it('liest die eigenen Tags nach Name und lässt unbekannte IDs weg', () => {
    const result = rowTags({ tagIds: ['t1', 'gelöscht', 't2'] }, tags);
    expect(result.own.map((t) => t.name)).toEqual(['Bestseller', 'Winter']);
    expect(rowTagsText(result)).toBe('Bestseller, Winter');
  });

  it('zeigt Amazon-Tags als Schlüssel und Wert, nach den eigenen', () => {
    const result = rowTags({ tagIds: ['t1'], amazonTags: { Saison: 'Winter', Marke: '' } }, tags);
    expect(result.amazon).toEqual(['Saison: Winter', 'Marke']);
    expect(rowTagsText(result)).toBe('Winter, Saison: Winter, Marke');
  });

  it('ohne Tags: kein Text', () => {
    expect(rowTagsText(rowTags({}, tags))).toBeNull();
    expect(amazonTagLabels('kaputt')).toEqual([]);
    expect(amazonTagLabels([{ key: 'a', value: 'b' }, 'c', 5])).toEqual(['a: b', 'c']);
  });
});

describe('assignInChunks', () => {
  it('schickt Stücke zu 1000 Entities und addiert die Ergebnisse', async () => {
    const sizes: number[] = [];
    const result = await assignInChunks(
      {
        entityType: 'target',
        entityIds: Array.from({ length: 2300 }, (_, i) => `e${i}`),
        addTagIds: ['t1'],
        removeTagIds: [],
      },
      async (part) => {
        sizes.push(part.entityIds.length);
        return { added: part.entityIds.length, removed: 1, skippedEntities: 2 };
      },
    );
    expect(sizes).toEqual([1000, 1000, 300]);
    expect(result).toEqual({ added: 2300, removed: 3, skippedEntities: 6 });
  });
});
