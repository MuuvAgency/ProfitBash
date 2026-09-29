import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { createdAt, id, organizationId, updatedAt } from './columns';

/**
 * Gespeicherte Ansichten (`phase-2.md` F8, 2.9): Zustand von Dashboard bzw. Explorer, persönlich oder für die
 * Organisation freigegeben. Zugriffe nur über `saved-views.ts`; genannte Profile, Clients und Drill-Down-IDs filtert
 * der Access-Layer beim Speichern und beim Laden (ADR 002, Geltungsbereich).
 */
export const savedViews = pgTable(
  'saved_views',
  {
    id: id(),
    organizationId: organizationId(),
    /** Besitzer. Entfernen aus der Organisation löscht nur die persönlichen Ansichten (2.10). */
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** `dashboard` | `explorer` (`SAVED_VIEW_AREAS` in `@profitbash/shared`). */
    area: text('area').notNull(),
    shared: boolean('shared').notNull().default(false),
    /** `SavedViewState` aus `@profitbash/shared`, beim Schreiben mit zod geprüft. */
    state: jsonb('state').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('saved_views_area_ck', sql`area in ('dashboard', 'explorer')`),
    // Ein Name je Besitzer und Bereich (ohne Groß-/Kleinschreibung).
    uniqueIndex('saved_views_owner_area_name_uq').on(
      t.organizationId,
      t.ownerUserId,
      t.area,
      sql`lower(${t.name})`,
    ),
    index('saved_views_org_area_idx').on(t.organizationId, t.area),
  ],
);
