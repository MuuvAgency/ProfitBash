import type { Logger } from '@profitbash/shared';

export type HealthcheckPing = 'start' | 'success' | 'fail';

const PING_TIMEOUT_MS = 10_000;

/**
 * Pingt Healthchecks.io (`<url>/start`, `<url>`, `<url>/fail`). `rid` verknüpft Start und Ende
 * eines Laufs, auch wenn mehrere Läufe gleichzeitig laufen. Fehler werden nur geloggt: Ein nicht
 * erreichbarer Healthcheck darf keinen Job scheitern lassen. Die URL wird nie geloggt (wer sie
 * kennt, kann pingen).
 */
export async function pingHealthcheck(options: {
  url: string;
  ping: HealthcheckPing;
  rid: string;
  logger: Logger;
  fetch?: typeof fetch;
}): Promise<void> {
  const { ping, logger } = options;
  const url = new URL(options.url);
  if (ping !== 'success') url.pathname = `${url.pathname.replace(/\/$/, '')}/${ping}`;
  url.searchParams.set('rid', options.rid);
  try {
    const response = await (options.fetch ?? fetch)(url, {
      method: 'POST',
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    await response.text();
    if (!response.ok) {
      logger({ level: 'warn', msg: 'healthcheck.ping_failed', ping, status: response.status });
    }
  } catch (error) {
    logger({
      level: 'warn',
      msg: 'healthcheck.ping_failed',
      ping,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}
