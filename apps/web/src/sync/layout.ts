/**
 * Breite der an ihren Inhalt angepassten Spalten des Sync-Status (Status, Job, Start, Dauer) bei den längsten Texten
 * („Fehlgeschlagen“, „Wechselkurse (EZB)“, Zeitstempel in Mono, Dauer mindestens 160 px), gemessen im Browser (2.12):
 * 124 + 174 + 204 + 160 px, aufgerundet. Amazon-Konto und Ergebnis müssen mit dieser Reserve unter `FIT_WIDTH_AT_1440`
 * bleiben.
 */
export const SYNC_AUTO_SIZED_WIDTH = 670;
