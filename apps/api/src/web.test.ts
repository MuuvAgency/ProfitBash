import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServerApp } from './web';

const INDEX_HTML = '<!doctype html><title>ProfitBash</title><div id="app"></div>';
const ASSET_JS = 'console.log("app");';

/** Steht für die API-App (basePath `/api`, JSON-404 für alles andere). */
function createStubApi() {
  const api = new Hono().basePath('/api');
  api.get('/health', (c) => c.json({ status: 'ok' }));
  api.post('/things', (c) => c.json({ created: true }, 201));
  api.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Nicht gefunden.' } }, 404));
  return api;
}

let webDistDir: string;

beforeAll(() => {
  webDistDir = mkdtempSync(join(tmpdir(), 'pb-web-dist-'));
  mkdirSync(join(webDistDir, 'assets'));
  writeFileSync(join(webDistDir, 'index.html'), INDEX_HTML);
  writeFileSync(join(webDistDir, 'assets', 'index-abc123.js'), ASSET_JS);
  writeFileSync(join(webDistDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});

afterAll(() => {
  rmSync(webDistDir, { recursive: true, force: true });
});

describe('createServerApp mit gebautem Web', () => {
  const app = () => createServerApp({ api: createStubApi(), webDistDir });

  it('leitet /api/* an die API weiter', async () => {
    const res = await app().request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });

    const post = await app().request('/api/things', { method: 'POST' });
    expect(post.status).toBe(201);
  });

  it('beantwortet unbekannte API-Pfade mit dem JSON-404 der API, nicht mit index.html', async () => {
    const res = await app().request('/api/gibt-es-nicht');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Nicht gefunden.' } });
  });

  it('liefert index.html für / ohne Cache', async () => {
    const res = await app().request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('liefert index.html für Client-Routen (SPA-Fallback)', async () => {
    const res = await app().request('/admin/connections?tab=profiles');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('liefert gehashte Assets mit langem Cache', async () => {
    const res = await app().request('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe(ASSET_JS);
  });

  it('liefert andere Dateien aus dist/ ohne langen Cache', async () => {
    const res = await app().request('/favicon.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^image\/svg\+xml/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('antwortet auf fehlende Dateien mit 404 statt mit index.html', async () => {
    for (const path of ['/assets/index-alt.js', '/robots.txt']) {
      const res = await app().request(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type'), path).toMatch(/^application\/json/);
    }
  });

  it('gibt keine Dateien außerhalb von dist/ heraus', async () => {
    const outside = join(webDistDir, '..', 'pb-geheim.txt');
    writeFileSync(outside, 'geheim');
    try {
      for (const path of [
        '/../pb-geheim.txt',
        '/%2e%2e/pb-geheim.txt',
        '/assets/..%2f..%2fpb-geheim.txt',
      ]) {
        const res = await app().request(path);
        expect(await res.text(), path).not.toContain('geheim');
      }
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('beantwortet andere Methoden außerhalb von /api mit dem JSON-404 der API', async () => {
    const res = await app().request('/admin/connections', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  });

  it('beantwortet HEAD wie GET, ohne Body', async () => {
    const res = await app().request('/admin/connections', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await res.text()).toBe('');
  });

  it('leitet /api ohne Schrägstrich an die API weiter', async () => {
    const res = await app().request('/api');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  });

  it('liefert für einen Ordner wie /assets index.html (SPA), nicht dessen Inhalt', async () => {
    const res = await app().request('/assets');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('bricht beim Start ab, wenn index.html fehlt', () => {
    const empty = mkdtempSync(join(tmpdir(), 'pb-web-empty-'));
    try {
      expect(() => createServerApp({ api: createStubApi(), webDistDir: empty })).toThrow(
        /index\.html.*pnpm build/,
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('Security-Header', () => {
  const app = () => createServerApp({ api: createStubApi(), webDistDir });

  it('setzt sie auf Seiten, Assets und API-Antworten', async () => {
    for (const path of ['/', '/admin/connections', '/assets/index-abc123.js', '/api/health']) {
      const res = await app().request(path);
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('strict-transport-security'), path).toMatch(/max-age=\d+/);
    }
  });

  it('behält den Origin-Header für Same-Origin-POSTs (kein no-referrer)', async () => {
    // Mit `no-referrer` senden Browser bei Same-Origin-POSTs `Origin: null`; dann schlagen die
    // CSRF-Prüfung der API und die Origin-Prüfung von better-auth fehl.
    const res = await app().request('/');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });
});

describe('createServerApp ohne gebautes Web (Entwicklung)', () => {
  it('leitet alles an die API weiter; Vite liefert das Web', async () => {
    const app = createServerApp({ api: createStubApi() });
    expect((await app.request('/api/health')).status).toBe(200);
    const res = await app.request('/');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  });
});
