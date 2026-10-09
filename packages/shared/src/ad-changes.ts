import { z } from 'zod';

/**
 * Änderungen an Amazon-Werbung (`docs/tasks/phase-3.md`): Eine **Änderung** ist ein Feld einer Entity mit Wert vorher
 * und nachher oder das Anlegen eines Negatives. Der **Warenkorb** eines Nutzers sind seine Änderungen im Status
 * `pending`; eine **Übermittlung** bündelt Änderungen eines Profils über einen Weg (API oder Bulk-Datei).
 *
 * Hier stehen nur Form und Wertebereich der Eingaben. Die Grenzen von Amazon je Ad-Typ und Marktplatz (Mindest- und
 * Höchstgebote, Mindestbudget) prüft `@profitbash/amazon-ads` (3.2a), die Warnungen nach F6 die API (3.4).
 */

// ---------------------------------------------------------------------------
// Entities und Felder (F3)
// ---------------------------------------------------------------------------

export const AD_CHANGE_ENTITY_TYPES = [
  'campaign',
  'ad_group',
  'target',
  'product_ad',
  'negative_target',
] as const;
export type AdChangeEntityType = (typeof AD_CHANGE_ENTITY_TYPES)[number];

export const AD_CHANGE_FIELDS = [
  'state',
  'budget',
  'bidding_strategy',
  'placement_top',
  'placement_rest_of_search',
  'placement_product_page',
  'placement_amazon_business',
  'default_bid',
  'bid',
] as const;
export type AdChangeField = (typeof AD_CHANGE_FIELDS)[number];

/** Gebotsanpassung je Platzierung: Feld → Platzierung in `extra.placementBidAdjustments` der Kampagne. */
export const AD_CHANGE_PLACEMENTS = {
  placement_top: 'PLACEMENT_TOP',
  placement_rest_of_search: 'PLACEMENT_REST_OF_SEARCH',
  placement_product_page: 'PLACEMENT_PRODUCT_PAGE',
  placement_amazon_business: 'SITE_AMAZON_BUSINESS',
} as const satisfies Partial<Record<AdChangeField, string>>;
export type AdChangePlacementField = keyof typeof AD_CHANGE_PLACEMENTS;

export function isAdChangePlacementField(field: AdChangeField): field is AdChangePlacementField {
  return field in AD_CHANGE_PLACEMENTS;
}

export const AD_CHANGE_FIELDS_BY_ENTITY: Record<AdChangeEntityType, readonly AdChangeField[]> = {
  campaign: [
    'state',
    'budget',
    'bidding_strategy',
    'placement_top',
    'placement_rest_of_search',
    'placement_product_page',
    'placement_amazon_business',
  ],
  ad_group: ['state', 'default_bid'],
  target: ['state', 'bid'],
  product_ad: ['state'],
  negative_target: ['state'],
};

/** `enum`: fester Wert als Text; `money`: Betrag in der Währung der Entity; `percent`: ganze Prozent ohne Währung. */
export type AdChangeFieldKind = 'enum' | 'money' | 'percent';

export function adChangeFieldKind(field: AdChangeField): AdChangeFieldKind {
  if (field === 'state' || field === 'bidding_strategy') return 'enum';
  return isAdChangePlacementField(field) ? 'percent' : 'money';
}

export const AD_CHANGE_STATES = ['ENABLED', 'PAUSED', 'ARCHIVED'] as const;
/** Ohne `RULE_BASED`: regelbasierte Gebote lassen sich nur in der Werbekonsole einrichten. */
export const AD_CHANGE_BIDDING_STRATEGIES = [
  'SALES_DOWN_ONLY',
  'SALES_UP_AND_DOWN',
  'NONE',
] as const;
export const AD_CHANGE_MAX_PLACEMENT_PERCENT = 900;

const MONEY = /^\d{1,9}(\.\d{1,2})?$/;
const WHOLE_PERCENT = /^(0|[1-9]\d{0,2})$/;

export type AdChangeValueIssue = 'fieldNotAllowed' | 'invalidValue';

/** Prüft Feld und neuen Wert einer Feldänderung; `null`, wenn beides passt. */
export function adChangeValueIssue(
  entityType: AdChangeEntityType,
  field: AdChangeField,
  value: string,
): AdChangeValueIssue | null {
  if (!AD_CHANGE_FIELDS_BY_ENTITY[entityType].includes(field)) return 'fieldNotAllowed';
  let valid: boolean;
  if (field === 'state') {
    // Negatives lassen sich in Phase 3 nur archivieren (F3).
    valid =
      entityType === 'negative_target'
        ? value === 'ARCHIVED'
        : (AD_CHANGE_STATES as readonly string[]).includes(value);
  } else if (field === 'bidding_strategy') {
    valid = (AD_CHANGE_BIDDING_STRATEGIES as readonly string[]).includes(value);
  } else if (isAdChangePlacementField(field)) {
    valid = WHOLE_PERCENT.test(value) && Number(value) <= AD_CHANGE_MAX_PLACEMENT_PERCENT;
  } else {
    valid = MONEY.test(value) && /[1-9]/.test(value);
  }
  return valid ? null : 'invalidValue';
}

