import { z } from 'zod';
import { campaignSetupItemSchema, setupIssueSchema } from './campaign-setup';
import {
  AD_CHANGE_CHANNELS,
  AD_CHANGE_ENTITY_TYPES,
  AD_CHANGE_FIELDS,
  AD_CHANGE_ORIGINS,
  AD_CHANGE_REJECTIONS,
  AD_CHANGE_STATUSES,
  AD_CHANGE_SUBMISSION_KINDS,
  AD_CHANGE_SUBMISSION_STATUSES,
  adChangeNegativeSchema,
  MAX_AD_CHANGES_PER_REQUEST,
} from './ad-changes';

/**
 * Anfragen und Antworten der API für Änderungen (`docs/tasks/phase-3.md` 3.4, Feature `changes`): Warenkorb,
 * Übermittlungen samt Bulk-Datei, erneut versuchen, verwerfen, Revert, Verlauf. Beträge sind Decimal-Strings,
 * Zeitpunkte ISO 8601 in UTC.
 */

const timestamp = z.iso.datetime();
const changeIds = z.array(z.uuid()).min(1).max(MAX_AD_CHANGES_PER_REQUEST);

// ---------------------------------------------------------------------------
// Änderung und Übermittlung
// ---------------------------------------------------------------------------

export const adChangeSchema = z
  .object({
    id: z.uuid(),
    profileId: z.uuid(),
    accountName: z.string(),
    countryCode: z.string(),
    /** Ad-Typ der Kampagne. */
    adProduct: z.string(),
    status: z.enum(AD_CHANGE_STATUSES),
    origin: z.enum(AD_CHANGE_ORIGINS),
    /** Bei `retry` und `revert`: die ursprüngliche Änderung. */
    originChangeId: z.uuid().nullable(),
    operation: z.enum(['update', 'create']),
    entityType: z.enum(AD_CHANGE_ENTITY_TYPES),
    /** Leer beim Anlegen eines Negatives. */
    entityId: z.uuid().nullable(),
    campaignId: z.uuid(),
    campaignName: z.string().nullable(),
    adGroupId: z.uuid().nullable(),
    adGroupName: z.string().nullable(),
    field: z.enum(AD_CHANGE_FIELDS).nullable(),
    /** Vorher/nachher als Text bzw. Decimal-String; beide leer beim Anlegen. */
    before: z.string().nullable(),
    after: z.string().nullable(),
    currencyCode: z.string().nullable(),
    /** Das neue Negative beim Anlegen. */
    negative: adChangeNegativeSchema.nullable(),
    /** Angaben zur Anzeige eines Targets, Negatives bzw. einer Product Ad; sonst `null`. */
    entity: z
      .object({
        targetType: z.string().nullable(),
        keywordText: z.string().nullable(),
        matchType: z.string().nullable(),
        expression: z.unknown(),
        asin: z.string().nullable(),
        sku: z.string().nullable(),
      })
      .nullable(),
    submissionId: z.uuid().nullable(),
    /** Die von Amazon vergebene ID eines neuen Negatives. */
    amazonEntityId: z.string().nullable(),
    /** Ergebnis bei `failed`: Code und Text von Amazon bzw. von ProfitBash. */
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    resolvedAt: timestamp.nullable(),
    createdBy: z.uuid().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'AdChange' });
export type AdChange = z.infer<typeof adChangeSchema>;

export const adChangeSubmissionSchema = z
  .object({
    id: z.uuid(),
    profileId: z.uuid(),
    accountName: z.string(),
    countryCode: z.string(),
    channel: z.enum(AD_CHANGE_CHANNELS),
    /** `changes`: Änderungen; `setup`: Anlagen eines Setup-Entwurfs (Phase 4, 4.4). */
    kind: z.enum(AD_CHANGE_SUBMISSION_KINDS),
    status: z.enum(AD_CHANGE_SUBMISSION_STATUSES),
    /** Grund, wenn die Übermittlung als Ganzes gescheitert ist bzw. warum sie noch wartet. */
    error: z.string().nullable(),
    createdBy: z.uuid().nullable(),
    createdByName: z.string().nullable(),
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
    /** Änderungen bzw. Anlagen, gesamt und je Status. */
    changes: z.number().int(),
    counts: z.object({
      submitted: z.number().int(),
      applied: z.number().int(),
      failed: z.number().int(),
      dismissed: z.number().int(),
    }),
  })
  .meta({ id: 'AdChangeSubmission' });
export type AdChangeSubmission = z.infer<typeof adChangeSubmissionSchema>;

// ---------------------------------------------------------------------------
// Prüfungen vor dem Übermitteln (Grenzen von Amazon, Warnungen nach F6)
// ---------------------------------------------------------------------------

