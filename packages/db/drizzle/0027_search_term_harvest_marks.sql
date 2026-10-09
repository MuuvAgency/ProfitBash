CREATE TABLE "search_term_harvest_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"search_term" text NOT NULL,
	"term_key" text NOT NULL,
	"ad_product" text NOT NULL,
	"amazon_campaign_id" text NOT NULL,
	"amazon_ad_group_id" text NOT NULL,
	"amazon_target_id" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"source_rows" integer NOT NULL,
	"currency_code" text NOT NULL,
	"impressions" bigint NOT NULL,
	"clicks" bigint NOT NULL,
	"cost" numeric NOT NULL,
	"sales" numeric NOT NULL,
	"purchases" bigint NOT NULL,
	"units" bigint NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_term_harvest_marks_profile_term_uq" UNIQUE("profile_id","term_key"),
	CONSTRAINT "search_term_harvest_marks_period_ck" CHECK ("search_term_harvest_marks"."period_start" <= "search_term_harvest_marks"."period_end")
);
--> statement-breakpoint
ALTER TABLE "search_term_harvest_marks" ADD CONSTRAINT "search_term_harvest_marks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_term_harvest_marks" ADD CONSTRAINT "search_term_harvest_marks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_term_harvest_marks" ADD CONSTRAINT "search_term_harvest_marks_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_term_harvest_marks_profile_created_idx" ON "search_term_harvest_marks" USING btree ("profile_id","created_at");