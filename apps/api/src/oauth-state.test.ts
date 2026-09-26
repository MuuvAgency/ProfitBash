import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signOAuthState, verifyOAuthState, type OAuthStatePayload } from './oauth-state';

const secret = 's'.repeat(32);
const now = Date.UTC(2026, 8, 26, 10, 0, 0);

const payload: OAuthStatePayload = {
  organizationId: '0b6b1f0e-7a52-4f36-9a4d-5b1c2f1e8e01',
  userId: '5f1c6a2e-3d4b-4c8e-9f7a-2b1d0c9e8f11',
  connectionId: null,
  region: 'eu',
  nonce: 'bm9uY2Utbm9uY2Utbm9uY2Utbm9uY2U',
  expiresAt: now + 10 * 60_000,
};

function tamperPayload(state: string, change: Partial<OAuthStatePayload>): string {
  const [body, signature] = state.split('.');
  const decoded = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8')) as object;
  const forged = Buffer.from(JSON.stringify({ ...decoded, ...change })).toString('base64url');
  return `${forged}.${signature}`;
}

describe('OAuth-State', () => {
  it('liefert die signierten Daten unverändert zurück', () => {
    const state = signOAuthState(payload, secret);
    expect(verifyOAuthState(state, { secret, now })).toEqual({ ok: true, payload });

    const reconnect = { ...payload, connectionId: '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a' };
    expect(verifyOAuthState(signOAuthState(reconnect, secret), { secret, now })).toEqual({
      ok: true,
      payload: reconnect,
    });
  });

  it('ist URL-sicher', () => {
    expect(signOAuthState(payload, secret)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('lehnt veränderte Daten ab (z. B. fremde Organisation)', () => {
    const state = tamperPayload(signOAuthState(payload, secret), {
      organizationId: '11111111-1111-4111-8111-111111111111',
    });
    expect(verifyOAuthState(state, { secret, now })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('lehnt eine veränderte Signatur und ein anderes Secret ab', () => {
    const state = signOAuthState(payload, secret);
    const [body, signature = ''] = state.split('.');
    const flipped = `${body}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    expect(verifyOAuthState(flipped, { secret, now })).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyOAuthState(state, { secret: 'x'.repeat(32), now })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('lehnt einen abgelaufenen State ab', () => {
    const state = signOAuthState(payload, secret);
    expect(verifyOAuthState(state, { secret, now: payload.expiresAt })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('lehnt kaputte Formate ab, ohne zu werfen', () => {
    const valid = signOAuthState(payload, secret);
    for (const state of ['', 'ohne-punkt', '.', `${valid}.extra`, 'a'.repeat(5000), `ä.${valid}`]) {
      expect(verifyOAuthState(state, { secret, now })).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('lehnt korrekt signierte Daten mit falscher Form ab', () => {
    const body = Buffer.from(JSON.stringify({ hallo: 'welt' })).toString('base64url');
    const signature = createHmac('sha256', secret)
      .update(`amazon-ads-oauth-state.v1.${body}`)
      .digest('base64url');
    expect(verifyOAuthState(`${body}.${signature}`, { secret, now })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});
