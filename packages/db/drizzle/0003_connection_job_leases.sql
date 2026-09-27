CREATE TABLE "connection_job_leases" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"job" text NOT NULL,
	"job_run_id" uuid NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection_job_leases" ADD CONSTRAINT "connection_job_leases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_job_leases" ADD CONSTRAINT "connection_job_leases_connection_org_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."connections"("id","organization_id") ON DELETE cascade ON UPDATE no action;