import { MAX_AD_CHANGES_PER_REQUEST } from '@profitbash/shared';
import type { AdChangeInputData, StageAdChangesData } from '../api/client';

/**
 * Vormerken in Stücken: Der Explorer lädt bis zu 10 000 Zeilen, eine Anfrage fasst höchstens
 * `MAX_AD_CHANGES_PER_REQUEST` Änderungen. Die Stücke gehen nacheinander raus, die Ergebnisse bleiben in der
 * Reihenfolge der Eingaben. Scheitert ein Stück, sind die früheren schon vorgemerkt (der Fehler geht an den Aufrufer).
 */
export async function stageInChunks(
  inputs: readonly AdChangeInputData[],
  send: (part: AdChangeInputData[]) => Promise<StageAdChangesData>,
): Promise<StageAdChangesData> {
  const merged: StageAdChangesData = {
    results: [],
    counts: { created: 0, updated: 0, removed: 0, unchanged: 0, rejected: 0 },
  };
  for (let start = 0; start < inputs.length; start += MAX_AD_CHANGES_PER_REQUEST) {
    const part = await send(inputs.slice(start, start + MAX_AD_CHANGES_PER_REQUEST));
    merged.results.push(...part.results);
    for (const key of Object.keys(merged.counts) as (keyof typeof merged.counts)[]) {
      merged.counts[key] += part.counts[key];
    }
  }
  return merged;
}
