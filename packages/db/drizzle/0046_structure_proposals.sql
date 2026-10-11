CREATE TABLE "automation_structure_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"key" text NOT NULL,
	"detail" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"dismissed_by" uuid,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "automation_structure_proposals_kind_ck" CHECK ("automation_structure_proposals"."kind" in ('graduation', 'presetSwitch'))
);
--> statement-breakpoint
ALTER TABLE "automation_structure_proposals" ADD CONSTRAINT "automation_structure_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_structure_proposals" ADD CONSTRAINT "automation_structure_proposals_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_structure_proposals" ADD CONSTRAINT "automation_structure_proposals_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_structure_proposals_key_uq" ON "automation_structure_proposals" USING btree ("profile_id","kind","subject","key");