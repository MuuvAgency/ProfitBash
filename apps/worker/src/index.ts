import { loadWorkerEnv } from './env';

const env = loadWorkerEnv();
console.log(`Worker bereit (${env.NODE_ENV}). Jobs folgen in Aufgabe 0.7.`);

// Hält den Prozess am Leben, bis pg-boss in 0.7 diese Aufgabe übernimmt.
const keepAlive = setInterval(() => {}, 60_000);

function shutdown(signal: NodeJS.Signals) {
  console.log(`${signal} empfangen, Worker fährt herunter …`);
  clearInterval(keepAlive);
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
