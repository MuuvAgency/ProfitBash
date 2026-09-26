import type { Client, Profile, ProfilePatch } from '@profitbash/shared';
import type { ICellRendererParams } from 'ag-grid-community';

/** Kontext der Profiltabelle (`context` des Grids), reaktiv: Zellen sehen neue Clients sofort. */
export interface ProfileGridContext {
  clients: Client[];
  /** `false`, solange die Clients laden oder nicht geladen werden konnten: Zuordnung gesperrt. */
  clientsReady: boolean;
  patch: (profile: Profile, patch: ProfilePatch) => void;
  createClient: (profile: Profile) => void;
}

export type ProfileCellParams = ICellRendererParams<Profile, unknown, ProfileGridContext>;