export const adChangeCheckSchema = z
  .object({
    /** Verstöße gegen Grenzen von Amazon: Diese Änderungen lassen sich nicht übermitteln. */
    violations: z.array(
      z.union([
        z.object({
          changeId: z.uuid(),
          code: z.enum(['belowMinimum', 'aboveMaximum']),
          min: z.string(),
          max: z.string(),
        }),
        z.object({
          changeId: z.uuid(),
          code: z.enum(['tooLong', 'tooManyWords']),
          max: z.number().int(),
        }),
      ]),
    ),
    /** Gebote und Budgets, die sich um mehr als 50 % ändern (Prozent mit Vorzeichen). */
    largeChanges: z.array(z.object({ changeId: z.uuid(), changePercent: z.string() })),
    /** Mehr als 200 Änderungen auf einmal. */
    tooMany: z.object({ count: z.number().int(), limit: z.number().int() }).nullable(),
  })
  .meta({ id: 'AdChangeCheck' });
export type AdChangeCheck = z.infer<typeof adChangeCheckSchema>;

// ---------------------------------------------------------------------------
// Warenkorb
// ---------------------------------------------------------------------------

export const pendingAdChangesResponseSchema = z
  .object({
    changes: z.array(
      adChangeSchema.extend({
        /** Andere Nutzer mit einer offenen Änderung an derselben Stelle (F4). */
        otherUsers: z.array(z.object({ userId: z.uuid(), name: z.string() })),
        /**
         * Vergleichswert der ±50-%-Warnung, wenn es kein „vorher“ gibt: das Standardgebot der Ad Group bei einem
         * Target ohne eigenes Gebot; sonst `null`.
         */
        comparisonBefore: z.string().nullable(),
      }),
    ),
    check: adChangeCheckSchema,
  })
  .meta({ id: 'PendingAdChangesResponse' });
export type PendingAdChangesResponse = z.infer<typeof pendingAdChangesResponseSchema>;

export const stageAdChangesResponseSchema = z
  .object({
    /** Je Eingabe ein Ergebnis, in derselben Reihenfolge. */
    results: z.array(
      z.union([
        z.object({
          outcome: z.enum(['created', 'updated']),
          changeId: z.uuid(),
          otherUsers: z.number().int(),
        }),
        z.object({ outcome: z.enum(['removed', 'unchanged']) }),
        z.object({ outcome: z.literal('rejected'), reason: z.enum(AD_CHANGE_REJECTIONS) }),
      ]),
    ),
    counts: z.object({
      created: z.number().int(),
      updated: z.number().int(),
      removed: z.number().int(),
      unchanged: z.number().int(),
      rejected: z.number().int(),
    }),
  })
  .meta({ id: 'StageAdChangesResponse' });

export const discardAdChangesRequestSchema = z
  .strictObject({
    /** Ohne Angabe: der ganze eigene Warenkorb. */
    changeIds: changeIds.optional(),
  })
  .meta({ id: 'DiscardAdChangesRequest' });

export const discardAdChangesResponseSchema = z
  .object({ discarded: z.number().int() })
  .meta({ id: 'DiscardAdChangesResponse' });

// ---------------------------------------------------------------------------
// Übermitteln
// ---------------------------------------------------------------------------

/** Beim Erzeugen der Bulk-Datei übersprungene Änderungen: Sie gelten nicht als übermittelt (`failed`). */
const bulkFileSkippedSchema = z.array(
  z.object({ changeId: z.uuid(), code: z.string(), message: z.string() }),
);

export const submitAdChangesRequestSchema = z
  .strictObject({
    channel: z.enum(AD_CHANGE_CHANNELS),
    /** Nur die Änderungen dieses Profils bzw. nur die genannten (sonst der ganze Warenkorb). */
    profileId: z.uuid().optional(),
    changeIds: changeIds.optional(),
    /** Warnungen nach F6 gesehen und bestätigt. */
    confirmWarnings: z.boolean().optional(),
  })
  .meta({ id: 'SubmitAdChangesRequest' });

export const submitAdChangesResponseSchema = z
  .discriminatedUnion('status', [
    z.object({
      status: z.literal('submitted'),
      /** Eine Übermittlung je Profil. */
      submissions: z.array(adChangeSubmissionSchema),
      /** Entfallen: Der Wert entspricht inzwischen dem Stand der Entity. */
      dropped: z.number().int(),
      /** Bleiben im Warenkorb, weil sie sich nicht mehr übermitteln lassen. */
      blocked: z.array(z.object({ changeId: z.uuid(), reason: z.enum(AD_CHANGE_REJECTIONS) })),
      bulkFileSkipped: bulkFileSkippedSchema,
    }),
    /** Nichts übermittelt: Die Oberfläche zeigt die Warnungen und sendet mit `confirmWarnings` erneut. */
    z.object({ status: z.literal('needsConfirmation'), check: adChangeCheckSchema }),
    /** Nichts übermittelt: Werte außerhalb der Grenzen von Amazon. */
    z.object({ status: z.literal('limitsExceeded'), check: adChangeCheckSchema }),
  ])
  .meta({ id: 'SubmitAdChangesResponse' });
