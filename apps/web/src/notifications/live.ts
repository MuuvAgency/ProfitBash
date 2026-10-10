import { watch, type Ref } from 'vue';

/**
 * Live-Kanal der Benachrichtigungen (`phase-5.md` 5.2a/5.2b): eine `EventSource` je aktiver Organisation. Der Browser
 * verbindet selbst neu und schickt dabei `Last-Event-ID`; der Server holt Verpasstes nach. `onChange` lädt Zähler und
 * Liste neu: bei jeder neuen Nummer (Doppelte aus Live und Nachholen zählen einmal), bei `resync` und nach einer
 * Wiederverbindung. Ohne `EventSource` (alte Browser, Tests) übernimmt die Abfrage beim Fokus.
 */

export const NOTIFICATION_STREAM_URL = '/api/notifications/stream';

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

  function open() {
    const seen = new Set<string>();
    let connections = 0;
    const next = new Impl(NOTIFICATION_STREAM_URL, { withCredentials: true });
    next.addEventListener('ready', () => {
      connections += 1;
      if (connections > 1) onChange();
    });
    next.addEventListener('notification', (event) => {
      const id = (event as MessageEvent).lastEventId;
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      onChange();
    });
    next.addEventListener('resync', () => onChange());
    return next;
  }

  const stopWatch = watch(
    options.orgId,
    (orgId) => {
      source?.close();
      source = orgId ? open() : null;
    },
    { immediate: true },
  );

  return () => {
    stopWatch();
    source?.close();
    source = null;
  };
}
