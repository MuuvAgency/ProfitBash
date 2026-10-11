import { z } from 'zod';

/**
 * Läufe und Vorschläge der Automatik (`docs/tasks/phase-5.md` 5.7, 5.8). Ein **Lauf** rechnet für ein Profil auf dem
 * Datenstand einer Datei; ein **Vorschlag** ist eine gewünschte Änderung mit Herkunft und Begründung.
 */

export const AUTOMATION_RUN_MODES = ['shadow', 'cart'] as const;

export const automationRunSchema = z
  .object({
    id: z.uuid(),
    profileId: z.uuid(),
    accountName: z.string(),
    mode: z.enum(AUTOMATION_RUN_MODES),
    /** Datenstand: Zeitraum der Datei und Zeitpunkt ihres Uploads. */
    periodStart: z.string(),
    periodEnd: z.string(),
    metricsImportedAt: z.string(),
    /** `targets`, `campaigns`, `proposals`, `staged`, `dismissed` und je Grund ohne Vorschlag. */
    counts: z.record(z.string(), z.number()),
    /** `olderPeriod`, `responsibleMissing`. */
    warnings: z.array(z.string()),
    createdAt: z.string(),
  })
  .meta({ id: 'AutomationRun' });
export type AutomationRun = z.infer<typeof automationRunSchema>;

export const automationRunsResponseSchema = z
  .object({ runs: z.array(automationRunSchema) })
  .meta({ id: 'AutomationRunsResponse' });
export type AutomationRunsResponse = z.infer<typeof automationRunsResponseSchema>;

/** Filter der Vorschlagsliste. `dismissed` auch, wenn die Änderung im Warenkorb gelöscht wurde. */
export const AUTOMATION_PROPOSAL_FILTERS = ['open', 'staged', 'dismissed'] as const;
export type AutomationProposalFilter = (typeof AUTOMATION_PROPOSAL_FILTERS)[number];

export const automationProposalsQuerySchema = z.object({
  status: z.enum(AUTOMATION_PROPOSAL_FILTERS).default('open'),
});

export const automationProposalSchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    profileId: z.uuid(),
    accountName: z.string(),
    entityType: z.enum(['target', 'campaign']),
    entityId: z.uuid(),
    campaignName: z.string().nullable(),
    adGroupName: z.string().nullable(),
    /** Angaben zur Anzeige eines Targets; `null` bei Kampagnen. */
    target: z.union([
      z.object({
        targetType: z.string().nullable(),
        keywordText: z.string().nullable(),
        matchType: z.string().nullable(),
        expression: z.unknown(),
      }),
      z.null(),
    ]),
    field: z.enum(['bid', 'budget', 'state']),
    /** Zustand (`state`) bzw. Decimal-String in `currencyCode`. */
    before: z.string().nullable(),
    after: z.string(),
    currencyCode: z.string().nullable(),
    source: z.enum(['rule', 'optimizer', 'budget_cap']),
    ruleName: z.string().nullable(),
    /** Leitplanken, die den Vorschlag begrenzt haben. */
    limitedBy: z.array(z.string()),
    /** Kennzahlen des Zeitraums (`impressions`, `clicks`, `orders`, `spend`, `sales`), Ziel, gewünschter Wert. */
    detail: z.record(z.string(), z.unknown()),
    status: z.enum(AUTOMATION_PROPOSAL_FILTERS),
    createdAt: z.string(),
  })
  .meta({ id: 'AutomationProposal' });
export type AutomationProposal = z.infer<typeof automationProposalSchema>;

export const automationProposalsResponseSchema = z
  .object({
    /** Neueste zuerst, höchstens 500. */
    proposals: z.array(automationProposalSchema),
    total: z.int(),
  })
  .meta({ id: 'AutomationProposalsResponse' });
export type AutomationProposalsResponse = z.infer<typeof automationProposalsResponseSchema>;

export const MAX_AUTOMATION_PROPOSAL_IDS = 500;

/** Viele IDs im Body, nie im Query-String. */
export const automationProposalIdsRequestSchema = z
  .strictObject({ ids: z.array(z.uuid()).min(1).max(MAX_AUTOMATION_PROPOSAL_IDS) })
  .meta({ id: 'AutomationProposalIdsRequest' });

export const automationProposalActionResponseSchema = z
  .object({
    changed: z.int(),
    /** Nicht (mehr) offen, nicht sichtbar oder an der Stelle liegt schon eine eigene Änderung. */
    skipped: z.int(),
  })
  .meta({ id: 'AutomationProposalActionResponse' });

// ---------------------------------------------------------------------------
// Graduation- und Preset-Vorschläge (5.11b)
// ---------------------------------------------------------------------------

export const STRUCTURE_PROPOSAL_KINDS = ['graduation', 'presetSwitch'] as const;
export const STRUCTURE_PROPOSAL_FILTERS = ['open', 'dismissed'] as const;
export type StructureProposalFilter = (typeof STRUCTURE_PROPOSAL_FILTERS)[number];

export const structureProposalSchema = z
  .object({
    id: z.uuid(),
    profileId: z.uuid(),
    accountName: z.string(),
    currencyCode: z.string(),
    kind: z.enum(STRUCTURE_PROPOSAL_KINDS),
    /** `graduation`: Suchbegriff in Vergleichsform; `presetSwitch`: ID der Produktgruppe. */
    subject: z.string(),
    /** `graduation`: Baustein der Quelle; `presetSwitch`: Ziel-Preset. */
    key: z.string(),
    /**
     * `graduation`: `searchTerm`, `fromBlock`, `toBlocks`, `clicks`, `orders`, `spend`, `sales`, `acos`,
     * `periodStart`, `periodEnd`. `presetSwitch`: `productGroupName`, `from`, `to`, `orders`, `spend`, `sales`,
     * `acos`, `goalAcos`.
     */
    detail: z.record(z.string(), z.unknown()),
    firstSeenAt: z.string(),
    dismissedAt: z.string().nullable(),
  })
  .meta({ id: 'StructureProposal' });
export type StructureProposal = z.infer<typeof structureProposalSchema>;

export const structureProposalsResponseSchema = z
  .object({
    /** Neueste zuerst, höchstens 500. */
    proposals: z.array(structureProposalSchema),
    total: z.int(),
  })
  .meta({ id: 'StructureProposalsResponse' });
export type StructureProposalsResponse = z.infer<typeof structureProposalsResponseSchema>;
