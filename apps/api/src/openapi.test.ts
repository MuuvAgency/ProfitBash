import { readFile } from 'node:fs/promises';
import { FEATURE_KEYS } from '@profitbash/shared';
import { describe, expect, it } from 'vitest';
import { OPENAPI_FILE, renderOpenApiDocument } from './openapi';

describe('openapi.json', () => {
  it('entspricht der aktuellen API (sonst `pnpm api:generate` ausführen)', async () => {
    expect(await readFile(OPENAPI_FILE, 'utf8')).toBe(await renderOpenApiDocument());
  });

  it('enthält die Pfade der eigenen API mit /api-Präfix', async () => {
    const doc = JSON.parse(await renderOpenApiDocument()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/api/me', '/api/settings', '/api/health']),
    );
  });

  it('führt alle Feature-Keys in /api/me als Pflichtfelder (der Client verlässt sich darauf)', async () => {
    const doc = JSON.parse(await renderOpenApiDocument()) as {
      components: { schemas: { Me: { properties: { features: { required?: string[] } } } } };
    };
    expect(doc.components.schemas.Me.properties.features.required).toEqual([...FEATURE_KEYS]);
  });
});
