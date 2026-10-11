CREATE TABLE "campaign_blocks" (
	"campaign_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"block_key" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_blocks" ADD CONSTRAINT "campaign_blocks_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_blocks" ADD CONSTRAINT "campaign_blocks_campaign_fk" FOREIGN KEY ("campaign_id","profile_id") REFERENCES "public"."amazon_ads_campaigns"("id","profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_blocks" ADD CONSTRAINT "campaign_blocks_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_blocks_profile_idx" ON "campaign_blocks" USING btree ("profile_id");