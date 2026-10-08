CREATE TABLE "ad_change_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"job_run_id" uuid,
	"created_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_change_submissions_id_profile_uq" UNIQUE("id","profile_id"),
	CONSTRAINT "ad_change_submissions_channel_ck" CHECK ("ad_change_submissions"."channel" in ('api', 'bulk_file')),
	CONSTRAINT "ad_change_submissions_status_ck" CHECK ("ad_change_submissions"."status" in ('pending', 'running', 'finished', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "ad_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"submission_id" uuid,
	"origin" text NOT NULL,
	"origin_change_id" uuid,
	"operation" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"campaign_id" uuid NOT NULL,
	"ad_group_id" uuid,
	"field" text,
	"old_value" text,
	"new_value" text,
	"old_amount" numeric,
	"new_amount" numeric,
	"currency_code" text,
	"payload" jsonb,
	"amazon_entity_id" text,
	"error_code" text,
	"error_message" text,
	"resolved_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_changes_status_ck" CHECK ("ad_changes"."status" in ('pending', 'submitted', 'applied', 'failed', 'dismissed')),
	CONSTRAINT "ad_changes_pending_ck" CHECK (("ad_changes"."status" = 'pending') = ("ad_changes"."submission_id" is null)),
	CONSTRAINT "ad_changes_origin_ck" CHECK ("ad_changes"."origin" in ('explorer', 'search_terms', 'revert', 'retry')),
	CONSTRAINT "ad_changes_entity_type_ck" CHECK ("ad_changes"."entity_type" in ('campaign', 'ad_group', 'target', 'product_ad', 'negative_target')),
	CONSTRAINT "ad_changes_entity_parent_ck" CHECK (("ad_changes"."entity_type" <> 'campaign' or ("ad_changes"."entity_id" = "ad_changes"."campaign_id" and "ad_changes"."ad_group_id" is null)) and ("ad_changes"."entity_type" <> 'ad_group' or "ad_changes"."entity_id" = "ad_changes"."ad_group_id")),
	CONSTRAINT "ad_changes_operation_ck" CHECK (("ad_changes"."operation" = 'update' and "ad_changes"."entity_id" is not null and "ad_changes"."field" is not null and "ad_changes"."payload" is null and num_nonnulls("ad_changes"."new_value", "ad_changes"."new_amount") = 1 and num_nonnulls("ad_changes"."old_value", "ad_changes"."old_amount") <= 1) or ("ad_changes"."operation" = 'create' and "ad_changes"."entity_type" = 'negative_target' and "ad_changes"."entity_id" is null and "ad_changes"."field" is null and "ad_changes"."payload" is not null and num_nonnulls("ad_changes"."new_value", "ad_changes"."new_amount", "ad_changes"."old_value", "ad_changes"."old_amount", "ad_changes"."currency_code") = 0)),
	CONSTRAINT "ad_changes_value_kind_ck" CHECK ("ad_changes"."operation" <> 'update' or ("ad_changes"."field" in ('state', 'bidding_strategy') and "ad_changes"."new_value" is not null and "ad_changes"."old_amount" is null and "ad_changes"."currency_code" is null) or ("ad_changes"."field" in ('budget', 'default_bid', 'bid') and "ad_changes"."new_amount" is not null and "ad_changes"."old_value" is null and "ad_changes"."currency_code" is not null) or ("ad_changes"."field" like 'placement\_%' and "ad_changes"."new_amount" is not null and "ad_changes"."old_value" is null and "ad_changes"."currency_code" is null))
);
--> statement-breakpoint
ALTER TABLE "ad_change_submissions" ADD CONSTRAINT "ad_change_submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_change_submissions" ADD CONSTRAINT "ad_change_submissions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_change_submissions" ADD CONSTRAINT "ad_change_submissions_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_changes" ADD CONSTRAINT "ad_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_changes" ADD CONSTRAINT "ad_changes_origin_change_id_ad_changes_id_fk" FOREIGN KEY ("origin_change_id") REFERENCES "public"."ad_changes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_changes" ADD CONSTRAINT "ad_changes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_changes" ADD CONSTRAINT "ad_changes_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_changes" ADD CONSTRAINT "ad_changes_campaign_fk" FOREIGN KEY ("campaign_id","profile_id") REFERENCES "public"."amazon_ads_campaigns"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_changes" ADD CONSTRAINT "ad_changes_ad_group_fk" FOREIGN KEY ("ad_group_id","profile_id") REFERENCES "public"."amazon_ads_ad_groups"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_changes" ADD CONSTRAINT "ad_changes_submission_fk" FOREIGN KEY ("submission_id","profile_id") REFERENCES "public"."ad_change_submissions"("id","profile_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_change_submissions_profile_created_idx" ON "ad_change_submissions" USING btree ("profile_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ad_change_submissions_open_idx" ON "ad_change_submissions" USING btree ("profile_id","created_at") WHERE "ad_change_submissions"."status" in ('pending', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "ad_changes_pending_uq" ON "ad_changes" USING btree ("created_by","entity_type","entity_id","field") WHERE "ad_changes"."status" = 'pending' and "ad_changes"."operation" = 'update';--> statement-breakpoint
CREATE INDEX "ad_changes_entity_idx" ON "ad_changes" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "ad_changes_submission_idx" ON "ad_changes" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "ad_changes_campaign_idx" ON "ad_changes" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "ad_changes_ad_group_idx" ON "ad_changes" USING btree ("ad_group_id");--> statement-breakpoint
CREATE INDEX "ad_changes_pending_user_idx" ON "ad_changes" USING btree ("created_by") WHERE "ad_changes"."status" = 'pending';