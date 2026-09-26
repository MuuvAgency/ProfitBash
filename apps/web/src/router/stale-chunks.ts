/** Zeitpunkt des letzten automatischen Neuladens (sessionStorage, gilt je Tab). */
export const STALE_CHUNK_RELOAD_KEY = 'pb:stale-chunk-reload';

/** Innerhalb dieser Zeit nach einem Neuladen wird nicht erneut geladen (Schutz vor Schleifen). */
const RELOAD_LOCK_MS = 30_000;

export interface StaleChunkReloadOptions {
  target?: EventTarget;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  reload?: () => void;
  now?: () => number;
}

/**
 * Nach einem Deploy gibt es die gehashten Chunks der alten Version nicht mehr. Ein offener Tab lädt beim
 * Wechsel auf eine lazy Route dann einen fehlenden Chunk, Vite meldet `vite:preloadError`. Einmal neu
 * laden holt die aktuelle `index.html`. Fehlt der Chunk auch danach, bleibt der Fehler sichtbar.
 */
export function installStaleChunkReload(options: StaleChunkReloadOptions = {}): void {
  const {
    target = window,
    storage = window.sessionStorage,
    reload = () => window.location.reload(),
    now = Date.now,
  } = options;

  target.addEventListener('vite:preloadError', (event) => {
    try {
      const last = Number(storage.getItem(STALE_CHUNK_RELOAD_KEY));
      if (last && now() - last < RELOAD_LOCK_MS) return;
      storage.setItem(STALE_CHUNK_RELOAD_KEY, String(now()));
    } catch {
      // Ohne sessionStorage lässt sich eine Schleife nicht ausschließen: nicht neu laden.
      return;
    }
    event.preventDefault();
    reload();
  });
}
