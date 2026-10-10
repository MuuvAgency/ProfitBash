CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid,
	"profile_id" uuid,
	"product_group_id" uuid,
	"metric" text NOT NULL,
	"value" numeric(5, 2) NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goals_scope_ck" CHECK (num_nonnulls("goals"."client_id", "goals"."profile_id", "goals"."product_group_id") = 1),
	CONSTRAINT "goals_metric_ck" CHECK ("goals"."metric" in ('acos', 'roas'))
);
--> statement-breakpoint
ALTER TABLE "product_groups" ADD CONSTRAINT "product_groups_id_org_uq" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_client_org_fk" FOREIGN KEY ("client_id","organization_id") REFERENCES "public"."clients"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_product_group_org_fk" FOREIGN KEY ("product_group_id","organization_id") REFERENCES "public"."product_groups"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goals_client_uq" ON "goals" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goals_profile_uq" ON "goals" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goals_product_group_uq" ON "goals" USING btree ("product_group_id");