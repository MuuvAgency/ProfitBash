import { gzipSync } from 'node:zlib';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RefreshTokenStore } from './access-token';
import { createAmazonAdsClient } from './client';
import { decodeGzipJson, isAllowedDownloadUrl } from './download';
import { AmazonAdsHttpError, AmazonAdsNetworkError, AmazonAdsResponseError } from './errors';
import type { LogEntry } from './logger';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const REPORT_URL =
  'https://offline-report-storage-eu-west-1-prod.s3.eu-west-1.amazonaws.com/abc/report.json.gz?X-Amz-Signature=SECRET-SIG';
const EXPORT_URL =
  'https://snapshots-prod-eu-west-1.s3.eu-west-1.amazonaws.com/CAMPAIGN/export?X-Amz-Signature=SECRET-SIG';

const store: RefreshTokenStore = {
  async withRefreshToken() {
    throw new Error('Downloads brauchen kein Token.');
  },
};

function setup() {
  const logs: LogEntry[] = [];
  const client = createAmazonAdsClient({
    credentials: { clientId: 'c', clientSecret: 's', redirectUri: 'https://app.test/cb' },
    store,
    logger: (entry) => logs.push(entry),
    http: { sleep: async () => {} },
  });
  return { client, logs };
}

const gzip = (text: string) => new Uint8Array(gzipSync(Buffer.from(text, 'utf8')));

describe('isAllowedDownloadUrl', () => {
  it('erlaubt die S3-Hosts für Reports und Exports, nur per https', () => {
    expect(isAllowedDownloadUrl(REPORT_URL)).toBe(true);
    expect(isAllowedDownloadUrl(EXPORT_URL)).toBe(true);
    expect(
      isAllowedDownloadUrl(
        'https://offline-report-storage-us-east-1-prod.s3.amazonaws.com/x/report.json.gz',
      ),
    ).toBe(true);
    expect(isAllowedDownloadUrl(REPORT_URL.replace('https:', 'http:'))).toBe(false);
  });

  it('lehnt fremde Hosts ab, auch als Präfix oder Suffix', () => {
    for (const url of [
      'https://evil.example/report.json.gz',
      'https://advertising-api-eu.amazon.com/report',
      'https://my-bucket.s3.amazonaws.com/report',
      'https://offline-report-storage-eu.s3.amazonaws.com.evil.example/x',
      'https://evil.example/offline-report-storage-eu.s3.amazonaws.com/x',
      'https://user@evil.example/x',
      'kein-url',
    ]) {
      expect(isAllowedDownloadUrl(url), url).toBe(false);
    }
  });
});

describe('downloadFile', () => {
  it('lädt die Datei ohne Authorization- und Amazon-Header und liefert den rohen Body', async () => {
    const seen: Array<Record<string, string | null>> = [];
    server.use(
      http.get(REPORT_URL.split('?')[0]!, ({ request }) => {
        seen.push({
          authorization: request.headers.get('authorization'),
          clientId: request.headers.get('amazon-advertising-api-clientid'),
          scope: request.headers.get('amazon-advertising-api-scope'),
          signature: new URL(request.url).searchParams.get('X-Amz-Signature'),
        });
        return new HttpResponse(gzip('[{"cost":0.10}]'));
      }),
    );
    const { client } = setup();
    const result = await client.downloadFile(REPORT_URL);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    await expect(decodeGzipJson(result.body, { maxBytes: 1024 })).resolves.toEqual([
      { cost: '0.10' },
    ]);
    expect(seen).toEqual([
      { authorization: null, clientId: null, scope: null, signature: 'SECRET-SIG' },
    ]);
  });

  it('meldet 403 und 404 vom Download-Host als abgelaufen', async () => {
    const { client } = setup();
    for (const status of [403, 404]) {
      server.use(
        http.get(
          EXPORT_URL.split('?')[0]!,
          () => new HttpResponse('<Error>AccessDenied</Error>', { status }),
        ),
      );
      await expect(client.downloadFile(EXPORT_URL)).resolves.toEqual({ status: 'expired' });
    }
  });

  it('wirft bei anderen Fehlerstatus einen HTTP-Fehler ohne URL in der Meldung', async () => {
    server.use(http.get(REPORT_URL.split('?')[0]!, () => new HttpResponse('', { status: 500 })));
    const { client, logs } = setup();
    const error = await client.downloadFile(REPORT_URL).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmazonAdsHttpError);
    expect(error).toMatchObject({ status: 500 });
    expect((error as Error).message).not.toContain('SECRET');
    expect(JSON.stringify(logs)).not.toContain('SECRET');
  });

  it('wirft AmazonAdsNetworkError bei Netzwerkfehlern', async () => {
    server.use(http.get(REPORT_URL.split('?')[0]!, () => HttpResponse.error()));
    const { client } = setup();
    await expect(client.downloadFile(REPORT_URL)).rejects.toBeInstanceOf(AmazonAdsNetworkError);
  });

  it('ruft nicht erlaubte URLs gar nicht erst auf', async () => {
    const { client } = setup();
    const error = await client
      .downloadFile('https://evil.example/report.json.gz?sig=SECRET')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmazonAdsResponseError);
    expect((error as Error).message).toContain('evil.example');
    expect((error as Error).message).not.toContain('SECRET');
  });

  it('folgt keinen Weiterleitungen (sie könnten auf fremde Hosts führen)', async () => {
    server.use(
      http.get(
        REPORT_URL.split('?')[0]!,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: 'https://evil.example/x' },
          }),
      ),
    );
    const { client } = setup();
    await expect(client.downloadFile(REPORT_URL)).rejects.toBeInstanceOf(AmazonAdsNetworkError);
  });
});
