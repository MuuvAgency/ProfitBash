CREATE TABLE "amazon_ads_entity_period_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"ad_product" text NOT NULL,
	"level" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amazon_campaign_id" text NOT NULL,
	"amazon_entity_id" text NOT NULL,
	"currency_code" text NOT NULL,
	"impressions" bigint NOT NULL,
	"clicks" bigint NOT NULL,
	"cost" numeric NOT NULL,
	"sales" numeric NOT NULL,
	"purchases" bigint NOT NULL,
	"units" bigint NOT NULL,
	"viewable_impressions" bigint,
	"sales_views_clicks" numeric,
	"purchases_views_clicks" bigint,
	"units_views_clicks" bigint,
	"imported_at" timestamp with time zone NOT NULL,
	"file_import_id" uuid,
	CONSTRAINT "amazon_ads_entity_period_metrics_key_uq" UNIQUE("profile_id","ad_product","period_start","period_end","level","amazon_campaign_id","amazon_entity_id"),
	CONSTRAINT "amazon_ads_entity_period_metrics_period_ck" CHECK ("amazon_ads_entity_period_metrics"."period_start" <= "amazon_ads_entity_period_metrics"."period_end"),
	CONSTRAINT "amazon_ads_entity_period_metrics_level_ck" CHECK ("amazon_ads_entity_period_metrics"."level" in ('campaign', 'adGroup', 'target', 'productAd', 'placement'))
);
--> statement-breakpoint
ALTER TABLE "amazon_ads_entity_period_metrics" ADD CONSTRAINT "amazon_ads_entity_period_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_entity_period_metrics" ADD CONSTRAINT "amazon_ads_entity_period_metrics_file_import_id_file_imports_id_fk" FOREIGN KEY ("file_import_id") REFERENCES "public"."file_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_entity_period_metrics" ADD CONSTRAINT "amazon_ads_entity_period_metrics_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "amazon_ads_entity_period_metrics_imported_idx" ON "amazon_ads_entity_period_metrics" USING btree ("profile_id","imported_at");