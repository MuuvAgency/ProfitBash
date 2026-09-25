-- Regeln für die von better-auth generierte Tabelle `members`. Sie stehen hier als eigene
-- Migration, weil `packages/db/src/schema/auth.ts` vom better-auth-CLI überschrieben wird.

-- Jeder Nutzer ist höchstens einmal Mitglied einer Organisation.
CREATE UNIQUE INDEX "members_org_user_uq" ON "members" USING btree ("organization_id", "user_id");
--> statement-breakpoint
-- Nur die Rollen aus packages/shared/src/roles.ts. Unbekannte Rollen fallen sofort auf,
-- statt stillschweigend wie „kein Mitglied" behandelt zu werden.
ALTER TABLE "members" ADD CONSTRAINT "members_role_check" CHECK ("role" IN ('admin', 'editor', 'viewer'));
