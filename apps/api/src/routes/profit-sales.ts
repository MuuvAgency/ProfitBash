import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { listSelectableCurrencies, querySales, type SalesSums } from '@profitbash/db';
import { change, salesMetrics } from '@profitbash/engine';
import {
  DEFAULT_ATTRIBUTION_SETTING,
  errorResponseSchema,
  SALES_CHANGE_KEYS,
  salesQuerySchema,
  salesResponseSchema,
} from '@profitbash/shared';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { requireFeature, requireSession } from '../middleware';

/**
 * Verkaufsanalyse (`phase-7.md` 7.4): Umsatz netto und brutto, Stück, Bestellungen, TACoS und organischer Umsatz
 * der sichtbaren Seller-Konten (Access-Layer), dazu Tagesverlauf und Produkte. Feature `profit`, nur lesen.
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });

const salesRoute = createRoute({
  method: 'post',
  path: '/profit/sales',
  tags: ['Profit'],
  summary: 'Verkaufsanalyse: Umsatz, TACoS, organischer Umsatz, Tagesverlauf und Produkte',
  request: { body: { content: json(salesQuerySchema), required: true } },
  responses: {
    200: { description: 'Ergebnis.', content: json(salesResponseSchema) },
    400: { description: 'Ungültige Eingabe.', content: json(errorResponseSchema) },
    401: { description: 'Nicht angemeldet.', content: json(errorResponseSchema) },
    403: { description: 'Feature nicht gebucht.', content: json(errorResponseSchema) },
  },
});

export function registerProfitSalesRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  app.openapi(
    { ...salesRoute, middleware: [requireSession(deps), requireFeature(deps, 'profit', 'view')] },
    async (c) => {
      const auth = c.get('auth');
      const base = { userId: auth.user.id, orgId: auth.activeOrganization!.organizationId };
      const body = c.req.valid('json');
      const currency = body.currency ?? 'auto';
      if (currency !== 'auto') {
        const selectable = await listSelectableCurrencies(db, base);
        if (!selectable.includes(currency)) {
          throw new ApiError(
            400,
            'CURRENCY_NOT_SELECTABLE',
            `Währung ${currency} ist nicht wählbar (${selectable.join(', ')}).`,
          );
        }
      }
      const result = await querySales(db, {
        ...base,
        ...(body.clientIds && { clientIds: body.clientIds }),
        ...(body.withoutClient !== undefined && { withoutClient: body.withoutClient }),
        ...(body.profileIds && { profileIds: body.profileIds }),
        period: body.period,
        comparison: body.comparison ?? null,
        currency,
        attribution: body.attribution ?? DEFAULT_ATTRIBUTION_SETTING,
      });

      const period = (
        sums: SalesSums,
        ads: { cost: string | null; sales: string | null } | null,
      ) => {
        const adCost = ads?.cost ?? null;
        const adSales = ads?.sales ?? null;
        return {
          ...sums,
          adCost,
          adSales,
          ...salesMetrics({
            revenueNet: sums.revenueNet,
            revenueGross: sums.revenueGross,
            adCost,
            adSales,
          }),
        };
      };
      const current = period(result.totals.current, result.ads?.current ?? null);
      const comparison = result.totals.comparison
        ? period(result.totals.comparison, result.ads?.comparison ?? null)
        : null;
      const text = (value: string | number | null) => (value === null ? null : String(value));
      return c.json(
        {
          meta: {
            currency: result.currency,
            converted: result.converted,
            missingFxCurrencies: result.missingFxCurrencies,
            accounts: result.accounts,
            adProfiles: result.ads?.profiles ?? 0,
          },
          current,
          comparison,
          change: comparison
            ? (Object.fromEntries(
                SALES_CHANGE_KEYS.map((key) => [
                  key,
                  change(text(current[key]), text(comparison[key])),
                ]),
              ) as Record<(typeof SALES_CHANGE_KEYS)[number], ReturnType<typeof change>>)
            : null,
          days: result.days,
          comparisonDays: result.comparisonDays,
          products: result.products,
          truncated: result.truncated,
        },
        200,
      );
    },
  );
}
