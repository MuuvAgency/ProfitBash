CREATE TABLE "fx_rates" (
	"date" date NOT NULL,
	"base" text DEFAULT 'EUR' NOT NULL,
	"quote" text NOT NULL,
	"rate" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_pk" PRIMARY KEY("quote","date"),
	CONSTRAINT "fx_rates_base_eur" CHECK ("fx_rates"."base" = 'EUR'),
	CONSTRAINT "fx_rates_quote_iso" CHECK ("fx_rates"."quote" ~ '^[A-Z]{3}$' and "fx_rates"."quote" <> 'EUR'),
	CONSTRAINT "fx_rates_rate_positive" CHECK ("fx_rates"."rate" > 0)
);
