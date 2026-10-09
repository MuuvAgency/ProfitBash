CREATE TABLE "tag_assignments" (
	"tag_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_assignments_pk" PRIMARY KEY("tag_id","entity_type","entity_id"),
	CONSTRAINT "tag_assignments_entity_type_ck" CHECK ("tag_assignments"."entity_type" in ('campaign', 'ad_group', 'target', 'product_ad'))
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_id_org_uq" UNIQUE("id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "tag_assignments" ADD CONSTRAINT "tag_assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_assignments" ADD CONSTRAINT "tag_assignments_tag_org_fk" FOREIGN KEY ("tag_id","organization_id") REFERENCES "public"."tags"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_assignments" ADD CONSTRAINT "tag_assignments_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tag_assignments_entity_idx" ON "tag_assignments" USING btree ("entity_id","entity_type");--> statement-breakpoint
CREATE INDEX "tag_assignments_profile_idx" ON "tag_assignments" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_org_name_uq" ON "tags" USING btree ("organization_id",lower("name"));