CREATE TABLE "amazon_ads_report_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"kind" "amazon_ads_request_kind" NOT NULL,
	"ad_product" text NOT NULL,
	"report_type" text NOT NULL,
	"start_date" date,
	"end_date" date,
	"batch_id" uuid,
	"amazon_request_id" text,
	"status" "amazon_ads_request_status" DEFAULT 'pending_request' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"import_attempts" integer DEFAULT 0 NOT NULL,
	"next_poll_at" timestamp with time zone,
	"requested_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"imported_at" timestamp with time zone,
	"failure_reason" text,
	"row_count" integer,
	"invalid_row_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_ads_report_requests_kind_ck" CHECK ((kind = 'report' and start_date is not null and end_date is not null and start_date <= end_date and batch_id is null)
        or (kind = 'export' and start_date is null and end_date is null and batch_id is not null))
);
--> statement-breakpoint
ALTER TABLE "amazon_ads_report_requests" ADD CONSTRAINT "amazon_ads_report_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_ads_report_requests" ADD CONSTRAINT "amazon_ads_report_requests_profile_org_fk" FOREIGN KEY ("profile_id","organization_id") REFERENCES "public"."amazon_ads_profiles"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_ads_report_requests_open_uq" ON "amazon_ads_report_requests" USING btree ("profile_id","kind","ad_product","report_type","start_date","end_date") WHERE status in ('pending_request', 'requested', 'completed');--> statement-breakpoint
CREATE INDEX "amazon_ads_report_requests_profile_type_idx" ON "amazon_ads_report_requests" USING btree ("profile_id","kind","ad_product","report_type");--> statement-breakpoint
CREATE INDEX "amazon_ads_report_requests_batch_idx" ON "amazon_ads_report_requests" USING btree ("batch_id") WHERE batch_id is not null;