import type {
  AdChangeChannel,
  CampaignSetupDraftStatus,
  CampaignSetupState,
  PlannedCampaign,
  SaveCampaignSetupDraft,
  SetupInputs,
} from '@profitbash/shared';
import { Dec, type AdChangeLimitLookup } from '@profitbash/engine';
import { planSetupItems, reviewCampaignPlan, type PlanReviewIssue } from '@profitbash/engine/plan';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { visibleProfilesScope } from './access';
import { loadAdChangeSubmissionSummaries, type AdChangeSubmissionSummary } from './ad-changes';
import { closeAdChangeSubmission } from './ad-change-processing';
import { recordAuditEvent, type DbOrTx } from './audit';
import type { Db } from './client';
import {
  adChangeSubmissions,
  amazonAdsCampaigns,
  amazonAdsProfiles,
  amazonAdsTargetDailyMetrics,
  amazonAdsTargets,
  campaignSetupDrafts,
  campaignSetupItems,
  productGroups,
  users,
} from './schema';
import { assertPresetKnown, StructureCatalogError } from './structure-catalog';

/**
 * Setup-Entwürfe (`docs/tasks/phase-4.md` 4.4, F5, F13): speichern, lesen, verwerfen und übermitteln. Entwürfe
 * gehören dem Team: Wer das Profil sieht, sieht seine Entwürfe (`visibleProfilesScope()`, ADR 002); das Recht
 * (`write` bzw. `view` im Feature `tools`) prüft die API, die Eingaben `saveCampaignSetupDraftSchema`.
 *
 * Übermitteln: Ein Entwurf wird zu **einer** Übermittlung der Art `setup` (Seite „Änderungen“, ein Entwurf = eine
 * Bulk-Datei) mit je einer Zeile in `campaign_setup_items` pro neuer Entity. Davor prüft `reviewCampaignPlan` den
 * gespeicherten Plan in der Transaktion gegen den aktuellen Stand des Profils (Namen, Grenzen); Fehler sperren.
 * SB- und SD-Kampagnen legt Phase 4 erst mit 4.9/4.10 an: Sie stehen als gescheiterte Kampagne
 * (`AD_PRODUCT_NOT_SUPPORTED`) in der Übermittlung.
 */

export type CampaignSetupErrorCode =
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'NOT_DRAFT'
  | 'PROFILE_CHANGED'
  | 'PRODUCT_GROUP_MISMATCH'
  | 'UNKNOWN_PRESET'
  | 'PROFILE_HAS_NO_CONNECTION';

export class CampaignSetupError extends Error {
  constructor(
    public readonly code: CampaignSetupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CampaignSetupError';
  }
}

const notFound = () => new CampaignSetupError('NOT_FOUND', 'Entwurf oder Profil nicht gefunden.');
const versionConflict = () =>
  new CampaignSetupError(
    'VERSION_CONFLICT',
    'Der Entwurf wurde inzwischen geändert. Bitte neu laden.',
  );
const notDraft = () =>
  new CampaignSetupError('NOT_DRAFT', 'Der Entwurf ist schon übermittelt oder verworfen.');

export interface CampaignSetupActor {
  userId: string;
  orgId: string;
}

