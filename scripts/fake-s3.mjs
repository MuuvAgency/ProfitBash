// Minimaler S3- und Healthchecks-Ersatz für scripts/smoke-db-backup.sh (nur Tests, nie in Produktion).
//
//   FAKE_S3_PORT=18790 FAKE_S3_DIR=/tmp/x FAKE_S3_BUCKET=b FAKE_S3_ACCESS_KEY_ID=k node scripts/fake-s3.mjs
//
// PUT /<bucket>/<key>: prüft den SigV4-Kopf (Präfix, Zugangsschlüssel, Region `auto`, Dienst `s3`, signierter
// `x-amz-content-sha256`) und dass `x-amz-content-sha256` zum Body passt; speichert unter FAKE_S3_DIR/objects.
// Andere Buckets → 404. Jede Anfrage auf /hc/* wird als Ping in FAKE_S3_DIR/pings.log protokolliert.
// Die Signatur selbst rechnet curl; ob R2 sie annimmt, zeigt erst der erste echte Lauf.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, normalize } from 'node:path';

const port = Number(process.env.FAKE_S3_PORT);
const dir = process.env.FAKE_S3_DIR;
const bucket = process.env.FAKE_S3_BUCKET;
const accessKeyId = process.env.FAKE_S3_ACCESS_KEY_ID;
if (!port || !dir || !bucket || !accessKeyId) {
  console.error(
    'FAKE_S3_PORT, FAKE_S3_DIR, FAKE_S3_BUCKET und FAKE_S3_ACCESS_KEY_ID sind Pflicht.',
  );
  process.exit(2);
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(body);
}

function authorizationProblem(req, bodyHash) {
  const auth = req.headers.authorization ?? '';
  const scope = new RegExp(
    `^AWS4-HMAC-SHA256 Credential=${accessKeyId}/\\d{8}/auto/s3/aws4_request, SignedHeaders=([^,]+), Signature=[0-9a-f]{64}$`,
  );
  const match = scope.exec(auth);
  if (!match) return 'Authorization-Kopf passt nicht (SigV4, Schlüssel, Region auto, Dienst s3).';
  if (!match[1].split(';').includes('x-amz-content-sha256')) {
    return 'x-amz-content-sha256 ist nicht signiert.';
  }
  if (req.headers['x-amz-content-sha256'] !== bodyHash) {
    return 'x-amz-content-sha256 passt nicht zum Body.';
  }
  return null;
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

    if (path.startsWith('/hc/')) {
      appendFileSync(join(dir, 'pings.log'), `${req.method} ${path}\n`);
      return reply(res, 200, 'OK');
    }

    const [, reqBucket, ...keyParts] = path.split('/');
    const key = keyParts.join('/');
    if (req.method !== 'PUT' || !key) return reply(res, 405, 'Nur PUT /<bucket>/<key>.');
    if (reqBucket !== bucket) return reply(res, 404, 'NoSuchBucket');

    const problem = authorizationProblem(req, createHash('sha256').update(body).digest('hex'));
    if (problem) return reply(res, 403, problem);

    const target = normalize(join(dir, 'objects', reqBucket, key));
    if (!target.startsWith(join(dir, 'objects'))) return reply(res, 400, 'Ungültiger Schlüssel.');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    return reply(res, 200, '');
  });
});

server.listen(port, '127.0.0.1', () => console.log(`fake-s3 auf Port ${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
