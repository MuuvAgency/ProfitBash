import { describe, expect, it } from 'vitest';
import { createProfileRateLimiter, type ProfileRateLimiterOptions } from './rate-limit';

/** Uhr, die nur beim Warten weiterläuft: Jede Wartezeit ist sichtbar und deterministisch. */
function setup(options: Partial<ProfileRateLimiterOptions> = {}) {
  let clock = 0;
  const sleeps: number[] = [];
  const limiter = createProfileRateLimiter({
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...options,
  });
  return {
    limiter,
    sleeps,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe('createProfileRateLimiter', () => {
  it('lässt standardmäßig 2 Anfragen je Sekunde und Profil zu, gleichmäßig verteilt', async () => {
    const { limiter, sleeps } = setup();
    await limiter.acquire('eu:1');
    await limiter.acquire('eu:1');
    await limiter.acquire('eu:1');
    expect(sleeps).toEqual([500, 500]);
  });

  it('wartet nicht, wenn seit der letzten Anfrage genug Zeit vergangen ist', async () => {
    const { limiter, sleeps, advance } = setup();
    await limiter.acquire('eu:1');
    advance(2_000);
    await limiter.acquire('eu:1');
    expect(sleeps).toEqual([]);
  });

  it('vergibt gleichzeitigen Anfragen je einen eigenen Zeitschlitz', async () => {
    // Die Uhr steht: Alle drei Aufrufe kommen im selben Moment an.
    const sleeps: number[] = [];
    const limiter = createProfileRateLimiter({
      requestsPerSecond: 4,
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await Promise.all([limiter.acquire('eu:1'), limiter.acquire('eu:1'), limiter.acquire('eu:1')]);
    expect(sleeps).toEqual([250, 500]);
  });

  it('führt das Budget je Profil getrennt', async () => {
    const { limiter, sleeps } = setup();
    await limiter.acquire('eu:1');
    await limiter.acquire('eu:2');
    await limiter.acquire('na:1');
    expect(sleeps).toEqual([]);
  });

  it('halbiert die Rate nach einem 429 bis zur Untergrenze (AIMD)', () => {
    const { limiter } = setup({ requestsPerSecond: 2, minRequestsPerSecond: 0.2 });
    limiter.onThrottled('eu:1', null);
    expect(limiter.rate('eu:1')).toBe(1);
    for (let i = 0; i < 10; i += 1) limiter.onThrottled('eu:1', null);
    expect(limiter.rate('eu:1')).toBe(0.2);
    expect(limiter.rate('eu:2')).toBe(2);
  });

  it('erhöht die Rate je erfolgreicher Anfrage additiv, höchstens bis zum Standard', () => {
    const { limiter } = setup({ requestsPerSecond: 2, increasePerSuccess: 0.25 });
    limiter.onThrottled('eu:1', null);
    limiter.onSuccess('eu:1');
    expect(limiter.rate('eu:1')).toBe(1.25);
    for (let i = 0; i < 10; i += 1) limiter.onSuccess('eu:1');
    expect(limiter.rate('eu:1')).toBe(2);
  });

  it('wartet nach einem 429 mindestens einen Abstand der halbierten Rate', async () => {
    const { limiter, sleeps } = setup({ requestsPerSecond: 2 });
    await limiter.acquire('eu:1');
    limiter.onThrottled('eu:1', null);
    await limiter.acquire('eu:1');
    expect(sleeps).toEqual([1_000]);
  });

  it('sperrt das Profil bis zum Ende von Retry-After, auch für andere Anfragen', async () => {
    const { limiter, sleeps, now } = setup({ requestsPerSecond: 2 });
    await limiter.acquire('eu:1');
    limiter.onThrottled('eu:1', 7_000);
    await limiter.acquire('eu:1');
    expect(sleeps).toEqual([7_000]);
    expect(now()).toBe(7_000);
  });

  it('lehnt unsinnige Raten ab', () => {
    expect(() => createProfileRateLimiter({ requestsPerSecond: 0 })).toThrow(RangeError);
    expect(() =>
      createProfileRateLimiter({ requestsPerSecond: 1, minRequestsPerSecond: 2 }),
    ).toThrow(RangeError);
    expect(() => createProfileRateLimiter({ increasePerSuccess: -1 })).toThrow(RangeError);
  });
});
