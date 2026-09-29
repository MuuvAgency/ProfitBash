CREATE TABLE "file_import_contents" (
	"file_import_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"content" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"counters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"job_run_id" uuid,
	"uploaded_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_imports_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "file_imports_kind_ck" CHECK ("file_imports"."kind" in ('bulk', 'daily_report')),
	CONSTRAINT "file_imports_status_ck" CHECK ("file_imports"."status" in ('pending', 'running', 'imported', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "file_import_contents" ADD CONSTRAINT "file_import_contents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_import_contents" ADD CONSTRAINT "file_import_contents_import_org_fk" FOREIGN KEY ("file_import_id","organization_id") REFERENCES "public"."file_imports"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_imports" ADD CONSTRAINT "file_imports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_imports" ADD CONSTRAINT "file_imports_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_imports" ADD CONSTRAINT "file_imports_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_imports_profile_created_idx" ON "file_imports" USING btree ("profile_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "file_imports_open_idx" ON "file_imports" USING btree ("profile_id","created_at") WHERE "file_imports"."status" in ('pending', 'running');