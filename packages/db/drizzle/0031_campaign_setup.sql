CREATE TABLE "campaign_setup_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"product_group_id" uuid,
	"preset_key" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"campaign_state" text DEFAULT 'ENABLED' NOT NULL,
	"inputs" jsonb NOT NULL,
	"campaigns" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"submission_id" uuid,
	"created_by" uuid,
	"updated_by" uuid,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_setup_drafts_status_ck" CHECK ("campaign_setup_drafts"."status" in ('draft', 'submitted', 'discarded')),
	CONSTRAINT "campaign_setup_drafts_campaign_state_ck" CHECK ("campaign_setup_drafts"."campaign_state" in ('ENABLED', 'PAUSED')),
	CONSTRAINT "campaign_setup_drafts_submission_ck" CHECK (("campaign_setup_drafts"."status" = 'submitted') = ("campaign_setup_drafts"."submission_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "campaign_setup_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"entity_type" text NOT NULL,
	"campaign_ref" text NOT NULL,
	"ad_group_ref" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"amazon_entity_id" text,
	"error_code" text,
	"error_message" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_setup_items_status_ck" CHECK ("campaign_setup_items"."status" in ('submitted', 'applied', 'failed', 'dismissed')),
	CONSTRAINT "campaign_setup_items_entity_type_ck" CHECK ("campaign_setup_items"."entity_type" in ('campaign', 'placement', 'ad_group', 'product_ad', 'keyword', 'product_target', 'negative_keyword', 'negative_product_target')),
	CONSTRAINT "campaign_setup_items_parent_ck" CHECK (("campaign_setup_items"."entity_type" in ('campaign', 'placement')) = ("campaign_setup_items"."ad_group_ref" is null))
);
--> statement-breakpoint
ALTER TABLE "ad_change_submissions" ADD COLUMN "kind" text DEFAULT 'changes' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_setup_drafts" ADD CONSTRAINT "campaign_setup_drafts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_setup_drafts" ADD CONSTRAINT "campaign_setup_drafts_product_group_id_product_groups_id_fk" FOREIGN KEY ("product_group_id") REFERENCES "public"."product_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_setup_drafts" ADD CONSTRAINT "campaign_setup_drafts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_setup_drafts" ADD CONSTRAINT "campaign_setup_drafts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_setup_drafts" ADD CONSTRAINT "campaign_setup_drafts_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_setup_drafts" ADD CONSTRAINT "campaign_setup_drafts_submission_fk" FOREIGN KEY ("submission_id","profile_id") REFERENCES "public"."ad_change_submissions"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_setup_items" ADD CONSTRAINT "campaign_setup_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_setup_items" ADD CONSTRAINT "campaign_setup_items_draft_id_campaign_setup_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."campaign_setup_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_setup_items" ADD CONSTRAINT "campaign_setup_items_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_setup_items" ADD CONSTRAINT "campaign_setup_items_submission_fk" FOREIGN KEY ("submission_id","profile_id") REFERENCES "public"."ad_change_submissions"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_setup_drafts_profile_idx" ON "campaign_setup_drafts" USING btree ("profile_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "campaign_setup_drafts_submission_idx" ON "campaign_setup_drafts" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "campaign_setup_items_submission_idx" ON "campaign_setup_items" USING btree ("submission_id","position");--> statement-breakpoint
CREATE INDEX "campaign_setup_items_unresolved_profile_idx" ON "campaign_setup_items" USING btree ("profile_id") WHERE "campaign_setup_items"."status" = 'submitted' or ("campaign_setup_items"."status" = 'applied' and "campaign_setup_items"."amazon_entity_id" is null and "campaign_setup_items"."entity_type" <> 'placement');--> statement-breakpoint
ALTER TABLE "ad_change_submissions" ADD CONSTRAINT "ad_change_submissions_kind_ck" CHECK ("ad_change_submissions"."kind" in ('changes', 'setup'));