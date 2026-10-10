import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { connectNotificationStream, NOTIFICATION_STREAM_URL } from './live';

/** Fake-EventSource: zeichnet auf und lässt Tests Ereignisse auslösen. */
class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  closed = false;
  onerror: (() => void) | null = null;
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data = '', lastEventId = '') {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data, lastEventId }));
    }
  }
}

const notification = (seq: number) =>
  JSON.stringify({ id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, seq });

function setup(initialOrg: string | null = 'org-a') {
  FakeEventSource.instances = [];
  const orgId = ref<string | null>(initialOrg);
  const onChange = vi.fn();
  const stop = connectNotificationStream({
    orgId,
    onChange,
    EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
  });
  return { orgId, onChange, stop, sources: FakeEventSource.instances };
}

describe('connectNotificationStream', () => {
  it('verbindet für die aktive Organisation mit Cookies', () => {
    const { sources } = setup();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.url).toBe(NOTIFICATION_STREAM_URL);
    expect(sources[0]!.init).toEqual({ withCredentials: true });
  });

  it('meldet neue Benachrichtigungen einmal je Nummer, dazu `resync`', () => {
    const { sources, onChange } = setup();
    const source = sources[0]!;
    source.emit('notification', notification(5), '5');
    source.emit('notification', notification(5), '5');
    source.emit('notification', notification(4), '4');
    expect(onChange).toHaveBeenCalledTimes(2);
    source.emit('resync');
    expect(onChange).toHaveBeenCalledTimes(3);
    source.emit('ping');
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('verbindet nach einem Wechsel der Organisation neu und schließt beim Abmelden', async () => {
    const { orgId, sources, onChange, stop } = setup();
    sources[0]!.emit('notification', notification(1), '1');
    orgId.value = 'org-b';
    await nextTick();
    expect(sources[0]!.closed).toBe(true);
    expect(sources).toHaveLength(2);
    // Neue Organisation, neue Nummern: dieselbe Nummer gilt dort wieder als neu.
    sources[1]!.emit('notification', notification(1), '1');
    expect(onChange).toHaveBeenCalledTimes(2);
    orgId.value = null;
    await nextTick();
    expect(sources[1]!.closed).toBe(true);
    expect(sources).toHaveLength(2);
    stop();
  });

  it('lädt bei jeder (Wieder-)Verbindung neu (dazwischen könnte etwas gekommen sein)', () => {
    const { sources, onChange } = setup();
    sources[0]!.emit('ready');
    expect(onChange).toHaveBeenCalledTimes(1);
    sources[0]!.emit('ready');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('öffnet nach einem endgültigen Abbruch (HTTP-Fehler) mit wachsender Pause neu', async () => {
    vi.useFakeTimers();
    try {
      const { sources, orgId } = setup();
      // Netzwerkfehler: der Browser verbindet selbst neu, nichts zu tun.
      sources[0]!.emit('error');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sources).toHaveLength(1);
      // Endgültig zu (z. B. 502 beim Deploy): nach 5 s neu, beim nächsten Mal nach 10 s.
      sources[0]!.readyState = 2;
      sources[0]!.emit('error');
      await vi.advanceTimersByTimeAsync(4_999);
      expect(sources).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sources).toHaveLength(2);
      sources[1]!.readyState = 2;
      sources[1]!.emit('error');
      await vi.advanceTimersByTimeAsync(9_999);
      expect(sources).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sources).toHaveLength(3);
      // Nach erfolgreicher Verbindung wieder kurz; abgemeldet: kein Neuversuch.
      sources[2]!.emit('ready');
      sources[2]!.readyState = 2;
      sources[2]!.emit('error');
      orgId.value = null;
      await nextTick();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sources).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tut ohne EventSource nichts (Abfrage beim Fokus übernimmt)', () => {
    const orgId = ref<string | null>('org-a');
    const stop = connectNotificationStream({
      orgId,
      onChange: vi.fn(),
      EventSourceImpl: undefined,
    });
    expect(() => stop()).not.toThrow();
  });

  it('schließt beim Beenden', () => {
    const { sources, stop } = setup();
    stop();
    expect(sources[0]!.closed).toBe(true);
  });
});
