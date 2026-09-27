import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeGzipJson } from './download';
import { AmazonAdsDownloadTooLargeError, AmazonAdsResponseError } from './errors';

/** Liefert die Bytes in kleinen Stücken, wie ein HTTP-Body. */
async function* chunked(bytes: Uint8Array, size = 7): AsyncIterable<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) {
    await Promise.resolve();
    yield bytes.subarray(i, i + size);
  }
}

const gzip = (text: string) => new Uint8Array(gzipSync(Buffer.from(text, 'utf8')));

describe('decodeGzipJson', () => {
  it('entpackt gestreamt und parst verlustfrei mit Dezimalzahlen als Quelltext', async () => {
    const text =
      '[{"campaignId":9007199254740993,"cost":0.10,"clicks":3,"sales7d":1234567.89},{"name":"Größe"}]';

    const result = await decodeGzipJson(chunked(gzip(text)), { maxBytes: 1024 });

    expect(result).toEqual([
      { campaignId: '9007199254740993', cost: '0.10', clicks: 3, sales7d: '1234567.89' },
      { name: 'Größe' },
    ]);
  });

  it('bricht ab, sobald der entpackte Inhalt den Deckel überschreitet', async () => {
    // 1 MB Nullen packen sich auf wenige KB: Der Deckel gilt für die entpackte Größe.
    const bomb = gzip(`[${'0,'.repeat(500_000)}0]`);
    expect(bomb.length).toBeLessThan(10_000);

    const error = await decodeGzipJson(chunked(bomb, 512), { maxBytes: 64 * 1024 }).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(AmazonAdsDownloadTooLargeError);
    expect((error as AmazonAdsDownloadTooLargeError).maxBytes).toBe(64 * 1024);
  });

  it('akzeptiert eine Datei genau auf dem Deckel', async () => {
    const text = '[1,2,3]';
    await expect(
      decodeGzipJson(chunked(gzip(text)), { maxBytes: Buffer.byteLength(text) }),
    ).resolves.toEqual([1, 2, 3]);
  });

  it('meldet kaputtes gzip als Antwortfehler', async () => {
    const error = await decodeGzipJson(chunked(new TextEncoder().encode('kein gzip')), {
      maxBytes: 1024,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AmazonAdsResponseError);
  });

  it('reicht Fehler des Bodys (z. B. Netzwerk) unverändert weiter', async () => {
    const broken = new Error('Verbindung abgebrochen');
    async function* body(): AsyncIterable<Uint8Array> {
      yield gzip('[1,2,3]').subarray(0, 5);
      throw broken;
    }

    await expect(decodeGzipJson(body(), { maxBytes: 1024 })).rejects.toBe(broken);
  });

  it('meldet ungültiges JSON als Antwortfehler, ohne den Inhalt zu zitieren', async () => {
    const error = await decodeGzipJson(chunked(gzip('[{"geheim": 1')), { maxBytes: 1024 }).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(AmazonAdsResponseError);
    expect((error as Error).message).not.toContain('geheim');
  });
});
