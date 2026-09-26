# ADR 002 – Mandanten-Modell

- **Status:** angenommen
- **Datum:** 2026-09-25
- **Beteiligte:** Dominik

## Kontext

ProfitBash wird zuerst von der Agentur Muuv genutzt. Später sollen Kunden (z. B. ein Markenkunde der Agentur) eigene Logins bekommen
und ihre Daten sehen. Bisher gibt es zwei Begriffe für „Kunde":
- `clients` – die Geschäftseinheit innerhalb der Agentur, die Profile bündelt
- Organisationen mit `type = client` – ein möglicher Kunden-Login

Diese Frage muss vor den Phase-1-Tabellen (Kampagnen, Metriken) entschieden sein. Sie legt fest, welche
`organization_id` in jeder Datenzeile steht.

## Entscheidung

**Die Agentur-Organisation besitzt alle Daten. Kunden bekommen später Lesezugriff über Freigaben.**

1. **Eigentum:** Connections, Profile und alle daraus abgeleiteten Daten (Entities, Metriken, Änderungen)
   tragen die `organization_id` der Agentur-Org, über die die Amazon-Connection läuft (heute: Muuv).
   Daten werden nie zwischen Organisationen verschoben.
2. **`clients` bleibt die Geschäftseinheit** innerhalb der Agentur-Org. Ziele, Budgets und Auswertungen
   hängen am Client.
3. **Kundenzugang (Phase 6):** Eine Kunden-Org (`organizations.type = client`) wird mit einem Client verknüpft,
   z. B. über `clients.client_organization_id`. Mitglieder der Kunden-Org sehen die Profile dieses Clients
   **nur lesend**. Feinere Freigaben einzelner Profile laufen über eine Tabelle wie
   `profile_grants(grantee_organization_id, profile_id)`.
4. **Entitlements:** gelten je Organisation. Für Kunden-Logins zählen die Entitlements der Kunden-Org.
   Die Agentur-Org hat ihre eigenen.
5. **Durchsetzung an genau einer Stelle:** Der Access-Layer (`packages/db/src/access.ts`) entscheidet über
   Sichtbarkeit. Abfragen filtern **nie direkt** nach `organization_id`, sondern über `visibleProfilesScope()`
   bzw. Nachfolger. Nur so lässt sich Phase 6 ergänzen, ohne jede Abfrage anzufassen.

## Konsequenzen

- Phase-1-Tabellen tragen `organization_id` (Eigentümer) und `profile_id` (interne ID) und werden
  ausschließlich über den Access-Layer gelesen.
- Die Signaturen des Access-Layers (`userId`, `orgId`) bleiben stabil. Phase 6 erweitert nur die interne
  Regel: „Mitglied der Eigentümer-Org" **oder** „Mitglied einer freigegebenen Kunden-Org".
- Schreibrechte bleiben bei der Agentur-Org. Kunden-Orgs sind in Phase 6 lesend.
- Die Datenbank erzwingt bereits, dass Profile, Clients und Connections zur selben Org gehören
  (zusammengesetzte Fremdschlüssel).

## Verworfene Alternativen

- **Daten gehören der Kunden-Org:** Jede Amazon-Connection müsste pro Kunde laufen oder Daten müssten
  zwischen Orgs verschoben werden. Das widerspricht dem Agentur-Alltag (ein Login sieht viele Kundenkonten).
- **Kunden als Mitglieder der Agentur-Org:** Einfach, aber Entitlements und Rollen ließen sich nicht pro Kunde
  steuern, und ein Kunde könnte über Fehler in Abfragen fremde Profile sehen.
