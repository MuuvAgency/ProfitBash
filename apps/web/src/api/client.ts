import type {
  AmazonOAuthStart,
  BulkPeriod,
  Client,
  Connection,
  FileImport,
  FileImportKind,
  FileProfileCreate,
  JobRun,
  JobRunListQuery,
  Member,
  MeResponse,
  OrgRole,
  Profile,
  ProfilePatch,
  SavedView,
  SavedViewArea,
  SavedViewState,
  Settings,
} from '@profitbash/shared';
import createClient, { type Middleware } from 'openapi-fetch';
import { ApiError, toApiError } from './errors';
import type { components, paths } from './schema.gen';

type Schemas = components['schemas'];
export type AnalyticsQueryInput = Schemas['AnalyticsQuery'];
export type FilterOptions = Schemas['FilterOptionsResponse'];
export type DashboardData = Schemas['DashboardResponse'];
export type TimeSeriesInput = Schemas['TimeSeriesRequest'];
export type TimeSeriesData = Schemas['TimeSeriesResponse'];
export type ExplorerRowsInput = Schemas['ExplorerRowsRequest'];
export type ExplorerRowsData = Schemas['ExplorerRowsResponse'];
export type AsinSearchInput = Schemas['AsinSearchRequest'];
export type SearchTermPeriodData = Schemas['SearchTermPeriod'];
export type SearchTermAnalysisData = Schemas['SearchTermAnalysisResponse'];
export type SearchTermRowData = Schemas['SearchTermRow'];
export type HarvestMarkData = Schemas['HarvestMark'];
export type TagData = Schemas['Tag'];
export type ProductGroupData = Schemas['ProductGroup'];
export type ProductGroupListData = Schemas['ProductGroupListResponse'];
export type AdvertisedProductsData = Schemas['AdvertisedProductsResponse'];
export type StructureCatalogData = Schemas['StructureCatalogResponse'];
export type PlanSetupInput = Schemas['PlanCampaignSetupRequest'];
export type PlanSetupData = Schemas['PlanCampaignSetupResponse'];
export type SetupDraftData = Schemas['CampaignSetupDraft'];
export type SetupDraftListData = Schemas['CampaignSetupDraftList'];
export type SaveSetupDraftInput = Schemas['SaveCampaignSetupDraftRequest'];
export type SubmitSetupData = Schemas['SubmitCampaignSetupResponse'];
export type SetupIssueData = Schemas['SetupIssue'];
export type PlannedCampaignData = SetupDraftData['campaigns'][number];
export type SourceNegativeData = Schemas['SourceNegative'];
export type SetupHarvestListData = Schemas['SetupHarvestList'];
export type SetupHarvestMarkData = SetupHarvestListData['marks'][number];
export type AssignTagsInput = Schemas['AssignTagsRequest'];
export type AssignTagsData = Schemas['AssignTagsResponse'];
export type HarvestListData = Schemas['HarvestListResponse'];
export type HarvestMarkResultData = Schemas['HarvestMarkResponse'];
export type SearchTermNgramData = Schemas['SearchTermNgram'];
export type SearchTermRulesData = Schemas['SearchTermRules'];
export type SearchTermRuleOverridesData = Schemas['SearchTermRuleOverrides'];
export type AdChangeInputData = Schemas['AdChangeInput'];
export type PendingAdChangesData = Schemas['PendingAdChangesResponse'];
export type StageAdChangesData = Schemas['StageAdChangesResponse'];
export type OpenAdChangesData = Schemas['OpenAdChangesResponse'];
export type AdChangeCheckData = Schemas['AdChangeCheck'];
export type AdChangeSubmissionData = Schemas['AdChangeSubmission'];
export type AdChangeSubmissionDetailData = Schemas['AdChangeSubmissionDetail'];
export type SubmitAdChangesInput = Schemas['SubmitAdChangesRequest'];
export type SubmitAdChangesData = Schemas['SubmitAdChangesResponse'];
export type RetryAdChangesData = Schemas['RetryAdChangesResponse'];
export type RevertAdChangesInput = Schemas['RevertAdChangesRequest'];
export type RevertAdChangesData = Schemas['RevertAdChangesResponse'];
export type AdChangeChannelData = AdChangeSubmissionData['channel'];
/** Eine Änderung im Warenkorb (mit `otherUsers`) bzw. in einer Übermittlung (mit `followUp`). */
export type PendingAdChangeData = PendingAdChangesData['changes'][number];
export type SubmittedAdChangeData = AdChangeSubmissionDetailData['changes'][number];
export type SetupItemData = AdChangeSubmissionDetailData['setupItems'][number];

