import { describe, expect, it, vi } from 'vitest';
import { installStaleChunkReload, STALE_CHUNK_RELOAD_KEY } from './stale-chunks';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

function preloadError(target: EventTarget): Event {
  const event = new Event('vite:preloadError', { cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function setup(storage: Pick<Storage, 'getItem' | 'setItem'> = memoryStorage()) {
  const target = new EventTarget();
  const reload = vi.fn();
  let time = 1_000_000;
  installStaleChunkReload({ target, storage, reload, now: () => time });
  return {
    target,
    reload,
    storage,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('installStaleChunkReload', () => {
  it('lädt die Seite neu, wenn ein Chunk der alten Version fehlt', () => {
    const { target, reload, storage } = setup();
    const event = preloadError(target);
    expect(reload).toHaveBeenCalledTimes(1);
    // Vite wirft den Fehler dann nicht weiter.
    expect(event.defaultPrevented).toBe(true);
    expect(storage.getItem(STALE_CHUNK_RELOAD_KEY)).not.toBeNull();
  });

  it('lädt kurz nach einem Neuladen nicht erneut (keine Schleife), der Fehler bleibt sichtbar', () => {
    const storage = memoryStorage();
    preloadError(setup(storage).target); // alte Seite: lädt neu
    const reloaded = setup(storage); // neu geladene Seite, deren Chunk ebenfalls fehlt
    reloaded.advance(5_000);
    const event = preloadError(reloaded.target);
    expect(reloaded.reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('lädt nach Ablauf der Sperrzeit wieder neu (nächster Deploy)', () => {
    const { target, reload, advance } = setup();
    preloadError(target);
    advance(60_000);
    preloadError(target);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('lädt ohne nutzbaren sessionStorage nicht neu (sonst droht eine Schleife)', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    const { target, reload } = setup(broken);
    const event = preloadError(target);
    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
