CREATE TABLE "search_term_rule_overrides" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"harvest_min_purchases" integer,
	"harvest_max_acos" numeric,
	"negate_min_clicks" integer,
	"negate_min_cost" numeric,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_term_rule_overrides_not_empty_ck" CHECK (num_nonnulls("search_term_rule_overrides"."harvest_min_purchases", "search_term_rule_overrides"."harvest_max_acos", "search_term_rule_overrides"."negate_min_clicks", "search_term_rule_overrides"."negate_min_cost") > 0)
);
--> statement-breakpoint
ALTER TABLE "search_term_rule_overrides" ADD CONSTRAINT "search_term_rule_overrides_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_term_rule_overrides" ADD CONSTRAINT "search_term_rule_overrides_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE cascade ON UPDATE no action;