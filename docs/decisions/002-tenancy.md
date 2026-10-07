# ADR 002 – Mandanten-Modell

- **Status:** angenommen
- **Datum:** 2026-09-25, Geltungsbereich von Punkt 5 am 2026-09-26 dokumentiert (Stand Code Phase 0, vor dem ersten Deploy),
  am 2026-09-28 um Referenzdaten (`fx_rates`) ergänzt, am 2026-09-29 um gespeicherte Ansichten (`saved_views`),
  am 2026-10-07 um die Suchbegriff-Regeln (`search_term_rules`) und geschützte Begriffe
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

### Geltungsbereich von Punkt 5 (Stand Phase 0, keine neue Entscheidung)

Punkt 5 regelt die Sichtbarkeit von **Profildaten** (Profile und alles, was an einem Profil hängt; ab Phase 1
Entities, Metriken, Änderungen) für Nutzer. Solche Abfragen sind mit `visibleProfilesScope()` oder `canSeeProfile()`
(bzw. Nachfolgern) begrenzt, auch wenn die eigentliche Abfrage in der Route steht (z. B. `routes/connections.ts`).

Daneben filtern heute diese Zugriffe selbst nach Organisation:

- **Verwaltung der Eigentümer-Org** (Clients, Connections, Jobläufe): Die Routen lesen und schreiben in der aktiven
  Organisation der Session (`auth.activeOrganization`) hinter `orgAdminOnly`. Ausnahme: Der OAuth-Callback
  (`routes/amazon-oauth.ts`) nimmt die Organisation aus dem signierten `state` und prüft die Admin-Rolle selbst
  über `getOrgRole()`.
- **Systemzugriffe ohne Nutzer:** Worker-Jobs, Token-Store, Wartung und Schlüsselrotation
  (`packages/db/src/system-access.ts`, `connection-tokens.ts`, `connection-leases.ts`, `amazon-requests.ts`,
  `amazon-ads-entities.ts`, `amazon-ads-metrics.ts`, `maintenance.ts`, `key-rotation.ts`; `job_runs` schreibt
  `runJob` in `apps/worker`). Zugriffe auf einzelne Connections bzw. Profile sind an Organisation und Connection bzw. Profil gebunden.
  Keiner dieser Zugriffe entscheidet über die Sichtbarkeit für Nutzer. Plattformweit arbeiten die Planung der Jobs (`listActiveConnections`), die Wartung
  (alte und abgebrochene Jobläufe, abgelaufene OAuth-Nonces) und die Schlüsselrotation.
- **Öffentliche Referenzdaten ohne Organisation** (ab Phase 2, 2.2): `fx_rates` (EZB-Kurse) hat keine `organization_id`,
  gilt für alle Organisationen und wird nur vom plattformweiten Job `fx-rates-sync` geschrieben (`packages/db/src/fx-rates.ts`).
  Lesen darf jede Abfrage; Profildaten werden dadurch nicht sichtbar. Die Läufe von `fx-rates-sync` (`job_runs.organization_id`
  leer) zeigt der Sync-Status jeder Organisation (`SHARED_PLATFORM_JOB_NAMES`), andere plattformweite Läufe nicht.
- **Gespeicherte Ansichten** (ab Phase 2, 2.9): `saved_views` gehört der Organisation und einem Besitzer
  (`packages/db/src/saved-views.ts`). Persönliche Ansichten sieht nur der Besitzer, freigegebene alle Mitglieder der
  Organisation (Mitgliedschaft über `getOrgRole()`); ändern und löschen Besitzer und Org-Admins. Der Zustand nennt Clients,
  Profile und Drill-Down-IDs (Portfolio, Kampagne, Ad Group): Diese filtert der Access-Layer beim Speichern **und** beim Laden
  (`filterSavedViewState` über `listVisibleClientsAndProfiles()` und `visibleProfilesScope()`), damit eine Ansicht nie
  Unsichtbares speichert oder ausliefert, auch nicht nach späterem Ausblenden oder mit Profil-Freigaben (Phase 6). Die
  Kennzahlen selbst liest die Ansicht nicht; sie laufen weiter über die Auswertungs-Endpunkte.
