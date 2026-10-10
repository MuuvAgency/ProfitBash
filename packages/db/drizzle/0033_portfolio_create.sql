ALTER TABLE "ad_change_submissions" DROP CONSTRAINT "ad_change_submissions_kind_ck";--> statement-breakpoint
ALTER TABLE "campaign_setup_items" DROP CONSTRAINT "campaign_setup_items_entity_type_ck";--> statement-breakpoint
ALTER TABLE "campaign_setup_items" DROP CONSTRAINT "campaign_setup_items_parent_ck";--> statement-breakpoint
ALTER TABLE "campaign_setup_items" ALTER COLUMN "draft_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_setup_drafts" ADD COLUMN "portfolio_id" uuid;--> statement-breakpoint
ALTER TABLE "ad_change_submissions" ADD CONSTRAINT "ad_change_submissions_kind_ck" CHECK ("ad_change_submissions"."kind" in ('changes', 'setup', 'portfolio'));--> statement-breakpoint
ALTER TABLE "campaign_setup_items" ADD CONSTRAINT "campaign_setup_items_draft_ck" CHECK (("campaign_setup_items"."entity_type" = 'portfolio') = ("campaign_setup_items"."draft_id" is null));--> statement-breakpoint
ALTER TABLE "campaign_setup_items" ADD CONSTRAINT "campaign_setup_items_entity_type_ck" CHECK ("campaign_setup_items"."entity_type" in ('campaign', 'placement', 'ad_group', 'product_ad', 'keyword', 'product_target', 'negative_keyword', 'negative_product_target', 'source_negative', 'portfolio'));--> statement-breakpoint
ALTER TABLE "campaign_setup_items" ADD CONSTRAINT "campaign_setup_items_parent_ck" CHECK (("campaign_setup_items"."entity_type" in ('campaign', 'placement', 'portfolio')) = ("campaign_setup_items"."ad_group_ref" is null));