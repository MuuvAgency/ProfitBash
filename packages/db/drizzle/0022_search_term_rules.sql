CREATE TABLE "search_term_rules" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"harvest_min_purchases" integer NOT NULL,
	"harvest_max_acos" numeric NOT NULL,
	"negate_min_clicks" integer NOT NULL,
	"negate_min_cost" numeric NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "protected_terms" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "search_term_rules" ADD CONSTRAINT "search_term_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_term_rules" ADD CONSTRAINT "search_term_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;