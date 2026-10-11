import { suggestBlockFromName } from '@profitbash/engine/naming';
import type { CatalogAdProduct, PlannedCampaign } from '@profitbash/shared';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { canSeeProfile } from './access';
import { recordAuditEvent } from './audit';
import type { Db } from './client';
import {
  amazonAdsCampaigns,
  campaignBlocks,
  campaignSetupDrafts,
  campaignSetupItems,
} from './schema';
import { loadStructureCatalog } from './structure-catalog';

/**
 * Zuordnung Kampagne → Baustein des Struktur-Katalogs (`phase-5.md` 5.11a): Kampagnen aus einem Setup tragen den
 * Baustein ihres Entwurfs, sobald ihre Amazon-ID bekannt ist; für Bestand schlägt der Name einen Baustein vor
 * (`suggestBlockFromName`), der erst nach Bestätigung von Hand zählt (`campaign_blocks`, geht dem Setup vor).
 * Sichtbarkeit am Profil (ADR 002); das Recht `write` prüft die API (Feature `tools`).
 */

export const MAX_CAMPAIGN_BLOCK_ROWS = 5000;

export type CampaignBlockErrorCode = 'UNKNOWN_CAMPAIGN' | 'UNKNOWN_BLOCK';

export class CampaignBlockError extends Error {
  constructor(
    public readonly code: CampaignBlockErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CampaignBlockError';
  }
}

const AD_PRODUCT: Record<string, CatalogAdProduct> = {
  SPONSORED_PRODUCTS: 'SP',
  SPONSORED_BRANDS: 'SB',
  SPONSORED_DISPLAY: 'SD',
};

type Reader = Pick<Db, 'select'>;

/** Baustein je Amazon-Kampagnen-ID aus übermittelten Setups, deren Kampagne angelegt und zugeordnet ist. */
async function setupBlocks(db: Reader, profileId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({
      amazonCampaignId: campaignSetupItems.amazonEntityId,
      name: campaignSetupItems.campaignRef,
      campaigns: campaignSetupDrafts.campaigns,
    })
    .from(campaignSetupItems)
    .innerJoin(campaignSetupDrafts, eq(campaignSetupDrafts.id, campaignSetupItems.draftId))
    .where(
      and(
        eq(campaignSetupItems.profileId, profileId),
        eq(campaignSetupItems.entityType, 'campaign'),
        isNotNull(campaignSetupItems.amazonEntityId),
      ),
    )
    .orderBy(asc(campaignSetupItems.createdAt));
  const blocks = new Map<string, string>();
  for (const row of rows) {
    const planned = (row.campaigns as PlannedCampaign[]).find((c) => c.name === row.name);
    if (planned) blocks.set(row.amazonCampaignId!, planned.block);
  }
  return blocks;
}

/**
 * Baustein je Amazon-Kampagnen-ID eines Profils ohne Rechteprüfung (für den Lauf, 5.11b): von Hand vor Setup, nur
 * Bausteine, die es im Katalog noch gibt.
 */
export async function loadCampaignBlocks(
  db: Reader,
  orgId: string,
  profileId: string,
): Promise<Map<string, string>> {
  const { catalog } = await loadStructureCatalog(db, orgId);
  const known = new Set(catalog.blocks.map((block) => block.key));
  const blocks = await setupBlocks(db, profileId);
  const manual = await db
    .select({
      amazonCampaignId: amazonAdsCampaigns.amazonCampaignId,
      blockKey: campaignBlocks.blockKey,
    })
    .from(campaignBlocks)
    .innerJoin(amazonAdsCampaigns, eq(amazonAdsCampaigns.id, campaignBlocks.campaignId))
    .where(and(eq(campaignBlocks.profileId, profileId), eq(campaignBlocks.organizationId, orgId)));
  for (const row of manual) blocks.set(row.amazonCampaignId, row.blockKey);
  for (const [id, key] of blocks) if (!known.has(key)) blocks.delete(id);
  return blocks;
}

export interface CampaignBlockRow {
  campaignId: string;
  amazonCampaignId: string;
  name: string | null;
  adProduct: CatalogAdProduct;
  state: string | null;
  /** Geltender Baustein; `null`, solange nichts bestätigt ist. */
  blockKey: string | null;
  source: 'manual' | 'setup' | null;
  /** Vorschlag aus dem Namen. */
  suggestedBlockKey: string | null;
}

type AccessInput = { userId: string; orgId: string; profileId: string };

/**
 * Nicht archivierte Kampagnen eines sichtbaren Profils mit Baustein und Vorschlag, nach Name (höchstens
 * `MAX_CAMPAIGN_BLOCK_ROWS`, sonst `truncated`). `null`, wenn der Nutzer das Profil nicht sieht.
 */
