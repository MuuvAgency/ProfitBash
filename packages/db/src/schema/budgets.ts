import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { amazonAdsProfiles } from './app';
import { users } from './auth';
import { createdAt, id, organizationId, updatedAt } from './columns';

/**
 * Budget-Caps (`phase-5.md` 5.9a, F5): Betrag je Monat in der Währung des Profils, für das ganze Profil oder eine
 * Auswahl. Der Cap gilt jeden Monat; `month_amounts` (`YYYY-MM` → Betrag) setzt einzelne Monate abweichend.
 * `scope_ids` ohne Fremdschlüssel: Ein gelöschtes Tag fällt aus dem Umfang. Zugriffe nur über `budget-caps.ts`.
 */
export const budgetCaps = pgTable(
  'budget_caps',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: uuid('profile_id').notNull(),
    /** `BUDGET_CAP_SCOPES`: `profile` | `portfolios` | `tags`. */
    scopeType: text('scope_type').notNull(),
    /** Interne IDs der Portfolios bzw. Tags. */
    scopeIds: jsonb('scope_ids').$type<string[]>().notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    monthAmounts: jsonb('month_amounts').$type<Record<string, string>>().notNull(),
    /** Warnschwellen in Prozent des Caps. */
    warnPercents: jsonb('warn_percents').$type<number[]>().notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'budget_caps_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }).onDelete('cascade'),
    check('budget_caps_scope_type_ck', sql`${t.scopeType} in ('profile', 'portfolios', 'tags')`),
    check('budget_caps_amount_ck', sql`${t.amount} > 0`),
    index('budget_caps_profile_idx').on(t.profileId),
  ],
);
