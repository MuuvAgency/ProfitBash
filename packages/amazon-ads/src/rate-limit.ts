/**
 * Anfrage-Budget je Amazon-Profil im Prozess (Phase 1, 1.3). Amazon veröffentlicht keine festen
 * Rate-Limits (dynamisch je Client, Region und Last); das Budget verteilt Anfragen deshalb gleichmäßig
 * und passt die Rate an die Antworten an (AIMD):
 * - ein 429 halbiert die Rate des Profils bis zur Untergrenze
 * - jede erfolgreiche Anfrage erhöht sie additiv, höchstens bis zum Standard
 * - `Retry-After` sperrt das Profil bis zum Ende der verlangten Pause
 *
 * Token-Bucket mit Kapazität 1 (kein Burst): Jede Anfrage bekommt einen eigenen Zeitschlitz im
 * Abstand `1 / Rate`, auch bei gleichzeitigen Aufrufen. Kein verteiltes Budget: Die Datenjobs laufen in
 * genau einem Prozess. Je Profil ein kleiner Eintrag, solange der Prozess läuft (Anzahl Profile).
 */

export interface ProfileRateLimiterOptions {
  /** Standard- und Höchstrate je Profil. Standard 2 Anfragen/s. */
  requestsPerSecond?: number;
  /** Untergrenze nach wiederholten 429. Standard 0,2 Anfragen/s. */
  minRequestsPerSecond?: number;
  /** Anstieg der Rate je erfolgreicher Anfrage. Standard 0,05 Anfragen/s. */
  increasePerSuccess?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ProfileRateLimiter {
  /** Wartet auf den nächsten freien Zeitschlitz des Profils. */
  acquire(key: string): Promise<void>;
  /** Amazon hat gedrosselt (429); `retryAfterMs` aus dem Header, falls geliefert. */
  onThrottled(key: string, retryAfterMs: number | null): void;
  onSuccess(key: string): void;
  /** Aktuelle Rate des Profils (Anfragen/s). */
  rate(key: string): number;
}

export const DEFAULT_REQUESTS_PER_SECOND = 2;
export const DEFAULT_MIN_REQUESTS_PER_SECOND = 0.2;
export const DEFAULT_INCREASE_PER_SUCCESS = 0.05;

interface ProfileBudget {
  rate: number;
  /** Frühester Zeitpunkt (ms) der nächsten Anfrage. */
  nextAt: number;
}

export function createProfileRateLimiter(
  options: ProfileRateLimiterOptions = {},
): ProfileRateLimiter {
  const maxRate = options.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
  const minRate = options.minRequestsPerSecond ?? DEFAULT_MIN_REQUESTS_PER_SECOND;
  const increase = options.increasePerSuccess ?? DEFAULT_INCREASE_PER_SUCCESS;
  if (!(maxRate > 0) || !Number.isFinite(maxRate)) {
    throw new RangeError('requestsPerSecond muss eine positive Zahl sein.');
  }
  if (!(minRate > 0) || minRate > maxRate) {
    throw new RangeError('minRequestsPerSecond muss positiv und höchstens requestsPerSecond sein.');
  }
  if (!(increase >= 0) || !Number.isFinite(increase)) {
    throw new RangeError('increasePerSuccess darf nicht negativ sein.');
  }
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const budgets = new Map<string, ProfileBudget>();

  function budget(key: string): ProfileBudget {
    let entry = budgets.get(key);
    if (!entry) {
      entry = { rate: maxRate, nextAt: 0 };
      budgets.set(key, entry);
    }
    return entry;
  }

  const interval = (rate: number) => 1000 / rate;

  return {
    async acquire(key) {
      const entry = budget(key);
      const t = now();
      // Den Schlitz synchron reservieren, damit gleichzeitige Aufrufe nicht denselben bekommen.
      const slot = Math.max(entry.nextAt, t);
      entry.nextAt = slot + interval(entry.rate);
      if (slot > t) await sleep(slot - t);
    },
    onThrottled(key, retryAfterMs) {
      const entry = budget(key);
      entry.rate = Math.max(minRate, entry.rate / 2);
      const t = now();
      entry.nextAt = Math.max(entry.nextAt, t + interval(entry.rate), t + (retryAfterMs ?? 0));
    },
    onSuccess(key) {
      const entry = budget(key);
      entry.rate = Math.min(maxRate, entry.rate + increase);
    },
    rate: (key) => budgets.get(key)?.rate ?? maxRate,
  };
}
