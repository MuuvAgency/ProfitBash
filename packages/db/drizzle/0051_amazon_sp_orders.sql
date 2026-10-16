CREATE TABLE "amazon_sp_daily_sales" (
	"organization_id" uuid NOT NULL,
	"seller_account_id" uuid NOT NULL,
	"date" date NOT NULL,
	"sku" text NOT NULL,
	"asin" text,
	"currency" text,
	"units" integer NOT NULL,
	"orders" integer NOT NULL,
	"unpriced_units" integer NOT NULL,
	"item_price" numeric NOT NULL,
	"item_tax" numeric NOT NULL,
	"shipping_price" numeric NOT NULL,
	"shipping_tax" numeric NOT NULL,
	"gift_wrap_price" numeric NOT NULL,
	"gift_wrap_tax" numeric NOT NULL,
	"item_promotion_discount" numeric NOT NULL,
	"ship_promotion_discount" numeric NOT NULL,
	CONSTRAINT "amazon_sp_daily_sales_seller_account_id_date_sku_pk" PRIMARY KEY("seller_account_id","date","sku")
);
--> statement-breakpoint
CREATE TABLE "amazon_sp_order_items" (
	"organization_id" uuid NOT NULL,
	"seller_account_id" uuid NOT NULL,
	"amazon_order_id" text NOT NULL,
	"sku" text NOT NULL,
	"asin" text,
	"purchased_at" timestamp with time zone NOT NULL,
	"purchase_date" date NOT NULL,
	"last_updated_at" timestamp with time zone NOT NULL,
	"order_status" text NOT NULL,
	"item_status" text,
	"fulfillment_channel" text,
	"sales_channel" text,
	"quantity" integer NOT NULL,
	"currency" text,
	"item_price" numeric,
	"item_tax" numeric,
	"shipping_price" numeric,
	"shipping_tax" numeric,
	"gift_wrap_price" numeric,
	"gift_wrap_tax" numeric,
	"item_promotion_discount" numeric,
	"ship_promotion_discount" numeric,
	"is_business_order" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amazon_sp_order_items_seller_account_id_amazon_order_id_sku_pk" PRIMARY KEY("seller_account_id","amazon_order_id","sku")
);
--> statement-breakpoint
CREATE TABLE "amazon_sp_report_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"seller_account_id" uuid NOT NULL,
	"report_type" text NOT NULL,
	"data_start" timestamp with time zone NOT NULL,
	"data_end" timestamp with time zone NOT NULL,
	"amazon_report_id" text,
	"status" "amazon_ads_request_status" DEFAULT 'pending_request' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"import_attempts" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"next_poll_at" timestamp with time zone,
	"requested_at" timestamp with time zone,
	"imported_at" timestamp with time zone,
	"failure_reason" text,
	"row_count" integer,
	"invalid_row_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "amazon_sp_accounts" ADD COLUMN "orders_history_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "amazon_sp_daily_sales" ADD CONSTRAINT "amazon_sp_daily_sales_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_sp_daily_sales" ADD CONSTRAINT "amazon_sp_daily_sales_account_org_fk" FOREIGN KEY ("seller_account_id","organization_id") REFERENCES "public"."amazon_sp_accounts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_sp_order_items" ADD CONSTRAINT "amazon_sp_order_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_sp_order_items" ADD CONSTRAINT "amazon_sp_order_items_account_org_fk" FOREIGN KEY ("seller_account_id","organization_id") REFERENCES "public"."amazon_sp_accounts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_sp_report_requests" ADD CONSTRAINT "amazon_sp_report_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amazon_sp_report_requests" ADD CONSTRAINT "amazon_sp_report_requests_account_org_fk" FOREIGN KEY ("seller_account_id","organization_id") REFERENCES "public"."amazon_sp_accounts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "amazon_sp_order_items_account_date_idx" ON "amazon_sp_order_items" USING btree ("seller_account_id","purchase_date");--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_sp_report_requests_open_uq" ON "amazon_sp_report_requests" USING btree ("seller_account_id","report_type","data_start","data_end") WHERE status in ('pending_request', 'requested', 'completed');--> statement-breakpoint
CREATE INDEX "amazon_sp_report_requests_due_idx" ON "amazon_sp_report_requests" USING btree ("next_poll_at") WHERE status in ('pending_request', 'requested', 'completed');