export type SubmitAdChangesResponse = z.infer<typeof submitAdChangesResponseSchema>;

// ---------------------------------------------------------------------------
// Übermittlungen
// ---------------------------------------------------------------------------

export const adChangeSubmissionsResponseSchema = z
  .object({ submissions: z.array(adChangeSubmissionSchema) })
  .meta({ id: 'AdChangeSubmissionsResponse' });

export const adChangeSubmissionDetailSchema = z
  .object({
    submission: adChangeSubmissionSchema,
    changes: z.array(
      adChangeSchema.extend({
        /** Der letzte erneute Versuch bzw. Revert dieser Änderung. */
        followUp: z
          .object({
            changeId: z.uuid(),
            origin: z.enum(['retry', 'revert']),
            status: z.enum(AD_CHANGE_STATUSES),
            submissionId: z.uuid().nullable(),
          })
          .nullable(),
      }),
    ),
    /** Anlagen eines Setups (Art `setup`, 4.4); leer bei Änderungen. */
    setupItems: z.array(campaignSetupItemSchema),
    /**
     * Ältester Sync bzw. Import der Kampagnen dieser Übermittlung: Portfolio und Enddatum in der Bulk-Datei
     * stammen von diesem Stand (`null`: noch nie).
     */
    entitiesSyncedAt: timestamp.nullable(),
  })
  .meta({ id: 'AdChangeSubmissionDetail' });
export type AdChangeSubmissionDetail = z.infer<typeof adChangeSubmissionDetailSchema>;

export const closeAdChangeSubmissionRequestSchema = z
  .strictObject({
    /** `applied`: in der Werbekonsole hochgeladen; `discarded`: wird nicht hochgeladen. */
    outcome: z.enum(['applied', 'discarded']),
  })
  .meta({ id: 'CloseAdChangeSubmissionRequest' });

export const closeAdChangeSubmissionResponseSchema = z
  .object({ changes: z.number().int() })
  .meta({ id: 'CloseAdChangeSubmissionResponse' });

// ---------------------------------------------------------------------------
// Erneut versuchen, verwerfen, Revert
// ---------------------------------------------------------------------------

export const AD_CHANGE_FOLLOW_UP_SKIP_REASONS = [
  'notFound',
  'notFailed',
  'notApplied',
  'alreadyRetried',
  'alreadyReverted',
  'archiveNotRevertible',
  'noPreviousValue',
  'nothingToChange',
  'superseded',
  'outcomeUnknown',
  'alreadySubmitted',
  ...AD_CHANGE_REJECTIONS,
] as const;

const skippedSchema = z.array(
  z.object({ changeId: z.uuid(), reason: z.enum(AD_CHANGE_FOLLOW_UP_SKIP_REASONS) }),
);

export const retryAdChangesRequestSchema = z
  .strictObject({ changeIds, channel: z.enum(AD_CHANGE_CHANNELS) })
  .meta({ id: 'RetryAdChangesRequest' });

export const retryAdChangesResponseSchema = z
  .object({
    submissions: z.array(adChangeSubmissionSchema),
    skipped: skippedSchema,
    bulkFileSkipped: bulkFileSkippedSchema,
  })
  .meta({ id: 'RetryAdChangesResponse' });

export const dismissAdChangesRequestSchema = z
  .strictObject({ changeIds })
  .meta({ id: 'DismissAdChangesRequest' });

export const dismissAdChangesResponseSchema = z
  .object({ dismissed: z.number().int() })
  .meta({ id: 'DismissAdChangesResponse' });

export const revertAdChangesRequestSchema = z
  .strictObject({
    /** Eine ganze Übermittlung oder einzelne Änderungen (genau eines von beiden). */
    submissionId: z.uuid().optional(),
    changeIds: changeIds.optional(),
    channel: z.enum(AD_CHANGE_CHANNELS),
    /** Nach der Rückfrage (F8): auch zurücksetzen, was sich seit der Übermittlung geändert hat. */
    overwriteChanged: z.boolean().optional(),
  })
  .refine((value) => (value.submissionId === undefined) !== (value.changeIds === undefined), {
    message: 'Genau eines von submissionId und changeIds angeben',
    path: ['changeIds'],
  })
  .meta({ id: 'RevertAdChangesRequest' });

