ALTER TABLE "amazon_ads_ad_group_daily_metrics" ADD COLUMN "viewable_impressions" bigint;--> statement-breakpoint
ALTER TABLE "amazon_ads_campaign_daily_metrics" ADD COLUMN "viewable_impressions" bigint;--> statement-breakpoint
ALTER TABLE "amazon_ads_product_ad_daily_metrics" ADD COLUMN "viewable_impressions" bigint;--> statement-breakpoint
ALTER TABLE "amazon_ads_search_term_daily_metrics" ADD COLUMN "viewable_impressions" bigint;--> statement-breakpoint
ALTER TABLE "amazon_ads_target_daily_metrics" ADD COLUMN "viewable_impressions" bigint;