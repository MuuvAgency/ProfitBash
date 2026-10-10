import {
  todayInTimezone,
  type CampaignSetupItemPayload,
  type CreatePortfolioRequest,
  type PortfolioBudget,
} from '@profitbash/shared';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { canSeeProfile, visibleProfilesScope } from './access';
import { loadAdChangeSubmissionSummaries, type AdChangeSubmissionSummary } from './ad-changes';
import { recordAuditEvent } from './audit';
import type { Db } from './client';
import {
  adChangeSubmissions,
  amazonAdsCampaigns,
  amazonAdsPortfolios,
  amazonAdsProfiles,
  campaignSetupItems,
} from './schema';

/**
 * Portfolios (`docs/tasks/phase-4.md` 4.7, F9): die Portfolios eines Profils lesen und neue anlegen. Ein neues
 * Portfolio ist eine eigene Übermittlung der Art `portfolio` mit einer Zeile `portfolio` in `campaign_setup_items`
 * (ohne Entwurf), nur per Bulk-Datei (Blatt „Portfolios“). Seine echte ID kennt erst der nächste Bulk-Import
 * (Zuordnung über den Namen, `confirmCampaignSetupItems`); bis dahin lassen sich ihm keine Kampagnen zuordnen.
 * Zugriffe über den Access-Layer (ADR 002); das Recht (`write` bzw. `view` im Feature `tools`) prüft die API.
 */

export type PortfolioErrorCode = 'NOT_FOUND' | 'NAME_TAKEN' | 'START_IN_PAST';

export class PortfolioError extends Error {
  constructor(
    public readonly code: PortfolioErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PortfolioError';
  }
}

interface Actor {
  userId: string;
  orgId: string;
}

const pf = amazonAdsPortfolios;
const i = campaignSetupItems;
const s = adChangeSubmissions;

/** Offene bzw. angelegte, aber noch nicht zugeordnete Portfolio-Zeilen eines Profils. */
const pendingItems = (profileId: string) =>
  and(
    eq(i.profileId, profileId),
    eq(i.entityType, 'portfolio'),
    sql`(${i.status} = 'submitted' or (${i.status} = 'applied' and ${i.amazonEntityId} is null))`,
  );

export interface ProfilePortfolios {
  portfolios: {
    id: string;
    amazonPortfolioId: string;
    name: string | null;
    state: string | null;
    budgetAmount: string | null;
    budgetCurrencyCode: string | null;
    budgetPolicy: string | null;
    budgetStartDate: string | null;
    budgetEndDate: string | null;
    campaigns: number;
  }[];
  pending: {
    itemId: string;
    submissionId: string;
    name: string;
    status: 'submitted' | 'applied';
    budget: PortfolioBudget | null;
    createdAt: Date;
  }[];
}

/**
 * Portfolios eines sichtbaren Profils (nicht entfernte, nach Name) mit der Zahl ihrer Kampagnen, dazu Portfolios,
 * die angelegt, aber vom Import noch nicht bestätigt sind. `NOT_FOUND` für unsichtbare Profile, `null` für
 * Nicht-Mitglieder.
 */
export async function listProfilePortfolios(
  db: Db,
  input: Actor & { profileId: string },
): Promise<ProfilePortfolios | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  if (!(await canSeeProfile(db, input))) throw notFound();
  const c = amazonAdsCampaigns;
  const portfolios = await db
    .select({
      id: pf.id,
      amazonPortfolioId: pf.amazonPortfolioId,
      name: pf.name,
      state: pf.state,
      budgetAmount: pf.budgetAmount,
      budgetCurrencyCode: pf.budgetCurrencyCode,
      budgetPolicy: pf.budgetPolicy,
      budgetStartDate: pf.budgetStartDate,
      budgetEndDate: pf.budgetEndDate,
    })
    .from(pf)
    .where(and(eq(pf.profileId, input.profileId), isNull(pf.removedAt)))
    .orderBy(asc(sql`lower(${pf.name})`), asc(pf.amazonPortfolioId));
  const counts = await db
    .select({ portfolioId: c.portfolioId, campaigns: sql<number>`count(*)::int` })
    .from(c)
    .where(and(eq(c.profileId, input.profileId), isNull(c.removedAt)))
    .groupBy(c.portfolioId);
  const campaignsOf = new Map(counts.map((row) => [row.portfolioId, row.campaigns]));
  const pending = await db
    .select({
      itemId: i.id,
      submissionId: i.submissionId,
      payload: i.payload,
      status: i.status,
      createdAt: i.createdAt,
    })
    .from(i)
    .where(pendingItems(input.profileId))
    .orderBy(desc(i.createdAt));
  return {
    portfolios: portfolios.map((row) => ({ ...row, campaigns: campaignsOf.get(row.id) ?? 0 })),
    pending: pending.flatMap((row) =>
      row.payload.entity === 'portfolio'
        ? [
            {
              itemId: row.itemId,
              submissionId: row.submissionId,
              name: row.payload.name,
              status: row.status as 'submitted' | 'applied',
              budget: row.payload.budget,
              createdAt: row.createdAt,
            },
          ]
        : [],
    ),
  };
}

