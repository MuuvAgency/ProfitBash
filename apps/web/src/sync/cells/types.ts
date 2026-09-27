import type { JobRun } from '@profitbash/shared';
import type { ICellRendererParams } from 'ag-grid-community';

/** Kontext der Jobtabelle (`context` des Grids), reaktiv: Zellen sehen Auf-/Zuklappen sofort. */
export interface JobRunGridContext {
  /** IDs der Läufe mit aufgeklapptem Fehlertext. */
  expanded: Set<string>;
  toggleError: (runId: string) => void;
  /** Uhr (ms) für die Dauer laufender Jobs; tickt nur, solange einer läuft. */
  now: number;
}

export type JobRunCellParams = ICellRendererParams<JobRun, unknown, JobRunGridContext>;
