CREATE TABLE "amazon_ads_ad_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"amazon_ad_group_id" text NOT NULL,
	"ad_product" text NOT NULL,
	"name" text,
	"state" text,
	"default_bid" numeric,
	"default_bid_currency_code" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"amazon_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_ads_ad_groups_profile_amazon_uq" UNIQUE("profile_id","amazon_ad_group_id"),
	CONSTRAINT "amazon_ads_ad_groups_id_profile_uq" UNIQUE("id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "amazon_ads_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"portfolio_id" uuid,
	"amazon_campaign_id" text NOT NULL,
	"ad_product" text NOT NULL,
	"name" text,
	"state" text,
	"targeting_type" text,
	"budget_amount" numeric,
	"budget_currency_code" text,
	"budget_type" text,
	"bidding_strategy" text,
	"start_date" date,
	"end_date" date,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"amazon_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_ads_campaigns_profile_amazon_uq" UNIQUE("profile_id","amazon_campaign_id"),
	CONSTRAINT "amazon_ads_campaigns_id_profile_uq" UNIQUE("id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "amazon_ads_negative_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"level" text NOT NULL,
	"campaign_id" uuid NOT NULL,
	"ad_group_id" uuid,
	"amazon_target_id" text NOT NULL,
	"ad_product" text NOT NULL,
	"target_type" text NOT NULL,
	"keyword_text" text,
	"match_type" text,
	"expression" jsonb,
	"state" text NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"amazon_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_ads_negative_targets_profile_amazon_uq" UNIQUE("profile_id","amazon_target_id"),
	CONSTRAINT "amazon_ads_negative_targets_id_profile_uq" UNIQUE("id","profile_id"),
	CONSTRAINT "amazon_ads_negative_targets_level_ck" CHECK ((level = 'campaign' and ad_group_id is null) or (level = 'ad_group' and ad_group_id is not null))
);
--> statement-breakpoint
CREATE TABLE "amazon_ads_portfolios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"amazon_portfolio_id" text NOT NULL,
	"name" text,
	"state" text,
	"budget_amount" numeric,
	"budget_currency_code" text,
	"budget_policy" text,
	"budget_start_date" date,
	"budget_end_date" date,
	"in_budget" boolean,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"amazon_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_ads_portfolios_profile_amazon_uq" UNIQUE("profile_id","amazon_portfolio_id"),
	CONSTRAINT "amazon_ads_portfolios_id_profile_uq" UNIQUE("id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "amazon_ads_product_ads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"ad_group_id" uuid NOT NULL,
	"amazon_ad_id" text NOT NULL,
	"ad_product" text NOT NULL,
	"asin" text,
	"sku" text,
	"state" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"amazon_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_ads_product_ads_profile_amazon_uq" UNIQUE("profile_id","amazon_ad_id"),
	CONSTRAINT "amazon_ads_product_ads_id_profile_uq" UNIQUE("id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "amazon_ads_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"ad_group_id" uuid,
	"amazon_target_id" text NOT NULL,
	"ad_product" text NOT NULL,
	"target_type" text,
	"keyword_text" text,
	"match_type" text,
	"expression" jsonb,
	"state" text,
	"bid" numeric,
	"bid_currency_code" text,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"amazon_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_ads_targets_profile_amazon_uq" UNIQUE("profile_id","amazon_target_id"),
	CONSTRAINT "amazon_ads_targets_id_profile_uq" UNIQUE("id","profile_id")
);
--> statement-breakpoint
ALTER TABLE "amazon_ads_ad_groups" ADD CONSTRAINT "amazon_ads_ad_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_ad_groups" ADD CONSTRAINT "amazon_ads_ad_groups_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_ad_groups" ADD CONSTRAINT "amazon_ads_ad_groups_campaign_fk" FOREIGN KEY ("campaign_id","profile_id") REFERENCES "public"."amazon_ads_campaigns"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_campaigns" ADD CONSTRAINT "amazon_ads_campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_campaigns" ADD CONSTRAINT "amazon_ads_campaigns_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_campaigns" ADD CONSTRAINT "amazon_ads_campaigns_portfolio_fk" FOREIGN KEY ("portfolio_id","profile_id") REFERENCES "public"."amazon_ads_portfolios"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_negative_targets" ADD CONSTRAINT "amazon_ads_negative_targets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_negative_targets" ADD CONSTRAINT "amazon_ads_negative_targets_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_negative_targets" ADD CONSTRAINT "amazon_ads_negative_targets_campaign_fk" FOREIGN KEY ("campaign_id","profile_id") REFERENCES "public"."amazon_ads_campaigns"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_negative_targets" ADD CONSTRAINT "amazon_ads_negative_targets_ad_group_fk" FOREIGN KEY ("ad_group_id","profile_id") REFERENCES "public"."amazon_ads_ad_groups"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_portfolios" ADD CONSTRAINT "amazon_ads_portfolios_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_portfolios" ADD CONSTRAINT "amazon_ads_portfolios_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_product_ads" ADD CONSTRAINT "amazon_ads_product_ads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_product_ads" ADD CONSTRAINT "amazon_ads_product_ads_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_product_ads" ADD CONSTRAINT "amazon_ads_product_ads_campaign_fk" FOREIGN KEY ("campaign_id","profile_id") REFERENCES "public"."amazon_ads_campaigns"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_product_ads" ADD CONSTRAINT "amazon_ads_product_ads_ad_group_fk" FOREIGN KEY ("ad_group_id","profile_id") REFERENCES "public"."amazon_ads_ad_groups"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_targets" ADD CONSTRAINT "amazon_ads_targets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_targets" ADD CONSTRAINT "amazon_ads_targets_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_targets" ADD CONSTRAINT "amazon_ads_targets_campaign_fk" FOREIGN KEY ("campaign_id","profile_id") REFERENCES "public"."amazon_ads_campaigns"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_targets" ADD CONSTRAINT "amazon_ads_targets_ad_group_fk" FOREIGN KEY ("ad_group_id","profile_id") REFERENCES "public"."amazon_ads_ad_groups"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "amazon_ads_ad_groups_campaign_idx" ON "amazon_ads_ad_groups" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "amazon_ads_campaigns_portfolio_idx" ON "amazon_ads_campaigns" USING btree ("portfolio_id");--> statement-breakpoint
CREATE INDEX "amazon_ads_negative_targets_campaign_idx" ON "amazon_ads_negative_targets" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "amazon_ads_negative_targets_ad_group_idx" ON "amazon_ads_negative_targets" USING btree ("ad_group_id");--> statement-breakpoint
CREATE INDEX "amazon_ads_product_ads_campaign_idx" ON "amazon_ads_product_ads" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "amazon_ads_product_ads_ad_group_idx" ON "amazon_ads_product_ads" USING btree ("ad_group_id");--> statement-breakpoint
CREATE INDEX "amazon_ads_targets_campaign_idx" ON "amazon_ads_targets" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "amazon_ads_targets_ad_group_idx" ON "amazon_ads_targets" USING btree ("ad_group_id");