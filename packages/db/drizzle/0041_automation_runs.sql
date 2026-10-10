CREATE TABLE "automation_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"ad_group_id" uuid,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"old_amount" numeric,
	"new_amount" numeric,
	"currency_code" text,
	"source" text NOT NULL,
	"rule_id" uuid,
	"rule_name" text,
	"limited_by" jsonb NOT NULL,
	"detail" jsonb NOT NULL,
	"status" text NOT NULL,
	"ad_change_id" uuid,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_proposals_entity_type_ck" CHECK ("automation_proposals"."entity_type" in ('target', 'campaign')),
	CONSTRAINT "automation_proposals_field_ck" CHECK ("automation_proposals"."field" in ('bid', 'budget', 'state')),
	CONSTRAINT "automation_proposals_source_ck" CHECK ("automation_proposals"."source" in ('rule', 'optimizer')),
	CONSTRAINT "automation_proposals_status_ck" CHECK ("automation_proposals"."status" in ('open', 'staged', 'dismissed', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"job_run_id" uuid,
	"mode" text NOT NULL,
	"responsible_user_id" uuid,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"metrics_imported_at" timestamp with time zone NOT NULL,
	"fingerprint" text NOT NULL,
	"counts" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_runs_mode_ck" CHECK ("automation_runs"."mode" in ('shadow', 'cart'))
);
--> statement-breakpoint
ALTER TABLE "ad_changes" DROP CONSTRAINT "ad_changes_origin_ck";--> statement-breakpoint
ALTER TABLE "automation_proposals" ADD CONSTRAINT "automation_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_proposals" ADD CONSTRAINT "automation_proposals_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_proposals" ADD CONSTRAINT "automation_proposals_ad_change_id_ad_changes_id_fk" FOREIGN KEY ("ad_change_id") REFERENCES "public"."ad_changes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_proposals" ADD CONSTRAINT "automation_proposals_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_proposals" ADD CONSTRAINT "automation_proposals_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_responsible_user_id_users_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_proposals_run_idx" ON "automation_proposals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "automation_proposals_profile_status_idx" ON "automation_proposals" USING btree ("profile_id","status");--> statement-breakpoint
CREATE INDEX "automation_proposals_ad_change_idx" ON "automation_proposals" USING btree ("ad_change_id");--> statement-breakpoint
CREATE INDEX "automation_runs_profile_created_idx" ON "automation_runs" USING btree ("profile_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ad_changes_automation_pending_uq" ON "ad_changes" USING btree ("entity_type","entity_id","field") WHERE "ad_changes"."status" = 'pending' and "ad_changes"."origin" in ('automation', 'budget_cap');--> statement-breakpoint
ALTER TABLE "ad_changes" ADD CONSTRAINT "ad_changes_origin_ck" CHECK ("ad_changes"."origin" in ('explorer', 'search_terms', 'revert', 'retry', 'automation', 'budget_cap'));