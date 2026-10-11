CREATE TABLE "budget_caps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_ids" jsonb NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"month_amounts" jsonb NOT NULL,
	"warn_percents" jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_caps_scope_type_ck" CHECK ("budget_caps"."scope_type" in ('profile', 'portfolios', 'tags')),
	CONSTRAINT "budget_caps_amount_ck" CHECK ("budget_caps"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "budget_caps" ADD CONSTRAINT "budget_caps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_caps" ADD CONSTRAINT "budget_caps_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_caps" ADD CONSTRAINT "budget_caps_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_caps" ADD CONSTRAINT "budget_caps_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_caps_profile_idx" ON "budget_caps" USING btree ("profile_id");