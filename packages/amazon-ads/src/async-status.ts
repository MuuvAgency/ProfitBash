/**
 * Status eines asynchronen Amazon-Auftrags (Report oder Export), vereinheitlicht. Passt zu
 * `AmazonRequestState` der Zustandsmaschine im Worker (1.4), die ihn unverändert übernimmt.
 */
export type AmazonAdsAsyncStatus =
  | { status: 'PENDING' | 'PROCESSING' }
  | { status: 'COMPLETED'; url: string | null }
  | { status: 'FAILURE'; failureReason: string | null }
  /** Amazon kennt die ID nicht (mehr), HTTP 404. */
  | { status: 'NOT_FOUND' };
