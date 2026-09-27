import { z } from 'zod';
import type { ConnectionRef } from './access-token';
import type { AdsApiRequest, RequestOptions } from './client';
import { AmazonAdsResponseError } from './errors';
import type { Logger } from './logger';
import { amazonDecimalSchema, currencyCodeSchema } from './money';
import {
  compact,
  createUnknownValueReporter,
  KNOWN_ENTITY_STATES,
  parseAmazonTimestamp,
} from './normalize';
import { amazonIdSchema } from './profiles';

/**
 * Portfolios (v3, `POST /portfolios/list`). Geprüft am 2026-09-27 gegen die OpenAPI-Spec
 * (`Portfolios_prod_3p.json`): Content-Type und Accept `application/vnd.spPortfolio.v3+json`, Paginierung
 * über `nextToken` (bis 1000 je Seite), Betrag als `double` (daher `decimals: 'string'`). Ein Zustandsfilter
 * nimmt nur einen Wert; ohne Filter kommen alle Portfolios (v3 kennt nur `ENABLED`).
 */

export const PORTFOLIOS_CONTENT_TYPE = 'application/vnd.spPortfolio.v3+json';

/** Obergrenze gegen eine endlose Paginierung (1000 Portfolios je Seite). */
const MAX_PAGES = 100;

const portfolioSchema = z.object({
  portfolioId: amazonIdSchema,
  name: z.string(),
  state: z.string().min(1),
  inBudget: z.boolean().nullish(),
  budget: z
    .object({
      amount: amazonDecimalSchema.nullish(),
      currencyCode: currencyCodeSchema.nullish(),
      policy: z.string().nullish(),
      startDate: z.string().nullish(),
      endDate: z.string().nullish(),
    })
    .nullish(),
  budgetControls: z.record(z.string(), z.unknown()).nullish(),
  extendedData: z
    .object({
      servingStatus: z.string().nullish(),
      lastUpdateDateTime: z.string().nullish(),
      creationDateTime: z.string().nullish(),
    })
    .nullish(),
});

const listResponseSchema = z.object({
  portfolios: z.array(portfolioSchema).default([]),
  nextToken: z.string().nullish(),
});

/** Portfolio im eigenen Modell (Felder wie `PortfolioRecord` in `@profitbash/db`). */
export interface AmazonAdsPortfolio {
  amazonPortfolioId: string;
  name: string;
  state: string;
  /** Decimal-String in `budgetCurrencyCode`. */
  budgetAmount: string | null;
  budgetCurrencyCode: string | null;
  /** `DATE_RANGE` | `MONTHLY_RECURRING` | `NO_CAP` | … */
  budgetPolicy: string | null;
  budgetStartDate: string | null;
  budgetEndDate: string | null;
  inBudget: boolean | null;
  amazonUpdatedAt: Date | null;
  extra: Record<string, unknown>;
}

type RequestFn = <S extends z.ZodType>(
  connection: ConnectionRef,
  request: AdsApiRequest<S>,
) => Promise<z.output<S>>;

export async function listPortfolios(
  deps: { request: RequestFn; logger: Logger },
  connection: ConnectionRef,
  amazonProfileId: string,
  options: RequestOptions = {},
): Promise<AmazonAdsPortfolio[]> {
  const operation = 'portfolios.list';
  const unknown = createUnknownValueReporter(deps.logger, { operation, amazonProfileId });
  const portfolios: AmazonAdsPortfolio[] = [];
  const seenTokens = new Set<string>();
  let nextToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await deps.request(connection, {
      operation,
      method: 'POST',
      path: '/portfolios/list',
      amazonProfileId,
      headers: { 'Content-Type': PORTFOLIOS_CONTENT_TYPE, Accept: PORTFOLIOS_CONTENT_TYPE },
      body: JSON.stringify({ includeExtendedDataFields: true, ...(nextToken && { nextToken }) }),
      schema: listResponseSchema,
      decimals: 'string',
      // Nur lesend: 5xx dürfen wiederholt werden.
      retryServerErrors: true,
      ...(options.meter && { meter: options.meter }),
    });
    for (const raw of response.portfolios) {
      unknown.check('state', raw.state, KNOWN_ENTITY_STATES);
      unknown.checkCurrency('budget.currencyCode', raw.budget?.currencyCode);
      portfolios.push(normalizePortfolio(raw));
    }
    if (!response.nextToken) return portfolios;
    if (seenTokens.has(response.nextToken)) break;
    seenTokens.add(response.nextToken);
    nextToken = response.nextToken;
  }
  throw new AmazonAdsResponseError(
    `${operation}: Die Paginierung endet nicht (nextToken wiederholt sich oder zu viele Seiten).`,
    operation,
  );
}

function normalizePortfolio(raw: z.output<typeof portfolioSchema>): AmazonAdsPortfolio {
  return {
    amazonPortfolioId: raw.portfolioId,
    name: raw.name,
    state: raw.state,
    budgetAmount: raw.budget?.amount ?? null,
    budgetCurrencyCode: raw.budget?.currencyCode ?? null,
    budgetPolicy: raw.budget?.policy ?? null,
    budgetStartDate: raw.budget?.startDate ?? null,
    budgetEndDate: raw.budget?.endDate ?? null,
    inBudget: raw.inBudget ?? null,
    amazonUpdatedAt: parseAmazonTimestamp(raw.extendedData?.lastUpdateDateTime),
    extra: compact({
      servingStatus: raw.extendedData?.servingStatus,
      creationDateTime: raw.extendedData?.creationDateTime,
      budgetControls: raw.budgetControls,
    }),
  };
}