const notFound = () => new PortfolioError('NOT_FOUND', 'Profil nicht gefunden.');

/**
 * Legt ein Portfolio an: eine Übermittlung der Art `portfolio` per Bulk-Datei mit einer Zeile; Budget in der
 * Währung des Profils, frühestens ab heute in der Zeitzone des Profils (`START_IN_PAST`). Der Name darf im Profil
 * weder bestehen noch in einer noch nicht hochgeladenen Datei stehen (ohne Groß/Klein, `NAME_TAKEN`). Audit `ad_change_submission.create` mit `kind: 'portfolio'`. `NOT_FOUND` für unsichtbare Profile,
 * `null` für Nicht-Mitglieder.
 */
export async function createPortfolioRequest(
  db: Db,
  input: Actor & { request: CreatePortfolioRequest; now?: Date },
): Promise<{ submission: AdChangeSubmissionSummary } | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const { request } = input;
  return db.transaction(async (tx) => {
    const [profile] = await tx
      .select({
        id: amazonAdsProfiles.id,
        currencyCode: amazonAdsProfiles.currencyCode,
        timezone: amazonAdsProfiles.timezone,
      })
      .from(amazonAdsProfiles)
      .where(
        and(eq(amazonAdsProfiles.id, request.profileId), inArray(amazonAdsProfiles.id, scope.ids)),
      )
      .for('share');
    if (!profile) throw notFound();
    // Ein Budget, das schon begonnen hätte, nimmt Amazon nicht an (wie das Startdatum von Kampagnen).
    const today = todayInTimezone(profile.timezone, input.now ?? new Date());
    if (request.budget !== null && request.budget.startDate < today) {
      throw new PortfolioError('START_IN_PAST', 'Das Budget darf frühestens heute beginnen.');
    }
    // Gleichzeitige Anlagen im Profil sehen einander (Name).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`portfolio:${profile.id}`}))`);
    // Groß/Klein beidseitig in Postgres vergleichen (gleiche Regeln für alle Schriften).
    const [existing] = await tx
      .select({ id: pf.id })
      .from(pf)
      .where(
        and(
          eq(pf.profileId, profile.id),
          isNull(pf.removedAt),
          sql`lower(${pf.name}) = lower(${request.name})`,
        ),
      )
      .limit(1);
    // Nur Portfolios, deren Datei noch nicht hochgeladen ist, sperren den Namen. „Hochgeladen“ ohne Bestätigung
    // durch den Import kann ein gescheiterter Upload sein; dann soll derselbe Name neu angelegt werden können.
    const [pending] = await tx
      .select({ id: i.id })
      .from(i)
      .where(
        and(
          eq(i.profileId, profile.id),
          eq(i.entityType, 'portfolio'),
          eq(i.status, 'submitted'),
          sql`lower(${i.campaignRef}) = lower(${request.name})`,
        ),
      )
      .limit(1);
    if (existing || pending) {
      throw new PortfolioError(
        'NAME_TAKEN',
        'Ein Portfolio mit diesem Namen gibt es im Profil schon oder es wird gerade angelegt.',
      );
    }

    const [submission] = await tx
      .insert(s)
      .values({
        organizationId: input.orgId,
        profileId: profile.id,
        channel: 'bulk_file',
        kind: 'portfolio',
        createdBy: input.userId,
      })
      .returning({ id: s.id });
    const payload: CampaignSetupItemPayload = {
      entity: 'portfolio',
      name: request.name,
      budget:
        request.budget === null ? null : { ...request.budget, currencyCode: profile.currencyCode },
    };
    await tx.insert(i).values({
      organizationId: input.orgId,
      profileId: profile.id,
      submissionId: submission!.id,
      draftId: null,
      position: 0,
      entityType: 'portfolio',
      campaignRef: request.name,
      adGroupRef: null,
      payload,
    });
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'ad_change_submission.create',
      target: {
        type: 'ad_change_submission',
        id: submission!.id,
        profileId: profile.id,
        channel: 'bulk_file',
        kind: 'portfolio',
        name: request.name,
        items: 1,
      },
    });
    const [summary] = await loadAdChangeSubmissionSummaries(tx, eq(s.id, submission!.id));
    return { submission: summary! };
  });
}
