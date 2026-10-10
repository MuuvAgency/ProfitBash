CREATE TABLE "amazon_ads_brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"brand_entity_id" text NOT NULL,
	"name" text,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_ads_brands_profile_entity_uq" UNIQUE("profile_id","brand_entity_id")
);
--> statement-breakpoint
ALTER TABLE "campaign_setup_items" DROP CONSTRAINT "campaign_setup_items_entity_type_ck";--> statement-breakpoint
ALTER TABLE "amazon_ads_brands" ADD CONSTRAINT "amazon_ads_brands_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_brands" ADD CONSTRAINT "amazon_ads_brands_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_setup_items" ADD CONSTRAINT "campaign_setup_items_entity_type_ck" CHECK ("campaign_setup_items"."entity_type" in ('campaign', 'placement', 'ad_group', 'product_ad', 'sb_ad', 'keyword', 'product_target', 'audience_target', 'negative_keyword', 'negative_product_target', 'source_negative', 'portfolio'));