/** Verlassen der App (z. B. zur Einwilligungsseite von Amazon). Als Objekt, damit Tests es ersetzen können. */
export const browserNavigation = {
  assign(url: string): void {
    globalThis.location.assign(url);
  },
};