export interface ApiOptions {
  /**
   * Wird aufgerufen, wenn ein eigener Endpunkt mit 401 antwortet (Session abgelaufen oder widerrufen).
   * Fehlgeschlagene Logins unter `/api/auth/*` lösen es nicht aus.
   */
  onUnauthorized?: () => void;
}

export interface SignInInput {
  email: string;
  password: string;
}

const AUTH_PREFIX = '/api/auth/';

/** Nur Requests an dieselbe Origin: Cookies und CSRF-Schutz der API setzen das voraus. */
const sameOrigin = { credentials: 'same-origin' } as const;

function origin(): string {
  return globalThis.location.origin;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Liefert `data` oder wirft den Fehler als `ApiError` (auch bei Verbindungsfehlern). */
async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  let result: Awaited<typeof call>;
  try {
    result = await call;
  } catch (cause) {
    throw cause instanceof ApiError ? cause : ApiError.network(cause);
  }
  if (!result.response.ok) throw toApiError(result.response.status, result.error ?? null);
  // Ohne Body (z. B. 204) liefert openapi-fetch `undefined`; das ist ein Erfolg.
  return result.data as T;
}

export function createApi(options: ApiOptions = {}) {
  const client = createClient<paths>({
    baseUrl: origin(),
    // Erst beim Request auflösen, damit Tests `fetch` austauschen können.
    fetch: (request) => globalThis.fetch(request),
    ...sameOrigin,
  });

  const unauthorizedMiddleware: Middleware = {
    onResponse({ response }) {
      if (response.status === 401) options.onUnauthorized?.();
    },
  };
  client.use(unauthorizedMiddleware);

  /** better-auth-Endpunkte (nicht im OpenAPI-Dokument). Immer POST mit JSON-Body. */
  async function postAuth<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await globalThis.fetch(
        new Request(`${origin()}${AUTH_PREFIX}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          ...sameOrigin,
        }),
      );
    } catch (cause) {
      throw ApiError.network(cause);
    }
    const data = await readBody(response);
    if (!response.ok) throw toApiError(response.status, data);
    return data as T;
  }

  return {
    client,

    me: (): Promise<MeResponse> => unwrap(client.GET('/api/me')),

    updateSettings: (settings: Settings): Promise<Settings> =>
      unwrap(client.PUT('/api/settings', { body: settings })),

    async getUiState(scope: string, key: string): Promise<unknown> {
      const { value } = await unwrap(
        client.GET('/api/settings/ui-state/{scope}/{key}', { params: { path: { scope, key } } }),
      );
      return value;
    },

    async putUiState(scope: string, key: string, value: unknown): Promise<void> {
      await unwrap(
        client.PUT('/api/settings/ui-state/{scope}/{key}', {
          params: { path: { scope, key } },
          body: { value },
        }),
      );
    },

    listConnections: async (): Promise<Connection[]> =>
      (await unwrap(client.GET('/api/connections'))).connections,

    /** Liefert die Einwilligungs-URL; der Browser navigiert danach dorthin. */
    startAmazonOAuth: async (input: AmazonOAuthStart = {}): Promise<string> =>
      (await unwrap(client.POST('/api/amazon/oauth/start', { body: input }))).url,

    /** Plant den Profil-Sync ein. `409 CONNECTION_REAUTH_REQUIRED`: erst neu verbinden. */
    async syncConnection(connectionId: string): Promise<void> {
      await unwrap(
        client.POST('/api/connections/{id}/sync', { params: { path: { id: connectionId } } }),
      );
    },

    /** Profile einer Connection inkl. ausgeblendeter und entfernter. */
    listProfiles: async (connectionId: string): Promise<Profile[]> =>
      (
        await unwrap(
          client.GET('/api/connections/{id}/profiles', { params: { path: { id: connectionId } } }),
        )
      ).profiles,

    /** Profile ohne Connection (Datei-Import) inkl. ausgeblendeter und entfernter. */
    listFileProfiles: async (): Promise<Profile[]> =>
      (await unwrap(client.GET('/api/profiles/file'))).profiles,

    createFileProfile: (input: FileProfileCreate): Promise<Profile> =>
      unwrap(client.POST('/api/profiles', { body: input })),

    updateProfile: (profileId: string, patch: ProfilePatch): Promise<Profile> =>
      unwrap(
        client.PATCH('/api/profiles/{id}', { params: { path: { id: profileId } }, body: patch }),
      ),

    /** Verlauf der Datei-Importe eines Profils ohne Connection (1.11c), neueste zuerst. */
    listFileImports: async (profileId: string): Promise<FileImport[]> =>
      (
        await unwrap(
          client.GET('/api/profiles/{id}/file-imports', { params: { path: { id: profileId } } }),
        )
      ).fileImports,

    /**
     * Datei hochladen (Multipart); `complete` nur für Downloads mit allen Elementen (1.11d), `period` nur für
     * Dateien, deren Name keinen Zeitraum trägt (2b.2c).
     */
    uploadFileImport: (
      profileId: string,
      input: { kind: FileImportKind; file: File; complete: boolean; period?: BulkPeriod | null },
    ): Promise<FileImport> => {
      const form = new FormData();
      form.append('kind', input.kind);
      form.append('complete', String(input.complete));
      if (input.period) {
        form.append('periodStart', input.period.startDate);
        form.append('periodEnd', input.period.endDate);
      }
      form.append('file', input.file, input.file.name);
      return unwrap(
        client.POST('/api/profiles/{id}/file-imports', {
          params: { path: { id: profileId } },
          // Der Typ beschreibt die Felder; gesendet wird das FormData (Content-Type samt Boundary setzt der Browser).
          body: {
            kind: input.kind,
            file: input.file.name,
            complete: input.complete ? 'true' : 'false',
            ...(input.period && {
              periodStart: input.period.startDate,
              periodEnd: input.period.endDate,
            }),
          },
          bodySerializer: () => form,
        }),
      );
    },

    listClients: async (): Promise<Client[]> => (await unwrap(client.GET('/api/clients'))).clients,

    createClient: (input: { name: string }): Promise<Client> =>
      unwrap(client.POST('/api/clients', { body: input })),

    /** Geschützte Begriffe ersetzen (Suchbegriff-Analyse: nie ein Negativ-Vorschlag). */
    updateClient: (id: string, patch: { protectedTerms: string[] }): Promise<Client> =>
      unwrap(client.PATCH('/api/clients/{id}', { params: { path: { id } }, body: patch })),

    /** Suchbegriff-Analyse (2b.2): je Profil und **einem** Datei-Zeitraum, Regeln je Organisation. */
    searchTerms: {
      periods: async (): Promise<SearchTermPeriodData[]> =>
        (await unwrap(client.POST('/api/ads/search-terms/periods', { body: {} }))).periods,
      analysis: (input: {
        profileId: string;
        periodStart: string;
        periodEnd: string;
      }): Promise<SearchTermAnalysisData> =>
        unwrap(client.POST('/api/ads/search-terms/analysis', { body: input })),
      saveRules: (rules: SearchTermRulesData) =>
        unwrap(client.PUT('/api/ads/search-terms/rules', { body: rules })),
      /** Abweichende Regeln eines Profils (2b.2g); alle Felder `null` nimmt die Abweichung zurück. */
      saveProfileRules: (input: { profileId: string; overrides: SearchTermRuleOverridesData }) =>
        unwrap(client.PUT('/api/ads/search-terms/rules/profile', { body: input })),
      /** Löscht die Suchbegriffe genau eines Datei-Zeitraums (2b.2d), über alle Ad-Typen. */
      deletePeriod: (input: { profileId: string; periodStart: string; periodEnd: string }) =>
        unwrap(client.POST('/api/ads/search-terms/periods/delete', { body: input })),
      /** Harvest-Merkliste je Profil (`phase-3.md` 3.8): keine Änderung bei Amazon. */
      harvest: {
        /** Höchstens `MAX_HARVEST_TERMS_PER_REQUEST` Begriffe je Anfrage; Quelle und Kennzahlen liest der Server. */
        mark: (input: {
          profileId: string;
          periodStart: string;
          periodEnd: string;
          searchTerms: string[];
        }): Promise<HarvestMarkResultData> =>
          unwrap(client.POST('/api/ads/search-terms/harvest', { body: input })),
        list: (profileId: string): Promise<HarvestListData> =>
          unwrap(client.POST('/api/ads/search-terms/harvest/list', { body: { profileId } })),
        remove: (ids: string[]) =>
          unwrap(client.POST('/api/ads/search-terms/harvest/remove', { body: { ids } })),
      },
    },

    /** Tools (`phase-4.md`): Produktgruppen und die beworbenen Produkte eines Profils als Auswahl. */
    tools: {
      productGroups: {
        list: (): Promise<ProductGroupListData> =>
          unwrap(client.GET('/api/ads/tools/product-groups')),
        create: (input: Schemas['CreateProductGroupRequest']): Promise<ProductGroupData> =>
          unwrap(client.POST('/api/ads/tools/product-groups', { body: input })),
        update: (
          id: string,
          input: Schemas['UpdateProductGroupRequest'],
        ): Promise<ProductGroupData> =>
          unwrap(
            client.PATCH('/api/ads/tools/product-groups/{id}', {
              params: { path: { id } },
              body: input,
            }),
          ),
        remove: (id: string) =>
          unwrap(client.DELETE('/api/ads/tools/product-groups/{id}', { params: { path: { id } } })),
      },
      catalog: {
        get: (): Promise<StructureCatalogData> => unwrap(client.GET('/api/ads/tools/catalog')),
        save: (input: Schemas['SaveStructureCatalogRequest']): Promise<StructureCatalogData> =>
          unwrap(client.PUT('/api/ads/tools/catalog', { body: input })),
        setClientPreset: (clientId: string, presetKey: string | null) =>
          unwrap(
            client.PUT('/api/ads/tools/client-presets/{clientId}', {
              params: { path: { clientId } },
              body: { presetKey },
            }),
          ),
      },
      /** Kampagnen-Setup (`phase-4.md` 4.5): planen, Entwürfe, übermitteln. */
      setup: {
        plan: (input: PlanSetupInput): Promise<PlanSetupData> =>
          unwrap(client.POST('/api/ads/tools/setup/plan', { body: input })),
        list: (): Promise<SetupDraftListData> => unwrap(client.GET('/api/ads/tools/setup/drafts')),
        harvest: (profileId: string): Promise<SetupHarvestListData> =>
          unwrap(client.GET('/api/ads/tools/setup/harvest', { params: { query: { profileId } } })),
        get: (id: string): Promise<SetupDraftData> =>
          unwrap(client.GET('/api/ads/tools/setup/drafts/{id}', { params: { path: { id } } })),
        create: (draft: SaveSetupDraftInput): Promise<SetupDraftData> =>
          unwrap(client.POST('/api/ads/tools/setup/drafts', { body: draft })),
        update: (
          id: string,
          version: number,
          draft: SaveSetupDraftInput,
        ): Promise<SetupDraftData> =>
          unwrap(
            client.PUT('/api/ads/tools/setup/drafts/{id}', {
              params: { path: { id } },
              body: { version, draft },
            }),
          ),
        discard: (id: string, version: number): Promise<SetupDraftData> =>
          unwrap(
            client.POST('/api/ads/tools/setup/drafts/{id}/discard', {
              params: { path: { id } },
              body: { version },
            }),
          ),
        submit: (
          id: string,
          version: number,
          channel: AdChangeChannelData,
        ): Promise<SubmitSetupData> =>
          unwrap(
            client.POST('/api/ads/tools/setup/drafts/{id}/submit', {
              params: { path: { id } },
              body: { version, channel },
            }),
          ),
      },
      advertisedProducts: (profileId: string): Promise<AdvertisedProductsData> =>
        unwrap(
          client.GET('/api/ads/tools/advertised-products', { params: { query: { profileId } } }),
        ),
    },

    /** Eigene Tags der Organisation (`phase-3.md` 3.7): verwalten und Entities zuweisen. */
    tags: {
      list: async (): Promise<TagData[]> => (await unwrap(client.GET('/api/ads/tags'))).tags,
      create: (input: Schemas['CreateTagRequest']): Promise<TagData> =>
        unwrap(client.POST('/api/ads/tags', { body: input })),
      update: (id: string, input: Schemas['UpdateTagRequest']): Promise<TagData> =>
        unwrap(client.PATCH('/api/ads/tags/{id}', { params: { path: { id } }, body: input })),
      remove: (id: string) =>
        unwrap(client.DELETE('/api/ads/tags/{id}', { params: { path: { id } } })),
      /** Höchstens `MAX_TAG_ASSIGN_ENTITIES` Entities je Anfrage. */
      assign: (input: AssignTagsInput): Promise<AssignTagsData> =>
        unwrap(client.POST('/api/ads/tags/assign', { body: input })),
    },

    /** Letzte Jobläufe der aktiven Org (Sync-Status), neueste zuerst. */
    listJobRuns: async (query: JobRunListQuery = {}): Promise<JobRun[]> =>
      (await unwrap(client.GET('/api/job-runs', { params: { query } }))).jobRuns,

    /** Auswertungen (`/api/ads/*`): alle POST, Auswahl und IDs im Body, Beträge als Decimal-Strings. */
    analytics: {
      filterOptions: (): Promise<FilterOptions> =>
        unwrap(client.POST('/api/ads/filter-options', { body: {} })),
      dashboard: (query: AnalyticsQueryInput): Promise<DashboardData> =>
        unwrap(client.POST('/api/ads/dashboard', { body: query })),
      timeSeries: (input: TimeSeriesInput): Promise<TimeSeriesData> =>
        unwrap(client.POST('/api/ads/timeseries', { body: input })),
      explorerRows: (input: ExplorerRowsInput): Promise<ExplorerRowsData> =>
        unwrap(client.POST('/api/ads/explorer/rows', { body: input })),
      asinSearch: (input: AsinSearchInput): Promise<ExplorerRowsData> =>
        unwrap(client.POST('/api/ads/asin-search', { body: input })),
    },

    /** Änderungen (`/api/ads/changes/*`, Feature `changes`): Warenkorb je Nutzer, offene Änderungen fürs Grid. */
    adChanges: {
      pending: (): Promise<PendingAdChangesData> => unwrap(client.GET('/api/ads/changes/pending')),
      /** Vormerken: je Eingabe ein Ergebnis in derselben Reihenfolge (viele IDs, deshalb im Body). */
      stage: (
        changes: AdChangeInputData[],
        origin: 'explorer' | 'search_terms' = 'explorer',
      ): Promise<StageAdChangesData> =>
        unwrap(client.POST('/api/ads/changes/pending', { body: { origin, changes } })),
      /** Genannte oder (ohne Angabe) alle eigenen vorgemerkten Änderungen verwerfen. */
      discard: (changeIds?: string[]) =>
        unwrap(
          client.POST('/api/ads/changes/pending/discard', {
            body: changeIds ? { changeIds } : {},
          }),
        ),
      /**
       * Übermitteln: `limitsExceeded` und `needsConfirmation` übermitteln nichts (Grenzen von Amazon bzw.
       * Warnungen, die mit `confirmWarnings` bestätigt werden). `409 PROFILE_HAS_NO_CONNECTION`: nur als Bulk-Datei.
       */
      submit: (input: SubmitAdChangesInput): Promise<SubmitAdChangesData> =>
        unwrap(client.POST('/api/ads/changes/submit', { body: input })),
      /** Übermittlungen der Organisation, neueste zuerst (höchstens 100). */
      submissions: async (): Promise<AdChangeSubmissionData[]> =>
        (await unwrap(client.GET('/api/ads/changes/submissions'))).submissions,
      submission: (id: string): Promise<AdChangeSubmissionDetailData> =>
        unwrap(client.GET('/api/ads/changes/submissions/{id}', { params: { path: { id } } })),
      /** Die `.xlsx` für die Werbekonsole samt Dateiname aus `Content-Disposition`. */
      async bulkFile(id: string): Promise<{ fileName: string; blob: Blob }> {
        let result;
        try {
          result = await client.GET('/api/ads/changes/submissions/{id}/bulk-file', {
            params: { path: { id } },
            parseAs: 'blob',
          });
        } catch (cause) {
          throw cause instanceof ApiError ? cause : ApiError.network(cause);
        }
        if (!result.response.ok) {
          throw toApiError(result.response.status, result.error ?? null);
        }
        const disposition = result.response.headers.get('content-disposition') ?? '';
        const fileName =
          /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'profitbash-aenderungen.xlsx';
        return { fileName, blob: result.data as unknown as Blob };
      },
      /** Bulk-Übermittlung von Hand abschließen: hochgeladen (`applied`) oder nicht (`discarded`). */
      close: (id: string, outcome: 'applied' | 'discarded') =>
        unwrap(
          client.POST('/api/ads/changes/submissions/{id}/close', {
            params: { path: { id } },
            body: { outcome },
          }),
        ),
      retry: (input: {
        changeIds: string[];
        channel: AdChangeChannelData;
      }): Promise<RetryAdChangesData> =>
        unwrap(client.POST('/api/ads/changes/retry', { body: input })),
      dismiss: (changeIds: string[]) =>
        unwrap(client.POST('/api/ads/changes/dismiss', { body: { changeIds } })),
      /** Revert: `conflict` übermittelt nichts (Rückfrage, F8), erst mit `overwriteChanged`. */
      revert: (input: RevertAdChangesInput): Promise<RevertAdChangesData> =>
        unwrap(client.POST('/api/ads/changes/revert', { body: input })),
      /** Offene Änderungen aller Nutzer (vorgemerkt oder übermittelt ohne Ergebnis), optional je Profil. */
      open: (profileId?: string): Promise<OpenAdChangesData> =>
        unwrap(
          client.GET('/api/ads/changes/open', {
            params: { query: profileId ? { profileId } : {} },
          }),
        ),
    },

    /** Mitglieder (F9, nur Org-Admins). Links zum Passwort-Setzen kommen nur beim Anlegen bzw. Neu-Erzeugen. */
    members: {
      list: async (): Promise<Member[]> => (await unwrap(client.GET('/api/members'))).members,
      create: (input: { email: string; name: string; role: OrgRole }) =>
        unwrap(client.POST('/api/members', { body: input })),
      updateRole: (id: string, role: OrgRole): Promise<Member> =>
        unwrap(client.PATCH('/api/members/{id}', { params: { path: { id } }, body: { role } })),
      async remove(id: string): Promise<void> {
        await unwrap(client.DELETE('/api/members/{id}', { params: { path: { id } } }));
      },
      renewLink: (id: string) =>
        unwrap(client.POST('/api/members/{id}/password-link', { params: { path: { id } } })),
    },

    /** Öffentlich (ohne Session): Link zum Passwort-Setzen prüfen und einlösen, Token im Body. */
    passwordLinks: {
      inspect: (token: string) =>
        unwrap(client.POST('/api/password-links/inspect', { body: { token } })),
      async redeem(token: string, password: string): Promise<void> {
        await unwrap(client.POST('/api/password-links/redeem', { body: { token, password } }));
      },
    },

    /** Gespeicherte Ansichten (F8): eigene und freigegebene, Unsichtbares filtert der Server. */
    savedViews: {
      list: async (area: SavedViewArea): Promise<SavedView[]> =>
        (await unwrap(client.GET('/api/saved-views', { params: { query: { area } } }))).views,
      get: (id: string): Promise<SavedView> =>
        unwrap(client.GET('/api/saved-views/{id}', { params: { path: { id } } })),
      create: (input: {
        name: string;
        area: SavedViewArea;
        shared?: boolean;
        state: SavedViewState;
      }): Promise<SavedView> => unwrap(client.POST('/api/saved-views', { body: input })),
      update: (
        id: string,
        patch: { name?: string; shared?: boolean; state?: SavedViewState },
      ): Promise<SavedView> =>
        unwrap(client.PATCH('/api/saved-views/{id}', { params: { path: { id } }, body: patch })),
      async remove(id: string): Promise<void> {
        await unwrap(client.DELETE('/api/saved-views/{id}', { params: { path: { id } } }));
      },
    },

    auth: {
      signIn: (input: SignInInput) => postAuth<unknown>('sign-in/email', input),
      signOut: () => postAuth<unknown>('sign-out', {}),
      setActiveOrganization: (organizationId: string) =>
        postAuth<unknown>('organization/set-active', { organizationId }),
    },
  };
}

export type Api = ReturnType<typeof createApi>;
