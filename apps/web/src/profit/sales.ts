import type { AnalyticsQueryBody } from '../analytics/filters';
import type { SalesQueryInput } from '../api/client';

/** Auswahl der Filterleiste für `/api/profit/sales` (ohne Ad-Typen und Tags, die gelten nur für Werbung). */
export function salesQuery(q: AnalyticsQueryBody): SalesQueryInput {
  return {
    ...(q.clientIds && { clientIds: q.clientIds }),
    ...(q.withoutClient !== undefined && { withoutClient: q.withoutClient }),
    ...(q.profileIds && { profileIds: q.profileIds }),
    period: q.period,
    comparison: q.comparison,
    currency: q.currency,
    attribution: q.attribution,
  };
}