export interface CampaignSetupDraftRecord {
  id: string;
  profileId: string;
  productGroupId: string | null;
  presetKey: string;
  name: string;
  status: CampaignSetupDraftStatus;
  campaignState: CampaignSetupState;
  inputs: SetupInputs;
  campaigns: PlannedCampaign[];
  version: number;
  submissionId: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Eintrag der Liste: ohne Plan, mit Zahl der Kampagnen und Namen des Erstellers. */
export type CampaignSetupDraftSummary = Omit<CampaignSetupDraftRecord, 'inputs' | 'campaigns'> & {
  campaigns: number;
  createdByName: string | null;
};

const d = campaignSetupDrafts;
const record = (row: typeof d.$inferSelect): CampaignSetupDraftRecord => ({
  id: row.id,
  profileId: row.profileId,
  productGroupId: row.productGroupId,
  presetKey: row.presetKey,
  name: row.name,
  status: row.status as CampaignSetupDraftStatus,
  campaignState: row.campaignState as CampaignSetupState,
  inputs: row.inputs,
  campaigns: row.campaigns,
  version: row.version,
  submissionId: row.submissionId,
  createdBy: row.createdBy,
  updatedBy: row.updatedBy,
  submittedAt: row.submittedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Sichtbares Profil (für die Dauer der Transaktion gesperrt); `NOT_FOUND` sonst. */
async function lockVisibleProfile(tx: Tx, scope: ProfileIds, profileId: string) {
  const [profile] = await tx
    .select({
      id: amazonAdsProfiles.id,
      countryCode: amazonAdsProfiles.countryCode,
      currencyCode: amazonAdsProfiles.currencyCode,
      accountType: amazonAdsProfiles.accountType,
      timezone: amazonAdsProfiles.timezone,
      connectionId: amazonAdsProfiles.connectionId,
    })
    .from(amazonAdsProfiles)
    .where(and(eq(amazonAdsProfiles.id, profileId), inArray(amazonAdsProfiles.id, scope.ids)))
    .for('share');
  if (!profile) throw notFound();
  return profile;
}

type ProfileIds = NonNullable<Awaited<ReturnType<typeof visibleProfilesScope>>>;

/** Entwurf in einem sichtbaren Profil, für die Transaktion gesperrt. */
async function lockDraft(tx: Tx, scope: ProfileIds, draftId: string) {
  const [row] = await tx
    .select()
    .from(d)
    .where(and(eq(d.id, draftId), inArray(d.profileId, scope.ids)))
    .for('update');
  if (!row) throw notFound();
  return row;
}

function assertOpen(row: typeof d.$inferSelect, version: number) {
  if (row.status !== 'draft') throw notDraft();
  if (row.version !== version) throw versionConflict();
}

async function checkDraftReferences(tx: Tx, orgId: string, draft: SaveCampaignSetupDraft) {
  try {
    await assertPresetKnown(tx, orgId, draft.presetKey);
  } catch (error) {
    if (error instanceof StructureCatalogError && error.code === 'UNKNOWN_PRESET') {
      throw new CampaignSetupError('UNKNOWN_PRESET', error.message);
    }
    throw error;
  }
  if (draft.productGroupId === null) return;
  const [group] = await tx
    .select({ profileId: productGroups.profileId })
    .from(productGroups)
    .where(eq(productGroups.id, draft.productGroupId));
  if (group?.profileId !== draft.profileId) {
    throw new CampaignSetupError(
      'PRODUCT_GROUP_MISMATCH',
      'Die Produktgruppe gehört nicht zu diesem Profil.',
    );
  }
}

/**
 * Legt einen Entwurf an (ohne `draftId`) oder ändert ihn (mit `draftId` und der `version`, auf der die Änderung
 * beruht). Audit `campaign_setup_draft.create|update`. `null` für Nicht-Mitglieder.
 */
export async function saveCampaignSetupDraft(
  db: Db,
  input: CampaignSetupActor & {
    draftId?: string;
    version?: number;
    draft: SaveCampaignSetupDraft;
  },
): Promise<CampaignSetupDraftRecord | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const { draft } = input;
  return db.transaction(async (tx) => {
    await lockVisibleProfile(tx, scope, draft.profileId);
    await checkDraftReferences(tx, input.orgId, draft);
    const values = {
      productGroupId: draft.productGroupId,
      presetKey: draft.presetKey,
      name: draft.name,
      campaignState: draft.campaignState,
      inputs: draft.inputs,
      campaigns: draft.campaigns,
      updatedBy: input.userId,
    };

    if (input.draftId === undefined) {
      const [row] = await tx
        .insert(d)
        .values({
          ...values,
          organizationId: input.orgId,
          profileId: draft.profileId,
          createdBy: input.userId,
        })
        .returning();
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'campaign_setup_draft.create',
        target: {
          type: 'campaign_setup_draft',
          id: row!.id,
          profileId: draft.profileId,
          name: draft.name,
          campaigns: draft.campaigns.length,
        },
      });
      return record(row!);
    }

    const before = await lockDraft(tx, scope, input.draftId);
    assertOpen(before, input.version ?? -1);
    if (before.profileId !== draft.profileId) {
      throw new CampaignSetupError(
        'PROFILE_CHANGED',
        'Ein Entwurf bleibt in seinem Profil; für ein anderes Profil einen neuen anlegen.',
      );
    }
    const [row] = await tx
      .update(d)
      .set({ ...values, version: before.version + 1 })
      .where(eq(d.id, before.id))
      .returning();
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'campaign_setup_draft.update',
      target: {
        type: 'campaign_setup_draft',
        id: before.id,
        profileId: before.profileId,
        name: draft.name,
        campaigns: draft.campaigns.length,
        version: row!.version,
      },
    });
    return record(row!);
  });
}

