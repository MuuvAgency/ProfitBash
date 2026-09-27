CREATE TABLE "amazon_ads_ad_group_daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"date" date NOT NULL,
	"ad_product" text NOT NULL,
	"ad_group_id" uuid NOT NULL,
	"currency_code" text NOT NULL,
	"impressions" bigint NOT NULL,
	"clicks" bigint NOT NULL,
	"cost" numeric NOT NULL,
	"sales_7d" numeric,
	"sales_14d" numeric,
	"sales_same_sku_7d" numeric,
	"sales_same_sku_14d" numeric,
	"purchases_7d" bigint,
	"purchases_14d" bigint,
	"purchases_same_sku_7d" bigint,
	"purchases_same_sku_14d" bigint,
	"units_7d" bigint,
	"units_14d" bigint,
	"units_same_sku_7d" bigint,
	"units_same_sku_14d" bigint,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	CONSTRAINT "amazon_ads_ad_group_daily_metrics_key_uq" UNIQUE("profile_id","ad_group_id","date")
);
--> statement-breakpoint
CREATE TABLE "amazon_ads_campaign_daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"date" date NOT NULL,
	"ad_product" text NOT NULL,
	"campaign_id" uuid NOT NULL,
	"currency_code" text NOT NULL,
	"impressions" bigint NOT NULL,
	"clicks" bigint NOT NULL,
	"cost" numeric NOT NULL,
	"sales_7d" numeric,
	"sales_14d" numeric,
	"sales_same_sku_7d" numeric,
	"sales_same_sku_14d" numeric,
	"purchases_7d" bigint,
	"purchases_14d" bigint,
	"purchases_same_sku_7d" bigint,
	"purchases_same_sku_14d" bigint,
	"units_7d" bigint,
	"units_14d" bigint,
	"units_same_sku_7d" bigint,
	"units_same_sku_14d" bigint,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	CONSTRAINT "amazon_ads_campaign_daily_metrics_key_uq" UNIQUE("profile_id","campaign_id","date")
);
--> statement-breakpoint
CREATE TABLE "amazon_ads_product_ad_daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"date" date NOT NULL,
	"ad_product" text NOT NULL,
	"product_ad_id" uuid NOT NULL,
	"currency_code" text NOT NULL,
	"impressions" bigint NOT NULL,
	"clicks" bigint NOT NULL,
	"cost" numeric NOT NULL,
	"sales_7d" numeric,
	"sales_14d" numeric,
	"sales_same_sku_7d" numeric,
	"sales_same_sku_14d" numeric,
	"purchases_7d" bigint,
	"purchases_14d" bigint,
	"purchases_same_sku_7d" bigint,
	"purchases_same_sku_14d" bigint,
	"units_7d" bigint,
	"units_14d" bigint,
	"units_same_sku_7d" bigint,
	"units_same_sku_14d" bigint,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	CONSTRAINT "amazon_ads_product_ad_daily_metrics_key_uq" UNIQUE("profile_id","product_ad_id","date")
);
--> statement-breakpoint
CREATE TABLE "amazon_ads_search_term_daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"date" date NOT NULL,
	"ad_product" text NOT NULL,
	"target_id" uuid NOT NULL,
	"search_term" text NOT NULL,
	"currency_code" text NOT NULL,
	"impressions" bigint NOT NULL,
	"clicks" bigint NOT NULL,
	"cost" numeric NOT NULL,
	"sales_7d" numeric,
	"sales_14d" numeric,
	"sales_same_sku_7d" numeric,
	"sales_same_sku_14d" numeric,
	"purchases_7d" bigint,
	"purchases_14d" bigint,
	"purchases_same_sku_7d" bigint,
	"purchases_same_sku_14d" bigint,
	"units_7d" bigint,
	"units_14d" bigint,
	"units_same_sku_7d" bigint,
	"units_same_sku_14d" bigint,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	CONSTRAINT "amazon_ads_search_term_daily_metrics_key_uq" UNIQUE("profile_id","target_id","date","search_term")
);
--> statement-breakpoint
CREATE TABLE "amazon_ads_target_daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"date" date NOT NULL,
	"ad_product" text NOT NULL,
	"target_id" uuid NOT NULL,
	"currency_code" text NOT NULL,
	"impressions" bigint NOT NULL,
	"clicks" bigint NOT NULL,
	"cost" numeric NOT NULL,
	"sales_7d" numeric,
	"sales_14d" numeric,
	"sales_same_sku_7d" numeric,
	"sales_same_sku_14d" numeric,
	"purchases_7d" bigint,
	"purchases_14d" bigint,
	"purchases_same_sku_7d" bigint,
	"purchases_same_sku_14d" bigint,
	"units_7d" bigint,
	"units_14d" bigint,
	"units_same_sku_7d" bigint,
	"units_same_sku_14d" bigint,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	CONSTRAINT "amazon_ads_target_daily_metrics_key_uq" UNIQUE("profile_id","target_id","date")
);
--> statement-breakpoint
ALTER TABLE "amazon_ads_ad_group_daily_metrics" ADD CONSTRAINT "amazon_ads_ad_group_daily_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_ad_group_daily_metrics" ADD CONSTRAINT "amazon_ads_ad_group_daily_metrics_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_ad_group_daily_metrics" ADD CONSTRAINT "amazon_ads_ad_group_daily_metrics_ad_group_fk" FOREIGN KEY ("ad_group_id","profile_id") REFERENCES "public"."amazon_ads_ad_groups"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_campaign_daily_metrics" ADD CONSTRAINT "amazon_ads_campaign_daily_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_campaign_daily_metrics" ADD CONSTRAINT "amazon_ads_campaign_daily_metrics_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_campaign_daily_metrics" ADD CONSTRAINT "amazon_ads_campaign_daily_metrics_campaign_fk" FOREIGN KEY ("campaign_id","profile_id") REFERENCES "public"."amazon_ads_campaigns"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_product_ad_daily_metrics" ADD CONSTRAINT "amazon_ads_product_ad_daily_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_product_ad_daily_metrics" ADD CONSTRAINT "amazon_ads_product_ad_daily_metrics_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_product_ad_daily_metrics" ADD CONSTRAINT "amazon_ads_product_ad_daily_metrics_product_ad_fk" FOREIGN KEY ("product_ad_id","profile_id") REFERENCES "public"."amazon_ads_product_ads"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_search_term_daily_metrics" ADD CONSTRAINT "amazon_ads_search_term_daily_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_search_term_daily_metrics" ADD CONSTRAINT "amazon_ads_search_term_daily_metrics_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_search_term_daily_metrics" ADD CONSTRAINT "amazon_ads_search_term_daily_metrics_target_fk" FOREIGN KEY ("target_id","profile_id") REFERENCES "public"."amazon_ads_targets"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_target_daily_metrics" ADD CONSTRAINT "amazon_ads_target_daily_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_target_daily_metrics" ADD CONSTRAINT "amazon_ads_target_daily_metrics_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_target_daily_metrics" ADD CONSTRAINT "amazon_ads_target_daily_metrics_target_fk" FOREIGN KEY ("target_id","profile_id") REFERENCES "public"."amazon_ads_targets"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "amazon_ads_ad_group_daily_metrics_profile_date_idx" ON "amazon_ads_ad_group_daily_metrics" USING btree ("profile_id","date");--> statement-breakpoint
CREATE INDEX "amazon_ads_campaign_daily_metrics_profile_date_idx" ON "amazon_ads_campaign_daily_metrics" USING btree ("profile_id","date");--> statement-breakpoint
CREATE INDEX "amazon_ads_product_ad_daily_metrics_profile_date_idx" ON "amazon_ads_product_ad_daily_metrics" USING btree ("profile_id","date");--> statement-breakpoint
CREATE INDEX "amazon_ads_search_term_daily_metrics_profile_date_idx" ON "amazon_ads_search_term_daily_metrics" USING btree ("profile_id","date");--> statement-breakpoint
CREATE INDEX "amazon_ads_target_daily_metrics_profile_date_idx" ON "amazon_ads_target_daily_metrics" USING btree ("profile_id","date");