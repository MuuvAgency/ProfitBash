CREATE TABLE "client_presets" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"preset_key" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "structure_catalogs" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"catalog" jsonb NOT NULL,
	"version" integer NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_groups" ADD COLUMN "preset_key" text;--> statement-breakpoint
ALTER TABLE "client_presets" ADD CONSTRAINT "client_presets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_presets" ADD CONSTRAINT "client_presets_client_org_fk" FOREIGN KEY ("client_id","organization_id") REFERENCES "public"."clients"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "structure_catalogs" ADD CONSTRAINT "structure_catalogs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "structure_catalogs" ADD CONSTRAINT "structure_catalogs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;