/**
 * Offene und übermittelte Entwürfe der sichtbaren Profile (verworfene nicht), zuletzt geänderte zuerst; optional nur
 * eines Profils. `null` für Nicht-Mitglieder.
 */
export async function listCampaignSetupDrafts(
  db: Db,
  input: CampaignSetupActor & { profileId?: string },
): Promise<CampaignSetupDraftSummary[] | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const rows = await db
    .select({
      id: d.id,
      profileId: d.profileId,
      productGroupId: d.productGroupId,
      presetKey: d.presetKey,
      name: d.name,
      status: d.status,
      campaignState: d.campaignState,
      campaigns: sql<number>`jsonb_array_length(${d.campaigns})::int`,
      version: d.version,
      submissionId: d.submissionId,
      createdBy: d.createdBy,
      createdByName: users.name,
      updatedBy: d.updatedBy,
      submittedAt: d.submittedAt,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })
    .from(d)
    .leftJoin(users, eq(users.id, d.createdBy))
    .where(
      and(
        inArray(d.profileId, scope.ids),
        ne(d.status, 'discarded'),
        input.profileId === undefined ? undefined : eq(d.profileId, input.profileId),
      ),
    )
    .orderBy(desc(d.updatedAt), desc(d.id))
    .limit(500);
  return rows.map((row) => ({
    ...row,
    status: row.status as CampaignSetupDraftStatus,
    campaignState: row.campaignState as CampaignSetupState,
  }));
}

/** Ein Entwurf mit Plan; `NOT_FOUND` für fremde und unsichtbare, `null` für Nicht-Mitglieder. */
export async function getCampaignSetupDraft(
  db: Db,
  input: CampaignSetupActor & { draftId: string },
): Promise<CampaignSetupDraftRecord | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const [row] = await db
    .select()
    .from(d)
    .where(and(eq(d.id, input.draftId), inArray(d.profileId, scope.ids)));
  if (!row) throw notFound();
  return record(row);
}

/** Verwirft einen offenen Entwurf (Audit `campaign_setup_draft.discard`). `null` für Nicht-Mitglieder. */
export async function discardCampaignSetupDraft(
  db: Db,
  input: CampaignSetupActor & { draftId: string; version: number },
): Promise<CampaignSetupDraftRecord | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  return db.transaction(async (tx) => {
    const before = await lockDraft(tx, scope, input.draftId);
    assertOpen(before, input.version);
    const [row] = await tx
      .update(d)
      .set({ status: 'discarded', version: before.version + 1, updatedBy: input.userId })
      .where(eq(d.id, before.id))
      .returning();
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'campaign_setup_draft.discard',
      target: {
        type: 'campaign_setup_draft',
        id: before.id,
        profileId: before.profileId,
        name: before.name,
      },
    });
    return record(row!);
  });
}

export interface CampaignSetupContext {
  profile: { countryCode: string; currencyCode: string; accountType: string; timezone: string };
  /** Für Dubletten (`buildCampaignPlan`, `reviewCampaignPlan`). */
  existing: {
    campaignNames: string[];
    exactKeywords: { text: string; campaignName: string }[];
  };
}

