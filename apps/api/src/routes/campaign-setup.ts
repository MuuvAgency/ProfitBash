import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { amazonAdsValueLimit } from '@profitbash/amazon-ads';
import {
  assertCampaignSetupProfile,
  CampaignSetupError,
  discardCampaignSetupDraft,
  fxRatesOnOrBefore,
  getCampaignSetupDraft,
  HARVEST_MARK_LIST_LIMIT,
  listCampaignSetupDrafts,
  listHarvestMarks,
  listSubmissionConnections,
  loadHarvestMarkSources,
  loadCampaignSetupPlanSource,
  loadProfileBidSuggestions,
  saveCampaignSetupDraft,
  submitCampaignSetupDraft,
  type CampaignSetupDraftRecord,
  type DbOrTx,
} from '@profitbash/db';
import type { AdChangeLimitLookup } from '@profitbash/engine';
import {
  buildCampaignPlan,
  harvestCpc,
  harvestInputs,
  planSourceNegatives,
} from '@profitbash/engine/plan';
import {
  campaignSetupDraftListResponseSchema,
  campaignSetupDraftSchema,
  discardCampaignSetupDraftRequestSchema,
  errorResponseSchema,
  planCampaignSetupRequestSchema,
  planCampaignSetupResponseSchema,
  saveCampaignSetupDraftSchema,
  setupHarvestListResponseSchema,
  submitCampaignSetupDraftRequestSchema,
  submitCampaignSetupResponseSchema,
  todayInTimezone,
  updateCampaignSetupDraftRequestSchema,
  type CampaignSetupDraft,
} from '@profitbash/shared';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { requireFeature, requireSession } from '../middleware';
import { toIso } from './serialize';

/**
 * Kampagnen-Setup (`docs/tasks/phase-4.md` 4.5, F5, F13), Feature `tools`: aus Produktgruppe, Preset und Eingaben
 * planen (Plan-Engine auf dem Server, mit Kurs, Grenzen und Geboten aus dem Profil), Entwürfe speichern, ändern,
 * verwerfen und übermitteln. Lesen und Planen mit `view`, alles andere mit `write`. Die Übermittlung erscheint auf
 * der Seite „Änderungen“ (Art `setup`).
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });
const errors = {
  400: { description: 'Ungültige Eingabe.', content: json(errorResponseSchema) },
  401: { description: 'Nicht angemeldet.', content: json(errorResponseSchema) },
  403: {
    description: 'Feature nicht gebucht oder kein Recht.',
    content: json(errorResponseSchema),
  },
  404: {
    description: 'Entwurf, Profil oder Produktgruppe nicht gefunden.',
    content: json(errorResponseSchema),
  },
};
const conflict = {
  description: 'Entwurf inzwischen geändert, schon übermittelt bzw. kein Kurs vorhanden.',
  content: json(errorResponseSchema),
};
const idParam = z.object({ id: z.uuid() });
const TAGS = ['Tools'];

const planRoute = createRoute({
  method: 'post',
  path: '/ads/tools/setup/plan',
  tags: TAGS,
  summary: 'Setup planen: Kampagnen mit Namen, Geboten, Budgets und Hinweisen (ohne zu speichern)',
  request: { body: { content: json(planCampaignSetupRequestSchema), required: true } },
  responses: {
    200: { description: 'Plan.', content: json(planCampaignSetupResponseSchema) },
    ...errors,
    409: conflict,
  },
});

const harvestRoute = createRoute({
  method: 'get',
  path: '/ads/tools/setup/harvest',
  tags: TAGS,
  summary:
    'Harvest-Merkliste eines Profils als Eingang des Setups (4.6), mit CPC als Gebotsvorschlag',
  request: { query: z.object({ profileId: z.uuid() }) },
  responses: {
    200: { description: 'Merkliste.', content: json(setupHarvestListResponseSchema) },
    ...errors,
  },
});

const listRoute = createRoute({
  method: 'get',
  path: '/ads/tools/setup/drafts',
  tags: TAGS,
  summary: 'Offene und übermittelte Entwürfe der sichtbaren Profile, zuletzt geänderte zuerst',
  request: { query: z.object({ profileId: z.uuid().optional() }) },
  responses: {
    200: { description: 'Entwürfe.', content: json(campaignSetupDraftListResponseSchema) },
    ...errors,
  },
});

const createDraftRoute = createRoute({
  method: 'post',
  path: '/ads/tools/setup/drafts',
  tags: TAGS,
  summary: 'Entwurf anlegen (Recht „write“)',
  request: { body: { content: json(saveCampaignSetupDraftSchema), required: true } },
  responses: {
    201: { description: 'Angelegt.', content: json(campaignSetupDraftSchema) },
    ...errors,
  },
});

const getDraftRoute = createRoute({
  method: 'get',
  path: '/ads/tools/setup/drafts/{id}',
  tags: TAGS,
  summary: 'Ein Entwurf mit Plan und Eingaben',
  request: { params: idParam },
  responses: {
    200: { description: 'Entwurf.', content: json(campaignSetupDraftSchema) },
    ...errors,
  },
});

const updateDraftRoute = createRoute({
  method: 'put',
  path: '/ads/tools/setup/drafts/{id}',
  tags: TAGS,
  summary: 'Entwurf ändern, mit der Version, auf der die Änderung beruht (Recht „write“)',
  request: {
    params: idParam,
    body: { content: json(updateCampaignSetupDraftRequestSchema), required: true },
  },
  responses: {
    200: { description: 'Geändert.', content: json(campaignSetupDraftSchema) },
    ...errors,
    409: conflict,
  },
});

const discardRoute = createRoute({
  method: 'post',
  path: '/ads/tools/setup/drafts/{id}/discard',
  tags: TAGS,
  summary: 'Entwurf verwerfen (Recht „write“)',
  request: {
    params: idParam,
    body: { content: json(discardCampaignSetupDraftRequestSchema), required: true },
  },
  responses: {
    200: { description: 'Verworfen.', content: json(campaignSetupDraftSchema) },
    ...errors,
    409: conflict,
  },
});

const submitRoute = createRoute({
  method: 'post',
  path: '/ads/tools/setup/drafts/{id}/submit',
  tags: TAGS,
  summary: 'Entwurf übermitteln (Bulk-Datei oder API; Recht „write“)',
  description:
    'Prüft den gespeicherten Plan gegen den aktuellen Stand des Profils (Namen, Grenzen von Amazon). Bei Fehlern ' +
    'antwortet der Endpunkt mit `status: rejected` und übermittelt nichts.',
  request: {
    params: idParam,
    body: { content: json(submitCampaignSetupDraftRequestSchema), required: true },
  },
  responses: {
    200: {
      description: 'Übermittelt bzw. abgelehnt.',
      content: json(submitCampaignSetupResponseSchema),
    },
    ...errors,
    409: conflict,
  },
});

const STATUS_BY_CODE = {
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  NOT_DRAFT: 409,
  PROFILE_CHANGED: 400,
  PRODUCT_GROUP_MISMATCH: 400,
  UNKNOWN_PRESET: 400,
  PROFILE_HAS_NO_CONNECTION: 409,
} as const;

function toApiError(error: unknown): unknown {
  if (!(error instanceof CampaignSetupError)) return error;
  return new ApiError(STATUS_BY_CODE[error.code], `CAMPAIGN_SETUP_${error.code}`, error.message);
}

/** Grenzen von Amazon je Ad-Typ, Land und Feld (`limits.ts`); ohne bekannte Grenze entscheidet Amazon. */
const limitFor: AdChangeLimitLookup = (input) => amazonAdsValueLimit(input) ?? null;

