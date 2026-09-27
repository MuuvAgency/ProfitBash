CREATE TYPE "public"."amazon_ads_request_kind" AS ENUM('report', 'export');--> statement-breakpoint
CREATE TYPE "public"."amazon_ads_request_status" AS ENUM('pending_request', 'requested', 'completed', 'imported', 'failed');--> statement-breakpoint
ALTER TABLE "amazon_ads_profiles" ADD CONSTRAINT "amazon_ads_profiles_id_org_uq" UNIQUE("id","organization_id");