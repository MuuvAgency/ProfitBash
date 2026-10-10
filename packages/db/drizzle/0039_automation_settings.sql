CREATE TABLE "automation_defaults" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"guardrails" jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_automation_settings" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"responsible_user_id" uuid,
	"overrides" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_automation_settings_mode_ck" CHECK ("client_automation_settings"."mode" in ('off', 'shadow', 'cart'))
);
--> statement-breakpoint
ALTER TABLE "automation_defaults" ADD CONSTRAINT "automation_defaults_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_defaults" ADD CONSTRAINT "automation_defaults_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_automation_settings" ADD CONSTRAINT "client_automation_settings_responsible_user_id_users_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_automation_settings" ADD CONSTRAINT "client_automation_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_automation_settings" ADD CONSTRAINT "client_automation_settings_client_org_fk" FOREIGN KEY ("client_id","organization_id") REFERENCES "public"."clients"("id","organization_id") ON DELETE cascade ON UPDATE no action;