function serialize(draft: CampaignSetupDraftRecord): CampaignSetupDraft {
  return {
    ...draft,
    submittedAt: toIso(draft.submittedAt),
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

export function registerCampaignSetupRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  const guard = (permission: 'view' | 'write') => [
    requireSession(deps),
    requireFeature(deps, 'tools', permission),
  ];
  const actor = (c: { get(key: 'auth'): AppEnv['Variables']['auth'] }) => {
    const auth = c.get('auth');
    return { userId: auth.user.id, orgId: auth.activeOrganization!.organizationId };
  };
  const noMember = () => new ApiError(403, 'FEATURE_FORBIDDEN', 'Kein Mitglied der Organisation.');
  async function run<T>(action: () => Promise<T | null>): Promise<T> {
    let result: T | null;
    try {
      result = await action();
    } catch (error) {
      throw toApiError(error);
    }
    if (result === null) throw noMember();
    return result;
  }

  app.openapi({ ...planRoute, middleware: guard('view') }, async (c) => {
    const body = c.req.valid('json');
    const source = await run(() =>
      loadCampaignSetupPlanSource(db, {
        ...actor(c),
        profileId: body.profileId,
        productGroupId: body.productGroupId,
      }),
    );
    const preset = source.catalog.presets.find((entry) => entry.key === body.presetKey);
    if (!preset) {
      throw new ApiError(
        400,
        'CAMPAIGN_SETUP_UNKNOWN_PRESET',
        'Dieses Preset gibt es im Katalog nicht.',
      );
    }
    const today = todayInTimezone(source.profile.timezone, new Date());
    const currency = source.profile.currencyCode;
    const rate = (await fxRatesOnOrBefore(db, today, [currency])).get(currency);
    if (!rate) {
      throw new ApiError(
        409,
        'CAMPAIGN_SETUP_FX_RATE_MISSING',
        `Für ${currency} gibt es noch keinen Tageskurs; die Werte des Katalogs (EUR) lassen sich nicht umrechnen.`,
      );
    }
    const profileBids = body.useProfileBids
      ? await loadProfileBidSuggestions(db, { profileId: body.profileId, today })
      : {};
    const { inputs } = body;
    // Harvest von der Merkliste (4.6): Begriffe mit CPC als Gebot (F8), Negativ in der Quelle (F7).
    const marks = await loadHarvestMarkSources(db, {
      profileId: body.profileId,
      markIds: inputs.harvest.map((entry) => entry.markId),
    });
    const harvest = harvestInputs({ marks, selections: inputs.harvest, currencyCode: currency });
    const result = buildCampaignPlan({
      catalog: source.catalog,
      preset,
      productGroup: source.productGroup,
      profile: source.profile,
      eurRate: rate.rate,
      keywords: [...harvest.keywords, ...inputs.keywords],
      brandTerms: inputs.brandTerms,
      productTargets: [...harvest.productTargets, ...inputs.productTargets],
      categories: inputs.categories,
      // Die Wettbewerber-Liste je Client (F-S9) gibt es noch nicht: Conquesting fällt mit Hinweis weg.
      conquestAsins: [],
      existing: source.existing,
      limitFor,
      unlocks: inputs.unlocks,
      profileBids,
    });
    const sources = planSourceNegatives({
      marks,
      campaigns: result.campaigns,
      protectedTerms: source.protectedTerms,
      deselected: body.deselectedSources,
    });
    return c.json(
      {
        campaigns: result.campaigns,
        sourceNegatives: sources.sourceNegatives,
        hints: [...harvest.hints, ...result.hints, ...sources.hints],
        eurRate: { rate: rate.rate, date: rate.date },
        profileBids,
      },
      200,
    );
  });

  app.openapi({ ...harvestRoute, middleware: guard('view') }, async (c) => {
    const { profileId } = c.req.valid('query');
    await run(() => assertCampaignSetupProfile(db, { ...actor(c), profileId }));
    const marks = await run(() => listHarvestMarks(db, { ...actor(c), profileId }));
    return c.json(
      {
        marks: marks.map((mark) => {
          const clicks = Number(mark.clicks);
          return {
            id: mark.id,
            searchTerm: mark.searchTerm,
            adProduct: mark.adProduct,
            campaignName: mark.campaignName,
            adGroupName: mark.adGroupName,
            periodStart: mark.periodStart,
            periodEnd: mark.periodEnd,
            clicks,
            cost: mark.cost,
            sales: mark.sales,
            purchases: Number(mark.purchases),
            currencyCode: mark.currencyCode,
            cpc: harvestCpc(clicks, mark.cost),
            createdAt: mark.createdAt.toISOString(),
          };
        }),
        truncated: marks.length >= HARVEST_MARK_LIST_LIMIT,
      },
      200,
    );
  });

  app.openapi({ ...listRoute, middleware: guard('view') }, async (c) => {
    const { profileId } = c.req.valid('query');
    const drafts = await run(() =>
      listCampaignSetupDrafts(db, { ...actor(c), ...(profileId && { profileId }) }),
    );
    return c.json(
      {
        drafts: drafts.map((draft) => ({
          ...draft,
          submittedAt: toIso(draft.submittedAt),
          createdAt: draft.createdAt.toISOString(),
          updatedAt: draft.updatedAt.toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi({ ...createDraftRoute, middleware: guard('write') }, async (c) => {
    const draft = await run(() =>
      saveCampaignSetupDraft(db, { ...actor(c), draft: c.req.valid('json') }),
    );
    return c.json(serialize(draft), 201);
  });

  app.openapi({ ...getDraftRoute, middleware: guard('view') }, async (c) => {
    const draft = await run(() =>
      getCampaignSetupDraft(db, { ...actor(c), draftId: c.req.valid('param').id }),
    );
    return c.json(serialize(draft), 200);
  });

  app.openapi({ ...updateDraftRoute, middleware: guard('write') }, async (c) => {
    const { version, draft } = c.req.valid('json');
    const saved = await run(() =>
      saveCampaignSetupDraft(db, {
        ...actor(c),
        draftId: c.req.valid('param').id,
        version,
        draft,
      }),
    );
    return c.json(serialize(saved), 200);
  });

  app.openapi({ ...discardRoute, middleware: guard('write') }, async (c) => {
    const draft = await run(() =>
      discardCampaignSetupDraft(db, {
        ...actor(c),
        draftId: c.req.valid('param').id,
        version: c.req.valid('json').version,
      }),
    );
    return c.json(serialize(draft), 200);
  });

  app.openapi({ ...submitRoute, middleware: guard('write') }, async (c) => {
    const { version, channel } = c.req.valid('json');
    const result = await run(() =>
      submitCampaignSetupDraft(db, {
        ...actor(c),
        draftId: c.req.valid('param').id,
        version,
        channel,
        limitFor,
        enqueue: async (tx: DbOrTx, submission) => {
          for (const connection of await listSubmissionConnections(tx, [submission.id])) {
            await deps.jobs.enqueueAdChangesSubmit(connection, { tx });
          }
        },
      }),
    );
    if (result.status === 'rejected') return c.json(result, 200);
    const { submission } = result;
    return c.json(
      {
        ...result,
        submission: {
          ...submission,
          createdAt: submission.createdAt.toISOString(),
          startedAt: toIso(submission.startedAt),
          finishedAt: toIso(submission.finishedAt),
        },
      },
      200,
    );
  });
}