// ---------------------------------------------------------------------------
// Negatives anlegen
// ---------------------------------------------------------------------------

export const MAX_NEGATIVE_KEYWORD_LENGTH = 80;
export const NEGATIVE_KEYWORD_MATCH_TYPES = ['EXACT', 'PHRASE'] as const;

/** Ränder weg, Leerraum zusammengefasst, Unicode NFC; die Schreibung bleibt (Amazon vergleicht ohne Groß/Klein). */
export function normalizeNegativeKeywordText(text: string): string {
  return text.normalize('NFC').split(/\s+/u).filter(Boolean).join(' ');
}

const negativeKeywordSchema = z.strictObject({
  type: z.literal('keyword'),
  keywordText: z
    .string()
    .transform(normalizeNegativeKeywordText)
    .pipe(z.string().min(1).max(MAX_NEGATIVE_KEYWORD_LENGTH)),
  matchType: z.enum(NEGATIVE_KEYWORD_MATCH_TYPES),
});

const negativeProductSchema = z.strictObject({
  type: z.literal('product'),
  asin: z
    .string()
    .transform((asin) => asin.trim().toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9]{10}$/)),
});

export const adChangeNegativeSchema = z.discriminatedUnion('type', [
  negativeKeywordSchema,
  negativeProductSchema,
]);
export type AdChangeNegative = z.infer<typeof adChangeNegativeSchema>;

// ---------------------------------------------------------------------------
// Eingaben für den Warenkorb
// ---------------------------------------------------------------------------

/**
 * Feldänderung. Den Wert „vorher“ liest der Server aus der Entity; die Anfrage nennt ihn nicht (strikt: unbekannte
 * Felder werden abgelehnt).
 */
const adChangeUpdateInputSchema = z
  .strictObject({
    operation: z.literal('update'),
    entityType: z.enum(AD_CHANGE_ENTITY_TYPES),
    /** Interne ID der Entity. */
    entityId: z.uuid(),
    field: z.enum(AD_CHANGE_FIELDS),
    /** Neuer Wert: Zustand bzw. Strategie, Betrag als Decimal-String oder ganze Prozent. */
    value: z.string(),
  })
  .superRefine((input, ctx) => {
    const issue = adChangeValueIssue(input.entityType, input.field, input.value);
    if (issue === 'fieldNotAllowed') {
      ctx.addIssue({ code: 'custom', path: ['field'], message: 'Feld passt nicht zur Entity' });
    } else if (issue === 'invalidValue') {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Ungültiger Wert für das Feld' });
    }
  });

/** Neues Negative in einer Kampagne (`adGroupId: null`) oder Ad Group. */
const adChangeCreateNegativeInputSchema = z.strictObject({
  operation: z.literal('create_negative'),
  campaignId: z.uuid(),
  adGroupId: z.uuid().nullable(),
  negative: adChangeNegativeSchema,
  /** Der Begriff enthält einen geschützten Begriff des Clients: nur mit dieser Bestätigung (3.8, sonst `protectedTerm`). */
  confirmProtected: z.boolean().optional(),
});

/** Beträge, die sich relativ ändern lassen (Bulk-Dialoge, 3.5). */
export const AD_CHANGE_ADJUSTABLE_FIELDS = ['budget', 'default_bid', 'bid'] as const;
export const AD_CHANGE_ADJUST_MODES = ['percent', 'amount'] as const;
export type AdChangeAdjustMode = (typeof AD_CHANGE_ADJUST_MODES)[number];

/** Ohne führende Nullen: Sonst ließe sich die Größe einer Prozentangabe nicht an den Stellen ablesen. */
const SIGNED_AMOUNT = /^-?(0|[1-9]\d{0,8})(\.\d{1,2})?$/;

/** Prüft die Angabe einer Anpassung: Decimal-String mit Vorzeichen, nicht 0, Prozent über −100. */
export function adChangeAdjustmentIssue(
  mode: AdChangeAdjustMode,
  value: string,
): 'invalidValue' | null {
  if (!SIGNED_AMOUNT.test(value) || !/[1-9]/.test(value)) return 'invalidValue';
  // −100 % oder weniger ergäbe 0 oder einen negativen Betrag.
  return mode === 'percent' && /^-\d{3,}/.test(value) ? 'invalidValue' : null;
}

/**
 * Betrag relativ ändern: um Prozent oder um einen Betrag in der Währung der Entity, jeweils mit Vorzeichen. Der
 * Server rechnet auf den Stand der Entity (ein Target ohne eigenes Gebot: Standardgebot der Ad Group), rundet
 * kaufmännisch auf zwei Nachkommastellen und merkt das Ergebnis wie eine Feldänderung vor.
 */
