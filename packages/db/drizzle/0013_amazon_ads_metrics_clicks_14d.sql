ALTER TABLE "amazon_ads_ad_group_daily_metrics" ADD COLUMN "sales_clicks_14d" numeric;--> statement-breakpoint
ALTER TABLE "amazon_ads_ad_group_daily_metrics" ADD COLUMN "purchases_clicks_14d" bigint;--> statement-breakpoint
ALTER TABLE "amazon_ads_ad_group_daily_metrics" ADD COLUMN "units_clicks_14d" bigint;--> statement-breakpoint
ALTER TABLE "amazon_ads_campaign_daily_metrics" ADD COLUMN "sales_clicks_14d" numeric;--> statement-breakpoint
ALTER TABLE "amazon_ads_campaign_daily_metrics" ADD COLUMN "purchases_clicks_14d" bigint;--> statement-breakpoint
ALTER TABLE "amazon_ads_campaign_daily_metrics" ADD COLUMN "units_clicks_14d" bigint;--> statement-breakpoint
ALTER TABLE "amazon_ads_product_ad_daily_metrics" ADD COLUMN "sales_clicks_14d" numeric;--> statement-breakpoint
ALTER TABLE "amazon_ads_product_ad_daily_metrics" ADD COLUMN "purchases_clicks_14d" bigint;--> statement-breakpoint
ALTER TABLE "amazon_ads_product_ad_daily_metrics" ADD COLUMN "units_clicks_14d" bigint;--> statement-breakpoint
ALTER TABLE "amazon_ads_search_term_daily_metrics" ADD COLUMN "sales_clicks_14d" numeric;--> statement-breakpoint
ALTER TABLE "amazon_ads_search_term_daily_metrics" ADD COLUMN "purchases_clicks_14d" bigint;--> statement-breakpoint
ALTER TABLE "amazon_ads_search_term_daily_metrics" ADD COLUMN "units_clicks_14d" bigint;--> statement-breakpoint
ALTER TABLE "amazon_ads_target_daily_metrics" ADD COLUMN "sales_clicks_14d" numeric;--> statement-breakpoint
ALTER TABLE "amazon_ads_target_daily_metrics" ADD COLUMN "purchases_clicks_14d" bigint;--> statement-breakpoint
ALTER TABLE "amazon_ads_target_daily_metrics" ADD COLUMN "units_clicks_14d" bigint;