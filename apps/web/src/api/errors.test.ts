import { describe, expect, it } from 'vitest';
import { ApiError, toApiError } from './errors';

describe('toApiError', () => {
  it('liest das Fehlerformat der eigenen API', () => {
    const error = toApiError(403, { error: { code: 'FORBIDDEN', message: 'Kein Zugriff.' } });
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'Kein Zugriff.' });
  });

  it('liest das Fehlerformat von better-auth', () => {
    const error = toApiError(401, {
      code: 'INVALID_EMAIL_OR_PASSWORD',
      message: 'Invalid email or password',
    });
    expect(error).toMatchObject({ status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' });
  });

  it('fällt bei unbekanntem Body auf einen Code aus dem Status zurück', () => {
    expect(toApiError(502, '<html>Bad Gateway</html>')).toMatchObject({
      status: 502,
      code: 'HTTP_502',
    });
    expect(toApiError(500, { error: 'kaputt' })).toMatchObject({ code: 'HTTP_500' });
    expect(toApiError(404, null)).toMatchObject({ code: 'HTTP_404' });
  });

  it('übernimmt keine Nicht-String-Werte als Code', () => {
    expect(toApiError(400, { code: 42, message: {} })).toMatchObject({ code: 'HTTP_400' });
  });
});

describe('ApiError.network', () => {
  it('kennzeichnet Verbindungsfehler mit Status 0', () => {
    expect(ApiError.network()).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });
});
