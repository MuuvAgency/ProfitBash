-- Custom SQL migration file, put your code below! --
-- Kein doppelter offener Auftrag je Schlüssel, auch wenn start_date/end_date leer sind (Exports).
-- Drizzle erzeugt NULLS NOT DISTINCT nur für Constraints, ein partieller Index braucht es hier von Hand.
DROP INDEX "amazon_ads_report_requests_open_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "amazon_ads_report_requests_open_uq" ON "amazon_ads_report_requests" USING btree ("profile_id","kind","ad_product","report_type","start_date","end_date") NULLS NOT DISTINCT WHERE status in ('pending_request', 'requested', 'completed');
