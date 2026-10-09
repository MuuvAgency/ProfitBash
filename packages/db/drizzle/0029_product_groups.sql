CREATE TABLE "product_group_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_group_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"asin" text NOT NULL,
	"sku" text,
	"is_hero" boolean DEFAULT false NOT NULL,
	CONSTRAINT "product_group_items_product_uq" UNIQUE NULLS NOT DISTINCT("product_group_id","asin","sku")
);
--> statement-breakpoint
CREATE TABLE "product_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_group_items" ADD CONSTRAINT "product_group_items_product_group_id_product_groups_id_fk" FOREIGN KEY ("product_group_id") REFERENCES "public"."product_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_groups" ADD CONSTRAINT "product_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_groups" ADD CONSTRAINT "product_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_groups" ADD CONSTRAINT "product_groups_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_group_items_hero_uq" ON "product_group_items" USING btree ("product_group_id") WHERE "product_group_items"."is_hero";--> statement-breakpoint
CREATE INDEX "product_group_items_asin_idx" ON "product_group_items" USING btree ("asin");--> statement-breakpoint
CREATE UNIQUE INDEX "product_groups_profile_name_uq" ON "product_groups" USING btree ("profile_id",lower("name"));--> statement-breakpoint
CREATE INDEX "product_groups_org_idx" ON "product_groups" USING btree ("organization_id");