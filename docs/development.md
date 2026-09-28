# Entwicklung

Hinweise für die lokale Entwicklung. Befehle und Grundregeln stehen in [`CLAUDE.md`](../CLAUDE.md).

## Lokale Datenbank

Postgres 17 über Homebrew (`brew services start postgresql@17`), Datenbanken `profitbash` (Entwicklung) und
`profitbash_test` (Tests). Einmalig einrichten:

```bash
pnpm db:migrate
pnpm db:seed
```

`pnpm db:seed` legt den Admin aus `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` und die Organisation „Muuv“ an.

## Mock-Anbieter

Solange es keinen Zugang zur Amazon-Ads-API gibt, läuft die App mit `AMAZON_ADS_USE_MOCK=true`: Einwilligung,
Profile, Exports und Reports kommen aus dem Prozess (`packages/amazon-ads/src/mock.ts`), kein Aufruf verlässt den
Rechner. `AMAZON_ADS_MOCK_SCALE` wählt den Datenumfang:

| Wert | Inhalt | Wofür |
|---|---|---|
| `default` (Standard) | 4 EU-Profile + 1 US-Profil, 3 SP-Kampagnen je Profil, SB und SD nur beim DE-Profil | Tests, schnelle Prüfung der Logik |
| `large` | 6 Demo-Profile (EUR, GBP, SEK, PLN), 300 Kampagnen (SP, SB, SD), rund 12 200 Targets (ohne Negatives), Kennzahlen für 95 Tage | Layout, Filter und Tempo von Dashboard und Explorer |

`large` ist nur für die Entwicklung (mit `AMAZON_ADS_USE_MOCK=true`, nie in Produktion). Die Daten sind
deterministisch (fester Seed je Profil) und erfunden (`packages/amazon-ads/src/mock-large.ts`). Enthalten sind auch
die Sonderfälle: SB-Kampagnen ohne Kennzahlen (v3-Preview-Lücke), Negatives auf Kampagnen- und Ad-Group-Ebene,
pausierte und archivierte Entities, Ads mit mehreren ASINs, SD-vCPM-Kampagnen, ein Vendor-Profil ohne SKU.

## Demo-Daten mit Volumen laden

Die großen Demo-Daten kommen über **denselben Sync** wie echte Daten (keine direkten Inserts): `pnpm demo:load`
legt die Mock-Connection in der Organisation „Muuv“ an, führt `profiles-sync`, `entities-sync`, `reports-sync`
(samt Historie) und `amazon-requests-poll` aus und legt danach drei Clients mit ihrer Zuordnung an
(„Waldkauz (Demo)“: DE, FR; „Lumen (Demo)“: UK, SE; „Kranich (Demo)“: PL; das IT-Profil bleibt ohne Client).

Die lokale DB neu füllen:

1. `pnpm dev` beenden (sonst synchronisiert dessen Worker parallel).
2. In `.env` `AMAZON_ADS_MOCK_SCALE=large` setzen. Ohne das liefert der tägliche Sync von `pnpm dev` die kleinen
   Mock-Profile und markiert die Demo-Profile als entfernt.
3. Datenbank leeren und neu aufsetzen:

   ```bash
   dropdb profitbash && createdb -O profitbash profitbash
   pnpm db:migrate
   pnpm db:seed
   pnpm demo:load
   ```

   `demo:load` dauert einige Minuten (der Poll wartet wie im Betrieb mindestens 1 Minute bis zur ersten
   Abfrage; rund 2 Mio. Kennzahl-Zeilen). Der Befehl ist wiederholbar: Connection und Clients werden wiederverwendet; eine von Hand geänderte
   Zuordnung der Demo-Profile setzt er zurück. Die Läufe stehen wie im Betrieb im Sync-Status. Scheitert ein Lauf, bricht
   der Befehl mit dessen Meldung ab.
4. `pnpm dev` starten. Bei leerer `fx_rates` holt der Worker die EZB-Kurse ab dem 01.01.2026.

Zurück zu den kleinen Mock-Daten: `AMAZON_ADS_MOCK_SCALE` entfernen und die Schritte 1 und 3 ohne `demo:load`
wiederholen, dann in der App „Amazon verbinden“.