/**
 * Was es im Profil schon gibt: Namen aller nicht entfernten Kampagnen (auch archivierte, Amazon vergibt einen Namen
 * nur einmal) und der Kampagnen offener oder angelegter Setups, die der Import noch nicht kennt, dazu exakt gebuchte
 * Keywords (nicht archiviert, auch aus Setups).
 */
async function loadContext(
  db: DbOrTx,
  profileId: string,
): Promise<CampaignSetupContext['existing']> {
  const campaigns = await db
    .select({ name: amazonAdsCampaigns.name })
    .from(amazonAdsCampaigns)
    .where(and(eq(amazonAdsCampaigns.profileId, profileId), isNull(amazonAdsCampaigns.removedAt)));
  const setups = await db
    .select({ name: sql<string>`${campaignSetupItems.payload}->>'name'` })
    .from(campaignSetupItems)
    .where(
      and(
        eq(campaignSetupItems.profileId, profileId),
        eq(campaignSetupItems.entityType, 'campaign'),
        inArray(campaignSetupItems.status, ['submitted', 'applied']),
      ),
    );
  const names = new Map<string, string>();
  for (const { name } of [...campaigns, ...setups]) {
    if (name) names.set(name.toLowerCase(), name);
  }
  const exactKeywords = await db
    .select({ text: amazonAdsTargets.keywordText, campaignName: amazonAdsCampaigns.name })
    .from(amazonAdsTargets)
    .innerJoin(amazonAdsCampaigns, eq(amazonAdsCampaigns.id, amazonAdsTargets.campaignId))
    .where(
      and(
        eq(amazonAdsTargets.profileId, profileId),
        eq(amazonAdsTargets.targetType, 'keyword'),
        eq(amazonAdsTargets.matchType, 'EXACT'),
        ne(amazonAdsTargets.state, 'ARCHIVED'),
        isNull(amazonAdsTargets.removedAt),
      ),
    );
  // Exakte Keywords offener bzw. angelegter Setups, die der Import noch nicht kennt.
  const setupKeywords = await db
    .select({
      text: sql<string>`${campaignSetupItems.payload}->>'text'`,
      campaignName: campaignSetupItems.campaignRef,
    })
    .from(campaignSetupItems)
    .where(
      and(
        eq(campaignSetupItems.profileId, profileId),
        eq(campaignSetupItems.entityType, 'keyword'),
        inArray(campaignSetupItems.status, ['submitted', 'applied']),
        sql`${campaignSetupItems.payload}->>'matchType' = 'exact'`,
      ),
    );
  const keywords = new Map<string, { text: string; campaignName: string }>();
  for (const { text, campaignName } of [...exactKeywords, ...setupKeywords]) {
    if (text && !keywords.has(text.toLowerCase())) {
      keywords.set(text.toLowerCase(), { text, campaignName: campaignName ?? '' });
    }
  }
  return { campaignNames: [...names.values()], exactKeywords: [...keywords.values()] };
}

/** Profil und Vorhandenes für das Planen eines Setups. `NOT_FOUND` für unsichtbare Profile, `null` für Nicht-Mitglieder. */
export async function getCampaignSetupContext(
  db: Db,
  input: CampaignSetupActor & { profileId: string },
): Promise<CampaignSetupContext | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const [profile] = await db
    .select({
      countryCode: amazonAdsProfiles.countryCode,
      currencyCode: amazonAdsProfiles.currencyCode,
      accountType: amazonAdsProfiles.accountType,
      timezone: amazonAdsProfiles.timezone,
    })
    .from(amazonAdsProfiles)
    .where(
      and(eq(amazonAdsProfiles.id, input.profileId), inArray(amazonAdsProfiles.id, scope.ids)),
    );
  if (!profile) throw notFound();
  return { profile, existing: await loadContext(db, input.profileId) };
}

