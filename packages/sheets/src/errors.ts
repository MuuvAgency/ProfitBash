export type SheetReadErrorCode =
  'NOT_XLSX' | 'INVALID_XML' | 'TOO_LARGE' | 'SHEET_NOT_FOUND' | 'INVALID_CSV';

/** Datei nicht lesbar. Die Meldung nennt nie Inhalte der Datei (Kundendaten), nur Teile und Gründe. */
export class SheetReadError extends Error {
  constructor(
    public readonly code: SheetReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SheetReadError';
  }
}
