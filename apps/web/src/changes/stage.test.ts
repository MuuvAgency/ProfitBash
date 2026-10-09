import { MAX_AD_CHANGES_PER_REQUEST } from '@profitbash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AdChangeInputData, StageAdChangesData } from '../api/client';
import { stageInChunks } from './stage';

const input = (index: number): AdChangeInputData => ({
  operation: 'update',
  entityType: 'target',
  entityId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  field: 'bid',
  value: '0.50',
});

describe('stageInChunks', () => {
  it('sendet mehr Änderungen, als eine Anfrage fasst, nacheinander und führt die Ergebnisse zusammen', async () => {
    const inputs = Array.from({ length: MAX_AD_CHANGES_PER_REQUEST + 2 }, (_, i) => input(i));
    const send = vi.fn(async (part: AdChangeInputData[]): Promise<StageAdChangesData> => {
      const rejected = part.length === 2;
      return {
        results: part.map(() =>
          rejected
            ? { outcome: 'rejected', reason: 'entityArchived' }
            : { outcome: 'created', changeId: 'c', otherUsers: 0 },
        ),
        counts: {
          created: rejected ? 0 : part.length,
          updated: 0,
          removed: 0,
          unchanged: 0,
          rejected: rejected ? 2 : 0,
        },
      };
    });

    const result = await stageInChunks(inputs, send);

    expect(send.mock.calls.map(([part]) => part.length)).toEqual([MAX_AD_CHANGES_PER_REQUEST, 2]);
    expect(result.results).toHaveLength(inputs.length);
    expect(result.results.at(-1)).toEqual({ outcome: 'rejected', reason: 'entityArchived' });
    expect(result.counts).toEqual({
      created: MAX_AD_CHANGES_PER_REQUEST,
      updated: 0,
      removed: 0,
      unchanged: 0,
      rejected: 2,
    });
  });
});