export async function listCampaignBlocks(
  db: Db,
  input: AccessInput,
): Promise<{ campaigns: CampaignBlockRow[]; truncated: boolean } | null> {
  const rows = await visibleCampaigns(db, input);
  if (rows === null) return null;
  const { catalog } = await loadStructureCatalog(db, input.orgId);
  const known = new Set(catalog.blocks.map((block) => block.key));
  const fromSetup = await setupBlocks(db, input.profileId);
  const campaigns = rows.slice(0, MAX_CAMPAIGN_BLOCK_ROWS).flatMap((row): CampaignBlockRow[] => {
    const adProduct = AD_PRODUCT[row.adProduct];
    if (!adProduct) return [];
    const setup = fromSetup.get(row.amazonCampaignId);
    const [blockKey, source] =
      row.manual && known.has(row.manual)
        ? ([row.manual, 'manual'] as const)
        : setup && known.has(setup)
          ? ([setup, 'setup'] as const)
          : ([null, null] as const);
    return [
      {
        campaignId: row.campaignId,
        amazonCampaignId: row.amazonCampaignId,
        name: row.name,
        adProduct,
        state: row.state,
        blockKey,
        source,
        suggestedBlockKey: suggestBlockFromName(row.name, adProduct, catalog.blocks),
      },
    ];
  });
  return { campaigns, truncated: rows.length > MAX_CAMPAIGN_BLOCK_ROWS };
}

async function visibleCampaigns(db: Db, input: AccessInput) {
  if (!(await canSeeProfile(db, input))) return null;
  return db
    .select({
      campaignId: amazonAdsCampaigns.id,
      amazonCampaignId: amazonAdsCampaigns.amazonCampaignId,
      name: amazonAdsCampaigns.name,
      adProduct: amazonAdsCampaigns.adProduct,
      state: amazonAdsCampaigns.state,
      manual: campaignBlocks.blockKey,
    })
    .from(amazonAdsCampaigns)
    .leftJoin(campaignBlocks, eq(campaignBlocks.campaignId, amazonAdsCampaigns.id))
    .where(
      and(
        eq(amazonAdsCampaigns.profileId, input.profileId),
        sql`${amazonAdsCampaigns.state} is distinct from 'ARCHIVED'`,
      ),
    )
    .orderBy(asc(sql`lower(${amazonAdsCampaigns.name})`), asc(amazonAdsCampaigns.id))
    .limit(MAX_CAMPAIGN_BLOCK_ROWS + 1);
}

/**
 * Bestätigt (`blockKey`) oder löst (`null`) den Baustein von Kampagnen eines sichtbaren Profils. Der Baustein muss
 * im Katalog stehen und zum Anzeigentyp der Kampagne passen (`UNKNOWN_BLOCK`), die Kampagne zum Profil gehören
 * (`UNKNOWN_CAMPAIGN`). Audit `campaign_blocks.update` mit vorher/nachher, nur bei einer Änderung. `null`, wenn der
 * Nutzer das Profil nicht sieht.
 */
export async function setCampaignBlocks(
  db: Db,
  input: AccessInput & { assignments: { campaignId: string; blockKey: string | null }[] },
): Promise<{ changed: number } | null> {
  const rows = await visibleCampaigns(db, input);
  if (rows === null) return null;
  const { catalog } = await loadStructureCatalog(db, input.orgId);
  const blocks = new Map(catalog.blocks.map((block) => [block.key, block.adProduct]));
  const campaigns = new Map(rows.map((row) => [row.campaignId, row]));
  const changes: { campaignId: string; before: string | null; after: string | null }[] = [];
  for (const { campaignId, blockKey } of input.assignments) {
    const campaign = campaigns.get(campaignId);
    if (!campaign) {
      throw new CampaignBlockError('UNKNOWN_CAMPAIGN', 'Kampagne nicht im Profil gefunden.');
    }
    if (blockKey !== null && blocks.get(blockKey) !== AD_PRODUCT[campaign.adProduct]) {
      throw new CampaignBlockError(
        'UNKNOWN_BLOCK',
        'Diesen Baustein gibt es für den Anzeigentyp der Kampagne nicht.',
      );
    }
    if (campaign.manual !== blockKey) {
      changes.push({ campaignId, before: campaign.manual, after: blockKey });
    }
  }
  if (changes.length === 0) return { changed: 0 };
  await db.transaction(async (tx) => {
    const removed = changes.filter((change) => change.after === null).map((c) => c.campaignId);
    if (removed.length > 0) {
      await tx.delete(campaignBlocks).where(inArray(campaignBlocks.campaignId, removed));
    }
    const set = changes.filter((change) => change.after !== null);
    if (set.length > 0) {
      await tx
        .insert(campaignBlocks)
        .values(
          set.map((change) => ({
            campaignId: change.campaignId,
            organizationId: input.orgId,
            profileId: input.profileId,
            blockKey: change.after!,
            updatedBy: input.userId,
          })),
        )
        .onConflictDoUpdate({
          target: campaignBlocks.campaignId,
          set: {
            blockKey: sql`excluded.block_key`,
            updatedBy: input.userId,
            updatedAt: new Date(),
          },
        });
    }
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'campaign_blocks.update',
      target: { type: 'profile', id: input.profileId, changes },
    });
  });
  return { changed: changes.length };
}
