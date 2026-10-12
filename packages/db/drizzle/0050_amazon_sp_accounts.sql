ALTER TYPE "public"."connection_provider" ADD VALUE 'amazon_sp';--> statement-breakpoint
CREATE TABLE "amazon_sp_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"client_id" uuid,
	"amazon_seller_id" text NOT NULL,
	"marketplace_id" text NOT NULL,
	"store_name" text NOT NULL,
	"country_code" text NOT NULL,
	"currency_code" text NOT NULL,
	"timezone" text NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"removed_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_sp_accounts_org_seller_marketplace_uq" UNIQUE("organization_id","amazon_seller_id","marketplace_id"),
	CONSTRAINT "amazon_sp_accounts_id_org_uq" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "amazon_sp_credentials" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "amazon_sp_accounts" ADD CONSTRAINT "amazon_sp_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_sp_accounts" ADD CONSTRAINT "amazon_sp_accounts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_sp_accounts" ADD CONSTRAINT "amazon_sp_accounts_connection_org_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."connections"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_sp_accounts" ADD CONSTRAINT "amazon_sp_accounts_client_org_fk" FOREIGN KEY ("client_id","organization_id") REFERENCES "public"."clients"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_sp_credentials" ADD CONSTRAINT "amazon_sp_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_sp_credentials" ADD CONSTRAINT "amazon_sp_credentials_connection_org_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."connections"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "amazon_sp_accounts_connection_idx" ON "amazon_sp_accounts" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "amazon_sp_accounts_client_idx" ON "amazon_sp_accounts" USING btree ("client_id");