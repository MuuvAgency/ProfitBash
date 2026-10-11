CREATE TABLE "member_client_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_client_grants" ADD CONSTRAINT "member_client_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_client_grants" ADD CONSTRAINT "member_client_grants_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_client_grants" ADD CONSTRAINT "member_client_grants_client_org_fk" FOREIGN KEY ("client_id","organization_id") REFERENCES "public"."clients"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_client_grants_member_client_uq" ON "member_client_grants" USING btree ("member_id","client_id");