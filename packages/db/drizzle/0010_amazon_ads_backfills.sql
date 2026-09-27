CREATE TABLE "amazon_ads_backfills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"ad_product" text NOT NULL,
	"report_type" text NOT NULL,
	"from_date" date NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_ads_backfills_profile_type_uq" UNIQUE("profile_id","ad_product","report_type")
);
--> statement-breakpoint
ALTER TABLE "amazon_ads_backfills" ADD CONSTRAINT "amazon_ads_backfills_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_backfills" ADD CONSTRAINT "amazon_ads_backfills_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE cascade ON UPDATE no action;