- **Mitgliederverwaltung** (ab Phase 2, 2.10): `packages/db/src/members.ts` und `member_password_links` lesen und schreiben
  Mitgliedschaften der aktiven Organisation hinter `orgAdminOnly` (wie Clients und Connections). Die öffentlichen Endpunkte
  zum Setzen des Passworts finden die Organisation über den Hash des Tokens, nicht über eine Eingabe.
- **Suchbegriff-Regeln und geschützte Begriffe** (ab Phase 2b, 2b.2): `search_term_rules` gehört der Organisation
  (`packages/db/src/search-terms.ts`); lesen dürfen alle Mitglieder (`getOrgRole()`), schreiben mit Recht `write` im Feature
  `sp-explorer` (prüft die API). Die geschützten Begriffe eines Clients (`clients.protected_terms`) pflegen Org-Admins über
  die Clients-Verwaltung; die Suchbegriff-Analyse liest sie nur über ein sichtbares Profil dieses Clients mit
  (`querySearchTermPeriod` nach `visibleProfilesScope()`). Für Kunden-Orgs (Phase 6) gilt dafür dieselbe offene Frage wie
  für andere Client-Daten.
- **Auth- und Organisationsdaten:** Mitglieder und Einladungen über better-auth mit eigener Zugriffskontrolle;
  Rollen, Mitgliedschaften und Entitlements über `getOrgRole()`, `listMemberships()` und `listEnabledFeatures()` im
  Access-Layer; dazu der Seed.

**Offen für Phase 6:** ob und wie Kunden-Orgs Client-Daten lesen (Punkt 2 hängt Ziele, Budgets und Auswertungen an
den Client). Dann bekommt der Access-Layer Helfer für Clients (`docs/tasks/phase-0.md`, „Offen für Phase 6“).

Eine nutzerseitige Abfrage von Profildaten, die nicht über den Access-Layer begrenzt ist und keine der Ausnahmen
oben betrifft, ist ein Review-Befund.

## Konsequenzen

- Phase-1-Tabellen tragen `organization_id` (Eigentümer) und `profile_id` (interne ID). Nutzerseitige Abfragen
  sind über den Access-Layer begrenzt (siehe Geltungsbereich).
- Die Signaturen des Access-Layers (`userId`, `orgId`) bleiben stabil. Phase 6 erweitert nur die interne
  Regel: „Mitglied der Eigentümer-Org" **oder** „Mitglied einer freigegebenen Kunden-Org".
- Schreibrechte bleiben bei der Agentur-Org. Kunden-Orgs sind in Phase 6 lesend.
- Die Datenbank erzwingt bereits, dass Profile, Clients und Connections zur selben Org gehören
  (zusammengesetzte Fremdschlüssel über `(id, organization_id)`).
- Der Access-Layer bietet heute für Profile `visibleProfilesScope()` (Unterabfrage für Mengen), `visibleProfileIds()`
  und `canSeeProfile()`, dazu `getOrgRole()`, `listMemberships()` und `listEnabledFeatures()`. Ausgeblendete und entfernte Profile sehen nur Org-Admins (`includeHidden`, `includeRemoved`).

## Verworfene Alternativen

- **Daten gehören der Kunden-Org:** Jede Amazon-Connection müsste pro Kunde laufen oder Daten müssten
  zwischen Orgs verschoben werden. Das widerspricht dem Agentur-Alltag (ein Login sieht viele Kundenkonten).
- **Kunden als Mitglieder der Agentur-Org:** Einfach, aber Entitlements und Rollen ließen sich nicht pro Kunde
  steuern, und ein Kunde könnte über Fehler in Abfragen fremde Profile sehen.
