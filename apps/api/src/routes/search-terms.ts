import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  deleteSearchTermPeriod,
  getSearchTermRules,
  listSearchTermPeriods,
  querySearchTermPeriod,
  saveSearchTermRules,
  type SearchTermRulesRecord,
} from '@profitbash/db';
import {
  buildNgrams,
  classifySearchTerm,
  classifySearchTermsAcrossTargets,
  comparableSearchTerm,
  createProtectedTermMatcher,
  deriveMetrics,
  sumDecimals,
  type SearchTermSums,
} from '@profitbash/engine';
import {
  errorResponseSchema,
  MAX_SEARCH_TERM_NGRAMS,
  MAX_SEARCH_TERM_ROWS,
  searchTermAnalysisRequestSchema,
  searchTermAnalysisResponseSchema,
  searchTermPeriodDeleteRequestSchema,
  searchTermPeriodDeleteResponseSchema,
  searchTermPeriodsRequestSchema,
  searchTermPeriodsResponseSchema,
  searchTermRulesResponseSchema,
  searchTermRulesSchema,
  type AdProduct,
} from '@profitbash/shared';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { orgAdminOnly, requireFeature, requireSession } from '../middleware';

/**
 * Suchbegriff-Analyse (`docs/tasks/phase-2b.md` 2b.2), Feature `sp-explorer`: Datei-Zeiträume je Profil, Analyse
 * **eines** Zeitraums (Zeilen mit Einstufung, N-Gramme, Summen) und die Regeln der Einstufung je Organisation.
 * Nur lesend bis auf die Regeln und das Löschen eines Datei-Zeitraums (2b.2d, nur Org-Admins); Aktionen auf Suchbegriffe kommen mit
 * dem Warenkorb (Phase 3). Gelesen wird über `@profitbash/db` (Access-Layer), gerechnet in `@profitbash/engine`.
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });

const errors = {
  400: { description: 'Ungültige Eingabe.', content: json(errorResponseSchema) },
  401: { description: 'Nicht angemeldet.', content: json(errorResponseSchema) },
  403: {
    description: 'Feature nicht gebucht oder kein Recht.',
    content: json(errorResponseSchema),
  },
};

const periodsRoute = createRoute({
  method: 'post',
  path: '/ads/search-terms/periods',
  tags: ['Suchbegriffe'],
  summary: 'Datei-Zeiträume mit Suchbegriffen je sichtbarem Profil',
  request: { body: { content: json(searchTermPeriodsRequestSchema), required: true } },
  responses: {
    200: { description: 'Ergebnis.', content: json(searchTermPeriodsResponseSchema) },
    ...errors,
  },
});

const deletePeriodRoute = createRoute({
  method: 'post',
  path: '/ads/search-terms/periods/delete',
  tags: ['Suchbegriffe'],
  summary:
    'Suchbegriffe eines Profils für genau einen Datei-Zeitraum löschen, über alle Ad-Typen (nur Org-Admins)',
  description:
    'Wie der Upload der Dateien nur für Org-Admins, dazu Recht „write“ im Feature „sp-explorer“: Der Server hebt ' +
    'keine Dateiinhalte auf, den Zeitraum stellt nur ein erneuter Upload wieder her.',
  request: { body: { content: json(searchTermPeriodDeleteRequestSchema), required: true } },
  responses: {
    200: { description: 'Gelöscht.', content: json(searchTermPeriodDeleteResponseSchema) },
    ...errors,
    404: {
      description: 'Profil nicht gefunden oder keine Suchbegriffe für diesen Zeitraum.',
      content: json(errorResponseSchema),
    },
  },
});

const analysisRoute = createRoute({
  method: 'post',
  path: '/ads/search-terms/analysis',
  tags: ['Suchbegriffe'],
  summary:
    'Suchbegriffe eines Profils für einen Datei-Zeitraum: Einstufung, N-Gramme, Summen (höchstens 10 000 Zeilen)',
  request: { body: { content: json(searchTermAnalysisRequestSchema), required: true } },
  responses: {
    200: { description: 'Ergebnis.', content: json(searchTermAnalysisResponseSchema) },
    ...errors,
    404: { description: 'Profil nicht gefunden.', content: json(errorResponseSchema) },
  },
});

const getRulesRoute = createRoute({
  method: 'get',
  path: '/ads/search-terms/rules',
  tags: ['Suchbegriffe'],
  summary: 'Regeln der Einstufung (Organisation) oder die Startwerte',
  responses: {
    200: { description: 'Regeln.', content: json(searchTermRulesResponseSchema) },
    401: errors[401],
    403: errors[403],
  },
});

const putRulesRoute = createRoute({
  method: 'put',
  path: '/ads/search-terms/rules',
  tags: ['Suchbegriffe'],
  summary: 'Regeln der Einstufung speichern (Recht „write“)',
  request: { body: { content: json(searchTermRulesSchema), required: true } },
  responses: {
    200: { description: 'Gespeicherte Regeln.', content: json(searchTermRulesResponseSchema) },
    ...errors,
  },
});

const SUM_KEYS = ['impressions', 'clicks', 'cost', 'sales', 'purchases', 'units'] as const;

function derived(sums: SearchTermSums) {
  const { ctr, cpc, cvr, acos, roas } = deriveMetrics({
    impressions: sums.impressions,
    clicks: sums.clicks,
    cost: sums.cost,
    sales: sums.sales,
    purchases: sums.purchases,
    viewableImpressions: null,
    viewableCost: null,
  });
  return { ctr, cpc, cvr, acos, roas };
}

function rulesResponse(record: SearchTermRulesRecord) {
  return {
    rules: record.rules,
    isDefault: record.isDefault,
    updatedAt: record.updatedAt?.toISOString() ?? null,
  };
}

export function registerSearchTermRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  const guard = (permission: 'view' | 'write') => [
    requireSession(deps),
    requireFeature(deps, 'sp-explorer', permission),
  ];
  /** Nutzer und aktive Organisation (die Guards garantieren beides). */
  const visibility = (c: { get(key: 'auth'): AppEnv['Variables']['auth'] }) => {
    const auth = c.get('auth');
    return { userId: auth.user.id, orgId: auth.activeOrganization!.organizationId };
  };
  const noMember = () => new ApiError(403, 'FEATURE_FORBIDDEN', 'Kein Mitglied der Organisation.');

  app.openapi({ ...periodsRoute, middleware: guard('view') }, async (c) => {
    const periods = await listSearchTermPeriods(db, visibility(c));
    return c.json(
      {
        periods: periods.map((period) => ({
          ...period,
          adProducts: period.adProducts as AdProduct[],
          importedAt: period.importedAt.toISOString(),
        })),
      },
      200,
    );
  });

  // Löschen darf nur, wer die Datei auch wieder hochladen kann (Upload: `orgAdminOnly`, `routes/file-imports.ts`).
  const deleteGuard = [...orgAdminOnly(deps), requireFeature(deps, 'sp-explorer', 'write')];
  app.openapi({ ...deletePeriodRoute, middleware: deleteGuard }, async (c) => {
    const body = c.req.valid('json');
    const deletedRows = await deleteSearchTermPeriod(db, {
      ...visibility(c),
      profileId: body.profileId,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
    });
    if (deletedRows === null)
      throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Profil nicht gefunden.');
    if (deletedRows === 0) {
      throw new ApiError(
        404,
        'SEARCH_TERM_PERIOD_NOT_FOUND',
        'Für diesen Zeitraum liegen keine Suchbegriffe vor.',
      );
    }
    return c.json({ deletedRows }, 200);
  });

  app.openapi({ ...analysisRoute, middleware: guard('view') }, async (c) => {
    const base = visibility(c);
    const body = c.req.valid('json');
    const [result, rulesRecord] = await Promise.all([
      querySearchTermPeriod(db, {
        ...base,
        profileId: body.profileId,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        ...(body.adProducts && { adProducts: body.adProducts }),
      }),
      getSearchTermRules(db, base),
    ]);
    if (!result) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Profil nicht gefunden.');
    if (!rulesRecord) throw noMember();
    const { rules } = rulesRecord;
    const { profile, protectedTerms } = result;

    // Einstufung, Zähler, Summe und N-Gramme über **alle** Zeilen; gekürzt wird erst die Antwort.
    const counts = { harvest: 0, negate: 0, watch: 0 };
    const isProtected = createProtectedTermMatcher(protectedTerms);
    const flaggedRows = result.rows.map((row) => ({
      ...row,
      protected: isProtected(row.searchTerm),
    }));
    // Zusätzlich je Suchbegriff über alle Targets (Käufe oder Klicks verteilen sich): dieselben Regeln auf die Summe.
    const terms = classifySearchTermsAcrossTargets(flaggedRows, rules);
    const termCounts = { harvest: 0, negate: 0, watch: 0 };
    const termCountsOnlyAcrossTargets = { harvest: 0, negate: 0 };
    for (const term of terms.values()) {
      termCounts[term.classification] += 1;
      if (term.onlyAcrossTargets && term.classification !== 'watch') {
        termCountsOnlyAcrossTargets[term.classification] += 1;
      }
    }
    const rows = flaggedRows.map((flagged) => {
      const classification = classifySearchTerm(flagged, rules);
      counts[classification.classification] += 1;
      const term = terms.get(comparableSearchTerm(flagged.searchTerm))!;
      return {
        ...flagged,
        adProduct: flagged.adProduct as AdProduct,
        ...derived(flagged),
        ...classification,
        termClassification: term.classification,
        termReason: term.reason,
        termTargets: term.targets,
        termOnlyAcrossTargets: term.onlyAcrossTargets,
      };
    });
    const totalSums = Object.fromEntries(
      SUM_KEYS.map((key) => [key, sumDecimals(result.rows.map((row) => row[key]))]),
    ) as unknown as SearchTermSums;
    const ngrams = buildNgrams(result.rows);

    return c.json(
      {
        meta: {
          profileId: profile.id,
          accountName: profile.accountName,
          countryCode: profile.countryCode,
          currency: profile.currencyCode,
          clientId: profile.clientId,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          importedAt: result.importedAt?.toISOString() ?? null,
          rules,
          rulesAreDefault: rulesRecord.isDefault,
          protectedTerms,
          totalRows: rows.length,
          truncated: rows.length > MAX_SEARCH_TERM_ROWS,
          maxRows: MAX_SEARCH_TERM_ROWS,
          totalNgrams: ngrams.length,
          ngramsTruncated: ngrams.length > MAX_SEARCH_TERM_NGRAMS,
          maxNgrams: MAX_SEARCH_TERM_NGRAMS,
        },
        total: { ...totalSums, ...derived(totalSums) },
        counts,
        termCounts,
        termCountsOnlyAcrossTargets,
        rows: rows.slice(0, MAX_SEARCH_TERM_ROWS),
        ngrams: ngrams
          .slice(0, MAX_SEARCH_TERM_NGRAMS)
          .map((ngram) => ({ ...ngram, ...derived(ngram) })),
      },
      200,
    );
  });

  app.openapi({ ...getRulesRoute, middleware: guard('view') }, async (c) => {
    const record = await getSearchTermRules(db, visibility(c));
    if (!record) throw noMember();
    return c.json(rulesResponse(record), 200);
  });

  app.openapi({ ...putRulesRoute, middleware: guard('write') }, async (c) => {
    const record = await saveSearchTermRules(db, {
      ...visibility(c),
      rules: c.req.valid('json'),
    });
    if (!record) throw noMember();
    return c.json(rulesResponse(record), 200);
  });
}