export const revertAdChangesResponseSchema = z
  .discriminatedUnion('status', [
    /** Nichts übermittelt: Der Stand weicht vom Wert nach der Übermittlung ab. */
    z.object({
      status: z.literal('conflict'),
      conflicts: z.array(
        z.object({ changeId: z.uuid(), expected: z.string(), current: z.string().nullable() }),
      ),
      skipped: skippedSchema,
    }),
    z.object({
      status: z.literal('submitted'),
      submissions: z.array(adChangeSubmissionSchema),
      skipped: skippedSchema,
      bulkFileSkipped: bulkFileSkippedSchema,
    }),
  ])
  .meta({ id: 'RevertAdChangesResponse' });
export type RevertAdChangesResponse = z.infer<typeof revertAdChangesResponseSchema>;

// ---------------------------------------------------------------------------
// Offene Änderungen je Entity, Verlauf
// ---------------------------------------------------------------------------

export const openAdChangesResponseSchema = z
  .object({
    changes: z.array(
      z.object({
        id: z.uuid(),
        profileId: z.uuid(),
        /** `pending`: im Warenkorb (eigener oder fremder); `submitted`: übermittelt, noch ohne Ergebnis. */
        status: z.enum(['pending', 'submitted']),
        channel: z.enum(AD_CHANGE_CHANNELS).nullable(),
        submissionId: z.uuid().nullable(),
        operation: z.enum(['update', 'create']),
        entityType: z.enum(AD_CHANGE_ENTITY_TYPES),
        entityId: z.uuid().nullable(),
        campaignId: z.uuid(),
        adGroupId: z.uuid().nullable(),
        field: z.enum(AD_CHANGE_FIELDS).nullable(),
        after: z.string().nullable(),
        /** Das neue Negative beim Anlegen. */
        negative: adChangeNegativeSchema.nullable(),
        mine: z.boolean(),
        userName: z.string().nullable(),
      }),
    ),
    /** Es gibt mehr als 5000 offene Änderungen: Die ältesten fehlen (nach Profil filtern). */
    truncated: z.boolean(),
  })
  .meta({ id: 'OpenAdChangesResponse' });

export const openAdChangesQuerySchema = z
  .object({
    /** Nur die offenen Änderungen dieses Profils. */
    profileId: z.uuid().optional(),
  })
  .meta({ id: 'OpenAdChangesQuery' });

export const MAX_AD_CHANGE_HISTORY = 200;

export const adChangeHistoryRequestSchema = z
  .strictObject({
    /** Verlauf einer Entity (beide Angaben) oder eines Profils; ohne Angabe alle sichtbaren Profile. */
    entityType: z.enum(AD_CHANGE_ENTITY_TYPES).optional(),
    entityId: z.uuid().optional(),
    profileId: z.uuid().optional(),
    limit: z.number().int().min(1).max(MAX_AD_CHANGE_HISTORY).optional(),
  })
  .refine((value) => (value.entityType === undefined) === (value.entityId === undefined), {
    message: 'entityType und entityId nur zusammen',
    path: ['entityId'],
  })
  .meta({ id: 'AdChangeHistoryRequest' });

export const adChangeHistoryResponseSchema = z
  .object({
    /** Übermittelte Änderungen, neueste zuerst. */
    changes: z.array(
      adChangeSchema.extend({
        channel: z.enum(AD_CHANGE_CHANNELS).nullable(),
        createdByName: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'AdChangeHistoryResponse' });

/** Antwort auf das Übermitteln eines Setup-Entwurfs (4.5). */
export const submitCampaignSetupResponseSchema = z
  .discriminatedUnion('status', [
    z.object({
      status: z.literal('submitted'),
      submission: adChangeSubmissionSchema,
      items: z.number().int(),
      unsupported: z.number().int(),
      /** Warnungen und Hinweise der Prüfung (sperren nicht). */
      issues: z.array(setupIssueSchema),
    }),
    /** Die Prüfung hat Fehler gemeldet; nichts wurde übermittelt. */
    z.object({ status: z.literal('rejected'), issues: z.array(setupIssueSchema) }),
  ])
  .meta({ id: 'SubmitCampaignSetupResponse' });
export type SubmitCampaignSetupResponse = z.infer<typeof submitCampaignSetupResponseSchema>;

/** Portfolio angelegt (4.7): die Übermittlung per Bulk-Datei (Seite „Änderungen“). */
export const createPortfolioResponseSchema = z
  .object({ submission: adChangeSubmissionSchema })
  .meta({ id: 'CreatePortfolioResponse' });
export type CreatePortfolioResponse = z.infer<typeof createPortfolioResponseSchema>;