export type SubmitCampaignSetupResult =
  | {
      status: 'submitted';
      submission: AdChangeSubmissionSummary;
      /** Zeilen der Übermittlung, davon nicht anlegbar (SB, SD). */
      items: number;
      unsupported: number;
      /** Warnungen und Hinweise der Prüfung (sperren nicht). */
      issues: PlanReviewIssue[];
    }
  /** Die Prüfung hat Fehler gemeldet; nichts wurde übermittelt. */
  | { status: 'rejected'; issues: PlanReviewIssue[] };

class ReviewRejected extends Error {
  constructor(public readonly issues: PlanReviewIssue[]) {
    super('Prüfung vor dem Übermitteln hat Fehler gemeldet.');
  }
}

/**
 * Übermittelt einen offenen Entwurf (mit seiner aktuellen `version`): eine Übermittlung der Art `setup` und je neuer
 * Entity eine Zeile, alles in einer Transaktion mit Audit `ad_change_submission.create` und dem Einplanen (`enqueue`,
 * nur Weg `api`). Über die API nur mit Connection (`PROFILE_HAS_NO_CONNECTION`). Meldet die Prüfung Fehler, bleibt alles
 * beim Alten (`rejected`). `null` für Nicht-Mitglieder.
 */
export async function submitCampaignSetupDraft(
  db: Db,
  input: CampaignSetupActor & {
    draftId: string;
    version: number;
    channel: AdChangeChannel;
    enqueue: (tx: DbOrTx, submission: AdChangeSubmissionSummary) => Promise<unknown>;
    /** Grenzen von Amazon (`amazonAdsValueLimit` aus `@profitbash/amazon-ads`). */
    limitFor: AdChangeLimitLookup;
  },
): Promise<SubmitCampaignSetupResult | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  try {
    return await db.transaction(async (tx) => {
      const draft = await lockDraft(tx, scope, input.draftId);
      assertOpen(draft, input.version);
      const profile = await lockVisibleProfile(tx, scope, draft.profileId);
      if (input.channel === 'api' && profile.connectionId === null) {
        throw new CampaignSetupError(
          'PROFILE_HAS_NO_CONNECTION',
          'Dieses Profil hat keine Verbindung zu Amazon; bitte als Bulk-Datei übermitteln.',
        );
      }
      // Gleichzeitige Übermittlungen im Profil sehen einander (Kampagnennamen offener Setups).
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`campaign-setup:${profile.id}`}))`,
      );
      const issues = reviewCampaignPlan({
        campaigns: draft.campaigns,
        profile,
        existing: await loadContext(tx, profile.id),
        limitFor: input.limitFor,
      });
      if (issues.some((issue) => issue.severity === 'error')) throw new ReviewRejected(issues);

      const [submission] = await tx
        .insert(adChangeSubmissions)
        .values({
          organizationId: input.orgId,
          profileId: profile.id,
          channel: input.channel,
          kind: 'setup',
          createdBy: input.userId,
        })
        .returning({ id: adChangeSubmissions.id });
      const specs = planSetupItems(draft.campaigns, {
        campaignState: draft.campaignState as CampaignSetupState,
      });
      const now = new Date();
      for (let start = 0; start < specs.length; start += 1000) {
        await tx.insert(campaignSetupItems).values(
          specs.slice(start, start + 1000).map((spec, index) => ({
            organizationId: input.orgId,
            profileId: profile.id,
            submissionId: submission!.id,
            draftId: draft.id,
            position: start + index,
            entityType: spec.entityType,
            campaignRef: spec.campaignRef,
            adGroupRef: spec.adGroupRef,
            payload: spec.payload,
            ...(!spec.supported && {
              status: 'failed',
              errorCode: 'AD_PRODUCT_NOT_SUPPORTED',
              errorMessage:
                'Sponsored Brands und Sponsored Display legt das Setup noch nicht an (kommt mit 4.9 bzw. 4.10).',
              resolvedAt: now,
            }),
          })),
        );
      }
      await tx
        .update(d)
        .set({
          status: 'submitted',
          submissionId: submission!.id,
          submittedAt: now,
          version: draft.version + 1,
          updatedBy: input.userId,
        })
        .where(eq(d.id, draft.id));
      const unsupported = specs.filter((spec) => !spec.supported).length;
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'ad_change_submission.create',
        target: {
          type: 'ad_change_submission',
          id: submission!.id,
          profileId: profile.id,
          channel: input.channel,
          kind: 'setup',
          draftId: draft.id,
          items: specs.length,
          unsupported,
        },
      });
      // Nichts anlegbar (nur SB/SD): sofort abgeschlossen, sonst hinge sie ohne Datei bzw. Job offen.
      if (specs.every((spec) => !spec.supported)) {
        await closeAdChangeSubmission(tx, { submissionId: submission!.id, now });
      }
      const [summary] = await loadAdChangeSubmissionSummaries(
        tx,
        eq(adChangeSubmissions.id, submission!.id),
      );
      if (input.channel === 'api' && summary!.status === 'pending')
        await input.enqueue(tx, summary!);
      return {
        status: 'submitted',
        submission: summary!,
        items: specs.length,
        unsupported,
        issues,
      };
    });
  } catch (error) {
    if (error instanceof ReviewRejected) return { status: 'rejected', issues: error.issues };
    throw error;
  }
}

/** Rückblick und Mindestdaten für Gebote aus dem Profil (F13). */
export const PROFILE_BID_LOOKBACK_DAYS = 60;
export const PROFILE_BID_MIN_CLICKS = 30;

export interface ProfileBidSuggestions {
  keyword?: Partial<Record<'broad' | 'phrase' | 'exact', string>>;
  product?: string;
  category?: string;
}

/**
 * Gebote aus den eigenen Daten des Profils (F13): mittlerer CPC (Kosten / Klicks) der Sponsored-Products-Targets in
 * den letzten 60 Tagen vor `today` (Tag in der Zeitzone des Profils), je Match-Typ der Keywords, Produkt-Targets und
 * Kategorien; nur ab 30 Klicks, auf zwei Nachkommastellen (half-even, ADR 003). Systemzugriff ohne Sichtbarkeit:
 * Der Aufrufer prüft das Profil.
 */
export async function loadProfileBidSuggestions(
  db: DbOrTx,
  input: { profileId: string; today: string },
): Promise<ProfileBidSuggestions> {
  const m = amazonAdsTargetDailyMetrics;
  const t = amazonAdsTargets;
  // Keywords je Match-Typ, Produkt-Targets (exakt und „ähnlich“) und Kategorien je Art zusammen.
  const matchType = sql<
    string | null
  >`case when ${t.targetType} = 'keyword' then upper(${t.matchType}) end`;
  const rows = await db
    .select({
      targetType: t.targetType,
      matchType,
      clicks: sql<number>`sum(${m.clicks})::int`,
      cost: sql<string>`sum(${m.cost})::text`,
    })
    .from(m)
    .innerJoin(t, eq(t.id, m.targetId))
    .where(
      and(
        eq(m.profileId, input.profileId),
        eq(m.adProduct, 'SPONSORED_PRODUCTS'),
        sql`${m.date} >= ${input.today}::date - ${PROFILE_BID_LOOKBACK_DAYS}::int`,
        sql`${m.date} < ${input.today}::date`,
        inArray(t.targetType, ['keyword', 'product', 'category']),
      ),
    )
    .groupBy(t.targetType, matchType);
  const result: ProfileBidSuggestions = {};
  for (const row of rows) {
    if (row.clicks < PROFILE_BID_MIN_CLICKS) continue;
    const cpc = new Dec(row.cost)
      .div(row.clicks)
      .toDecimalPlaces(2, Dec.ROUND_HALF_EVEN)
      .toFixed(2);
    if (row.targetType === 'keyword') {
      const match = row.matchType?.toLowerCase();
      if (match === 'broad' || match === 'phrase' || match === 'exact') {
        result.keyword = { ...result.keyword, [match]: cpc };
      }
    } else if (row.targetType === 'product' || row.targetType === 'category') {
      result[row.targetType] = cpc;
    }
  }
  return result;
}
