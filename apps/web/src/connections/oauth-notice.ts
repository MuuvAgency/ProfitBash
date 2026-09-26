import { AMAZON_OAUTH_RESULTS, type AmazonOAuthResult } from '@profitbash/shared';

export interface OAuthNotice {
  severity: 'success' | 'warn' | 'error';
  messageKey: string;
}

function isResult(value: unknown): value is AmazonOAuthResult {
  return (AMAZON_OAUTH_RESULTS as readonly unknown[]).includes(value);
}

/** Hinweis zum Query-Parameter `?oauth=<Ergebnis>`, den der OAuth-Callback setzt. */
export function oauthNotice(value: unknown): OAuthNotice | null {
  if (!isResult(value)) return null;
  const severity =
    value === 'connected' ? 'success' : value === 'connected_sync_failed' ? 'warn' : 'error';
  return { severity, messageKey: `connections.oauth.${value}` };
}
