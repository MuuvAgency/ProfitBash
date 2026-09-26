import { AMAZON_OAUTH_RESULTS } from '@profitbash/shared';
import { describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import { oauthNotice } from './oauth-notice';

describe('oauthNotice', () => {
  it('meldet ein erfolgreiches Verbinden als Erfolg', () => {
    expect(oauthNotice('connected')).toEqual({
      severity: 'success',
      messageKey: 'connections.oauth.connected',
    });
  });

  it('meldet einen nicht eingeplanten Sync als Warnung', () => {
    expect(oauthNotice('connected_sync_failed')?.severity).toBe('warn');
  });

  it('meldet Fehler als Fehler', () => {
    expect(oauthNotice('access_denied')?.severity).toBe('error');
    expect(oauthNotice('account_mismatch')?.severity).toBe('error');
  });

  it('ignoriert fehlende, mehrfache und unbekannte Werte', () => {
    expect(oauthNotice(undefined)).toBeNull();
    expect(oauthNotice(['connected', 'connected'])).toBeNull();
    expect(oauthNotice('<script>')).toBeNull();
  });

  it('hat für jedes Ergebnis des Callbacks einen Text', () => {
    const missing = AMAZON_OAUTH_RESULTS.filter(
      (result) => !i18n.global.te(oauthNotice(result)?.messageKey ?? ''),
    );
    expect(missing).toEqual([]);
  });
});
