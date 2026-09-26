import type { JobRun } from '@profitbash/shared';
import type { ICellRendererParams } from 'ag-grid-community';

/** Kontext der Jobtabelle (`context` des Grids), reaktiv: Zellen sehen Auf-/Zuklappen sofort. */
export interface JobRunGridContext {
  /** IDs der Läufe mit aufgeklapptem Fehlertext. */
  expanded: Set<string>;
  toggleError: (runId: string) => void;
}

export type JobRunCellParams = ICellRendererParams<JobRun, unknown, JobRunGridContext>;
