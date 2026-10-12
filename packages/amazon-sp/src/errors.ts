import { AmazonAdsHttpError } from '@profitbash/amazon-ads';

/**
 * Die SP-API verweigert den Zugriff (HTTP 403), obwohl das LwA-Token frisch ist: Der App fehlt die Rolle
 * für diese Operation (oder der Verkäufer hat sie der App nicht gewährt). Ein widerrufener Refresh-Token
 * scheitert schon vorher bei LwA (`AmazonAdsReauthRequiredError`). Erbt von `AmazonAdsHttpError`, damit
 * Jobs SP- und Ads-Fehler gleich behandeln.
 */
export class AmazonSpRoleMissingError extends AmazonAdsHttpError {
  constructor(operation: string, amazonRequestId: string | null, details: string | null) {
    super(
      `${operation}: Die SP-API verweigert den Zugriff. Der App fehlt vermutlich die Rolle für diese Operation.`,
      operation,
      403,
      'SP_ROLE_MISSING',
      amazonRequestId,
      null,
      details,
    );
    this.name = 'AmazonSpRoleMissingError';
  }
}
