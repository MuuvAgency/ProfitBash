import { watch, type Ref } from 'vue';

/**
 * Live-Kanal der Benachrichtigungen (`phase-5.md` 5.2a/5.2b): eine `EventSource` je aktiver Organisation. Der Browser
 * verbindet selbst neu und schickt dabei `Last-Event-ID`; der Server holt Verpasstes nach. `onChange` lädt Zähler und
 * Liste neu: bei jeder neuen Nummer (Doppelte aus Live und Nachholen zählen einmal), bei `resync` und bei jeder
 * (Wieder-)Verbindung. Bleibt die Verbindung nach einem HTTP-Fehler zu, öffnet sie sich nach 5 bis 60 s selbst neu.
 * Ohne `EventSource` (alte Browser, Tests) übernimmt die Abfrage beim Fokus.
 */

export const NOTIFICATION_STREAM_URL = '/api/notifications/stream';
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

export function connectNotificationStream(options: {
  /** Aktive Organisation; `null` (abgemeldet, keine Organisation) schließt den Kanal. */
  orgId: Ref<string | null>;
  onChange: () => void;
  EventSourceImpl: typeof EventSource | undefined;
}): () => void {
  const { onChange } = options;
  const EventSourceImpl = options.EventSourceImpl;
  if (!EventSourceImpl) return () => {};
  const Impl: typeof EventSource = EventSourceImpl;
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = RETRY_MIN_MS;

  function open() {
    const seen = new Set<string>();
    const next = new Impl(NOTIFICATION_STREAM_URL, { withCredentials: true });
    // Jede (Wieder-)Verbindung: dazwischen kann etwas gekommen sein, das kein Nachholen liefert.
    next.addEventListener('ready', () => {
      retryDelay = RETRY_MIN_MS;
      onChange();
    });
    next.addEventListener('notification', (event) => {
      const id = (event as MessageEvent).lastEventId;
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      onChange();
    });
    next.addEventListener('resync', () => onChange());
    // Nach Netzwerkfehlern verbindet der Browser selbst neu; nach einer Antwort ohne 200 (Proxy beim Deploy, 503)
    // bleibt die Verbindung zu. Dann selbst neu öffnen, mit wachsender Pause.
    next.addEventListener('error', () => {
      if (next.readyState !== Impl.CLOSED || source !== next) return;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (source === next) source = open();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    });
    return next;
  }

  const stopWatch = watch(
    options.orgId,
    (orgId) => {
      clearTimeout(retryTimer);
      retryDelay = RETRY_MIN_MS;
      source?.close();
      source = orgId ? open() : null;
    },
    { immediate: true },
  );

  return () => {
    stopWatch();
    clearTimeout(retryTimer);
    source?.close();
    source = null;
  };
}
