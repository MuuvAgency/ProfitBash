import { describe, expect, it } from 'vitest';
import { createApp } from './app';

describe('API', () => {
  it('GET /api/health antwortet mit status ok', async () => {
    const res = await createApp().request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('unbekannte Routen liefern 404', async () => {
    const res = await createApp().request('/api/gibt-es-nicht');
    expect(res.status).toBe(404);
  });
});
