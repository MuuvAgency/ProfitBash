import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * `state` des Amazon-OAuth-Flows: `<base64url(JSON)>.<base64url(HMAC-SHA256)>`, signiert mit
 * `OAUTH_STATE_SECRET`. Bindet den Rücksprung an Organisation, Nutzer und ggf. die neu zu verbindende
 * Connection. Die Nonce ist zusätzlich einmal verwendbar (siehe `routes/amazon-oauth.ts`).
 */

export interface OAuthStatePayload {
  organizationId: string;
  userId: string;
  /** Gesetzt bei „Neu verbinden“ einer bestehenden Connection. */
  connectionId: string | null;
  region: 'eu' | 'na' | 'fe';
  nonce: string;
  /** Ablauf in Millisekunden seit Epoch. */
  expiresAt: number;
}

export type OAuthStateResult =
  { ok: true; payload: OAuthStatePayload } | { ok: false; reason: 'invalid' | 'expired' };

/** Trennt diese Signatur von anderen HMACs mit demselben Secret. */
const SIGNATURE_CONTEXT = 'amazon-ads-oauth-state.v1.';
/** Obergrenze für `state`-Werte aus Query-Strings. */
export const MAX_OAUTH_STATE_LENGTH = 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const payloadSchema = z.strictObject({
  organizationId: z.uuid(),
  userId: z.uuid(),
  connectionId: z.uuid().nullable(),
  region: z.enum(['eu', 'na', 'fe']),
  nonce: z.string().regex(BASE64URL).min(16).max(128),
  expiresAt: z.number().int().positive(),
});

function sign(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(`${SIGNATURE_CONTEXT}${body}`).digest();
}

export function signOAuthState(payload: OAuthStatePayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payloadSchema.parse(payload))).toString('base64url');
  return `${body}.${sign(body, secret).toString('base64url')}`;
}

/** Prüft Signatur, Form und Ablauf. Wirft nie; kaputte Eingaben ergeben `invalid`. */
export function verifyOAuthState(
  state: string,
  options: { secret: string; now?: number },
): OAuthStateResult {
  const invalid = { ok: false, reason: 'invalid' } as const;
  if (state.length > MAX_OAUTH_STATE_LENGTH) return invalid;
  const parts = state.split('.');
  if (parts.length !== 2) return invalid;
  const [body = '', signature = ''] = parts;
  if (!BASE64URL.test(body) || !BASE64URL.test(signature)) return invalid;

  const expected = sign(body, options.secret);
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return invalid;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return invalid;
  }
  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success) return invalid;
  if ((options.now ?? Date.now()) >= parsed.data.expiresAt) return { ok: false, reason: 'expired' };
  return { ok: true, payload: parsed.data };
}
