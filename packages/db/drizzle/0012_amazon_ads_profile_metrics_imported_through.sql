CREATE TABLE "amazon_ads_profile_metrics_imported_through" (
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"ad_product" text NOT NULL,
	"imported_through" date NOT NULL,
	CONSTRAINT "amazon_ads_profile_metrics_imported_through_pk" PRIMARY KEY("profile_id","ad_product")
);
--> statement-breakpoint
ALTER TABLE "amazon_ads_profile_metrics_imported_through" ADD CONSTRAINT "amazon_ads_profile_metrics_imported_through_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_profile_metrics_imported_through" ADD CONSTRAINT "amazon_ads_profile_metrics_imported_through_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_profiles" DROP COLUMN "metrics_imported_through";