const adChangeAdjustInputSchema = z
  .strictObject({
    operation: z.literal('adjust'),
    entityType: z.enum(AD_CHANGE_ENTITY_TYPES),
    entityId: z.uuid(),
    field: z.enum(AD_CHANGE_ADJUSTABLE_FIELDS),
    mode: z.enum(AD_CHANGE_ADJUST_MODES),
    /** Prozent (z. B. `-10`, `12.5`) bzw. Betrag (z. B. `0.05`, `-0.10`). */
    value: z.string(),
  })
  .superRefine((input, ctx) => {
    if (!AD_CHANGE_FIELDS_BY_ENTITY[input.entityType].includes(input.field)) {
      ctx.addIssue({ code: 'custom', path: ['field'], message: 'Feld passt nicht zur Entity' });
    }
    if (adChangeAdjustmentIssue(input.mode, input.value) !== null) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Ungültige Anpassung' });
    }
  });

export const adChangeInputSchema = z
  .discriminatedUnion('operation', [
    adChangeUpdateInputSchema,
    adChangeAdjustInputSchema,
    adChangeCreateNegativeInputSchema,
  ])
  .meta({ id: 'AdChangeInput' });
export type AdChangeInput = z.infer<typeof adChangeInputSchema>;
export type AdChangeUpdateInput = Extract<AdChangeInput, { operation: 'update' }>;
export type AdChangeAdjustInput = Extract<AdChangeInput, { operation: 'adjust' }>;
export type AdChangeCreateNegativeInput = Extract<AdChangeInput, { operation: 'create_negative' }>;

/** Woher eine Änderung stammt. `revert` und `retry` setzt nur der Server (3.3). */
export const AD_CHANGE_ORIGINS = ['explorer', 'search_terms', 'revert', 'retry'] as const;
export type AdChangeOrigin = (typeof AD_CHANGE_ORIGINS)[number];
export const AD_CHANGE_USER_ORIGINS = ['explorer', 'search_terms'] as const;

/** Bulk-Dialoge schicken viele Änderungen auf einmal, im Body, nie im Query-String. */
export const MAX_AD_CHANGES_PER_REQUEST = 5000;

export const stageAdChangesRequestSchema = z
  .strictObject({
    origin: z.enum(AD_CHANGE_USER_ORIGINS),
    changes: z.array(adChangeInputSchema).min(1).max(MAX_AD_CHANGES_PER_REQUEST),
  })
  .meta({ id: 'StageAdChangesRequest' });

// ---------------------------------------------------------------------------
// Status und Wege
// ---------------------------------------------------------------------------

/**
 * `pending` (im Warenkorb) → `submitted` (in einer Übermittlung) → `applied` | `failed`; `dismissed` = fehlgeschlagen
 * und vom Nutzer verworfen (3.3).
 */
export const AD_CHANGE_STATUSES = [
  'pending',
  'submitted',
  'applied',
  'failed',
  'dismissed',
] as const;
export type AdChangeStatus = (typeof AD_CHANGE_STATUSES)[number];

/** F2: über die Ads-API oder als Bulk-Datei zum Hochladen in der Werbekonsole. */
export const AD_CHANGE_CHANNELS = ['api', 'bulk_file'] as const;
export type AdChangeChannel = (typeof AD_CHANGE_CHANNELS)[number];

/**
 * `pending`: wartet auf den Job (`api`) bzw. auf die Bestätigung durch den nächsten Datei-Import (`bulk_file`);
 * `finished`: jede Änderung hat ein Ergebnis; `failed`: die Übermittlung als Ganzes ist gescheitert.
 */
export const AD_CHANGE_SUBMISSION_STATUSES = ['pending', 'running', 'finished', 'failed'] as const;
export type AdChangeSubmissionStatus = (typeof AD_CHANGE_SUBMISSION_STATUSES)[number];
/** Art einer Übermittlung: Änderungen (Phase 3) oder Anlagen eines Setup-Entwurfs (Phase 4, 4.4). */
export const AD_CHANGE_SUBMISSION_KINDS = ['changes', 'setup'] as const;
export type AdChangeSubmissionKind = (typeof AD_CHANGE_SUBMISSION_KINDS)[number];

/** Warum eine Änderung nicht in den Warenkorb kam. */
export const AD_CHANGE_REJECTIONS = [
  /** Entity bzw. Kampagne oder Ad Group nicht gefunden oder nicht sichtbar. */
  'notFound',
  /** Amazon liefert die Entity nicht mehr. */
  'entityRemoved',
  /** Archiviert ist endgültig. */
  'entityArchived',
  /** Budget ist kein Tagesbudget (Laufzeitbudgets ändert Phase 3 nicht). */
  'budgetNotDaily',
  /** Gebotsstrategie und Platzierungen gibt es in Phase 3 nur für Sponsored Products. */
  'adProductNotSupported',
  /** Das Negative gibt es dort schon (nicht archiviert). */
  'alreadyExists',
  /** Das Negative enthält einen geschützten Begriff des Clients und die Anfrage bestätigt das nicht (3.8). */
  'protectedTerm',
  /** Anpassen (±Prozent, ±Betrag): Die Entity hat keinen Wert, auf den sich rechnen ließe. */
  'noCurrentValue',
  /** Anpassen: Das Ergebnis ist kein Betrag über 0 (bzw. zu groß). */
  'resultOutOfRange',
] as const;
export type AdChangeRejection = (typeof AD_CHANGE_REJECTIONS)[number];
