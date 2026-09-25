/**
 * Fehlerarten des Amazon-Clients. Meldungen enthalten nie Tokens, Secrets oder ungeprüfte Rohdaten
 * aus Antworten (Details von Amazon werden gekürzt übernommen).
 */

export class AmazonAdsError extends Error {
  constructor(
    message: string,
    /** z. B. `profiles.list`, `lwa.refresh` */
    public readonly operation: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AmazonAdsError';
  }
}

/** Amazon hat mit einem Fehlerstatus geantwortet (nach allen Wiederholungen). */
export class AmazonAdsHttpError extends AmazonAdsError {
  constructor(
    message: string,
    operation: string,
    public readonly status: number,
    /** Fehlercode aus der Antwort (`code` der Ads-API bzw. `error` von LWA), falls vorhanden. */
    public readonly code: string | null,
    public readonly amazonRequestId: string | null,
    /** Von Amazon per `Retry-After` verlangte Wartezeit (bei 429/5xx), sonst `null`. */
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message, operation);
    this.name = 'AmazonAdsHttpError';
  }
}

/**
 * Der Refresh-Token ist ungültig (LWA `invalid_grant`): widerrufen, abgelaufen (365 Tage ab
 * Einwilligung für Tokens ab 30.07.2026) oder fremd. Die Connection braucht eine neue Einwilligung.
 */
export class AmazonAdsReauthRequiredError extends AmazonAdsHttpError {
  constructor(operation: string, status: number, amazonRequestId: string | null) {
    super(
      `${operation}: Amazon hat den Refresh-Token abgelehnt (invalid_grant). Die Connection muss neu verbunden werden.`,
      operation,
      status,
      'invalid_grant',
      amazonRequestId,
    );
    this.name = 'AmazonAdsReauthRequiredError';
  }
}

/** Netzwerkfehler oder Timeout (nach allen Wiederholungen). */
export class AmazonAdsNetworkError extends AmazonAdsError {
  constructor(
    operation: string,
    public readonly timedOut: boolean,
    options?: ErrorOptions,
  ) {
    super(
      timedOut
        ? `${operation}: Zeitüberschreitung bei der Anfrage an Amazon.`
        : `${operation}: Netzwerkfehler bei der Anfrage an Amazon.`,
      operation,
      options,
    );
    this.name = 'AmazonAdsNetworkError';
  }
}

/** Die Antwort war kein gültiges JSON oder passte nicht zum erwarteten Schema. */
export class AmazonAdsResponseError extends AmazonAdsError {
  constructor(message: string, operation: string) {
    super(message, operation);
    this.name = 'AmazonAdsResponseError';
  }
}
