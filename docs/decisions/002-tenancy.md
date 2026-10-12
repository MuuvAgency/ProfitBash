# ADR 002 – Mandanten-Modell

- **Status:** angenommen
- **Datum:** 2026-09-25, Geltungsbereich von Punkt 5 am 2026-09-26 dokumentiert (Stand Code Phase 0, vor dem ersten Deploy),
  am 2026-09-28 um Referenzdaten (`fx_rates`) ergänzt, am 2026-09-29 um gespeicherte Ansichten (`saved_views`),
  am 2026-10-07 um die Suchbegriff-Regeln (`search_term_rules`) und geschützte Begriffe, am 2026-10-08 um die
  abweichenden Regeln je Profil (`search_term_rule_overrides`) und die Änderungen an Amazon-Werbung (`ad_changes`),
  am 2026-10-09 um die Harvest-Merkliste (`search_term_harvest_marks`) und eigene Tags (`tags`, `tag_assignments`),
  am 2026-10-10 um Benachrichtigungen (`notifications`, `notification_reads`),
  am 2026-10-11 um das Audit-Log, die Freigaben je Client (`member_client_grants`) und die Kunden-Org
  (`clients.client_organization_id`), am 2026-10-12 um den Plattform-Admin, die Impersonation und die Seller-Konten (Phase 7)
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
  `amazon-ads-entities.ts`, `amazon-ads-metrics.ts`, `ad-change-processing.ts`, `maintenance.ts`, `key-rotation.ts`; `job_runs` schreibt
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
  (`querySearchTermPeriod` nach `visibleProfilesScope()`). Kunden-Orgs sehen sie nicht (Phase 6, F1: die Suchbegriff-Analyse ist für sie gesperrt).
  Einen Datei-Zeitraum der Suchbegriffe löschen (2b.2d, `deleteSearchTermPeriod`) dürfen nur Org-Admins für ein
  sichtbares Profil (`orgAdminOnly` wie der Datei-Upload, dazu Feature `sp-explorer`), mit Audit-Event.
  Abweichende Regeln je Profil (2b.2g, `search_term_rule_overrides`) gehören der Organisation des Profils; gelesen
  werden sie nur mit einem sichtbaren Profil (`querySearchTermPeriod`), geschrieben über `saveSearchTermRuleOverrides`
  nach `visibleProfilesScope()` mit Recht `write` im Feature `sp-explorer` (prüft die API), mit Audit-Event.
- **Änderungen an Amazon-Werbung** (ab Phase 3, 3.1 und 3.3): `ad_changes` und `ad_change_submissions` gehören der
  Organisation des Profils. Nutzer lesen und schreiben nur über `visibleProfilesScope()` (`ad-changes.ts`: Warenkorb je
  Nutzer, Übermittlungen für die ganze Organisation; `ad-change-actions.ts`: erneut versuchen, verwerfen, Revert,
  Abschließen von Hand; `ad-change-queries.ts`: offene Änderungen, Verlauf, Zeilen der Bulk-Datei), mit Audit-Event; das Recht `write` im Feature `changes` prüft die API. Der Job
  `ad-changes-submit` und die Bestätigung durch den Import arbeiten als Systemzugriff (`ad-change-processing.ts`),
  gebunden an Organisation und Connection bzw. Profil.
- **Harvest-Merkliste** (ab Phase 3, 3.8): `search_term_harvest_marks` gehört der Organisation des Profils. Vormerken,
  Lesen und Entfernen nur über `visibleProfilesScope()` (`search-term-harvest.ts`), mit Audit-Event; Quelle und
  Kennzahlen liest der Server aus den Suchbegriffen des Profils, nie aus der Anfrage. Das Recht (`write` bzw. `view`
  im Feature `sp-explorer`) prüft die API.
- **Eigene Tags** (ab Phase 3, 3.7): `tags` gehören der Organisation (für alle Mitglieder lesbar, `tags.ts`),
  `tag_assignments` der Organisation des Profils der Entity. Zuweisen und Lösen nur für Entities sichtbarer Profile
  (`visibleProfilesScope()`), Zähler nur über sichtbare Profile, mit Audit-Event; das Recht (`write` bzw. `view` im
  Feature `tags`) prüft die API. Der Tag-Filter der Auswertungen (`ads-analytics.ts`) wirkt nur innerhalb der
  sichtbaren Profile der Auswahl: Ein Tag einer fremden Organisation trifft dort nichts.
- **Benachrichtigungen** (ab Phase 5, 5.2a): `notifications` gehört der Organisation, optional einem Profil bzw.
  einer Connection. Erzeugt werden sie als Systemzugriff in der Transaktion des Auslösers (Import, Übermittlung) bzw.
  vom plattformweiten Job `notifications-check` (`notification-sources.ts`). Gelesen, gezählt und gelesen gesetzt
  werden sie nur über `notifications.ts`: Profil sichtbar nach `visibleProfilesScope()` (Admins auch ausgeblendete),
  ohne Profil Mitgliedschaft (`getOrgRole()`), dazu der Empfängerkreis (`audience`). Der SSE-Kanal der API prüft das je
  Ereignis neu; `pg_notify` trägt nur IDs.
- **Audit-Log** (ab Phase 6, 6.1): `audit_events` sind keine Profildaten. Gelesen werden sie nur über `listAuditEvents`
  (`audit.ts`) für die aktive Organisation hinter `orgAdminOnly`; plattformweite Ereignisse gehören nicht dazu.
- **Freigaben je Client** (ab Phase 6, 6.2): `member_client_grants` gehört der Organisation. Der Access-Layer wertet sie
  in `visibilityConditions` aus (Mitglied mit Freigaben: nur Profile dieser Clients, auch keine ohne Client; ohne
  Freigaben: alle; Admins: alle); gepflegt werden sie in der Mitgliederverwaltung (`setMemberClientGrants`, Audit
  `member.grants_update`). Für Client-Daten **ohne** Profil gibt es `visibleClientIds()`: Der Struktur-Katalog zeigt
  und ändert Presets je Client nur für sichtbare Clients. Bewusst org-weit bleiben für Eingeschränkte: Regeln der
  Automatik (nennen Clients nur als ID), Katalog, Tags, die Zähler „Produktgruppen je Preset“ (nur Zahlen) und
  Benachrichtigungen ohne Profil. Ein Client mit Freigaben lässt sich in der DB nicht löschen (kein `cascade`).
- **Kunden-Org** (ab Phase 6, 6.3a): `clients.client_organization_id` (eindeutig) verknüpft eine Organisation mit
  `type = client` mit genau einem Client der Eigentümer-Org. Der Access-Layer wertet das in `getMembership` aus:
  Mitglieder der Kunden-Org sehen die nicht ausgeblendeten, nicht entfernten Profile dieses Clients (`organization_id`
  der Eigentümer-Org), nie mit `includeHidden`/`includeRemoved`; `visibleClientIds()` nennt nur diesen Client; ohne
  Verknüpfung sehen sie nichts. Ihre Rolle gilt immer als `viewer` (`getOrgRole()`, `listMemberships()`), egal was
  gespeichert ist, damit gibt es nie `write` und keine Admin-Routen. Zusätzlich lässt die API für Kunden-Orgs nur
  ausdrücklich freigegebene Pfade zu (`isOpenForCustomerOrgs` in `requireSession`, sonst 403
  `CUSTOMER_ORG_FORBIDDEN`): Neue Routen sind für Kunden geschlossen, bis sie eingetragen und mit zweitem Client
  getestet sind (`customer-org.test.ts` läuft über alle registrierten Routen). Abfragen, die eigene Tabellen nach
  `organization_id = aktive Organisation` filtern, liefern für Kunden weiterhin nichts. Freigegeben sind seit 6.3b die
  Auswertungen für Dashboard und Explorer: Der Datenstand liest dafür die Läufe (`job_runs`) der Eigentümer-Org des
  sichtbaren Profils; Tags zählen in den Auswertungen nur für die aktive Organisation.
- **Kundenzugang verwalten** (ab Phase 6, 6.3c): Org-Admins der Eigentümer-Org verwalten die Mitglieder der
  Kunden-Org eines **eigenen** Clients (`clientAccessScope` in `members.ts` prüft `clients.organization_id` = aktive
  Organisation, Routen `/api/clients/{id}/access` hinter `orgAdminOnly`). Das ist der einzige Zugriff auf
  Mitgliedschaften einer anderen Organisation; das Audit dazu steht bei der Eigentümer-Org (`client_access.*`).
- **Plattform-Admin** (ab Phase 6, 6.4): `packages/db/src/platform.ts` liest und schreibt Organisationen,
  Entitlements und die Plattform-Rolle über alle Organisationen hinweg, ohne Org-Kontext; die Routen
  (`/api/platform/*`) verlangen `requireSuperadmin()`. Profildaten liest er nicht. Audit `platform.*` trägt die
  betroffene Organisation, Staff-Ereignisse keine (plattformweit, nur im Plattform-Admin sichtbar).
- **Impersonation** (ab Phase 6, 6.5): Ein Superadmin bekommt über `/api/platform/impersonation` eine eigene
  Session des Nutzers (`sessions.impersonated_by`, höchstens eine Stunde). Der Access-Layer sieht den Nutzer:
  Es gelten dessen Mitgliedschaften, Freigaben und Grenzen, keine weiteren. Jedes Audit-Event nennt den Superadmin
  als Handelnden und den Nutzer im `target` (`runAsImpersonator` in `audit.ts`); Mitgliederverwaltung,
  Kundenzugang und Plattform-Routen sind währenddessen gesperrt.
- **Seller-Konten** (ab Phase 7, 7.2): `amazon_sp_accounts` gehören der Organisation der SP-Connection. Nutzer sehen
  sie nur über `visibleSellerAccountsScope()` bzw. `canSeeSellerAccount()` mit denselben Regeln wie Profile
  (Freigaben je Client, Kunden-Org, ausgeblendet/entfernt nur für Admins). SP-Connections und ihre Zugangsdaten
  (`amazon_sp_credentials`) verwaltet die Eigentümer-Org hinter `orgAdminOnly` (`seller-accounts.ts`,
  `routes/seller-connections.ts`); der SP-Client liest die Zugangsdaten als Systemzugriff, gebunden an Organisation
  und Connection.
- **Auth- und Organisationsdaten:** Mitglieder und Einladungen über better-auth mit eigener Zugriffskontrolle;
  Rollen, Mitgliedschaften und Entitlements über `getOrgRole()`, `listMemberships()` und `listEnabledFeatures()` im
  Access-Layer; dazu der Seed.

**Entschieden in Phase 6 (F1, 2026-10-11):** Kunden-Orgs lesen nur Dashboard und Explorer (Kennzahlen ihrer Profile).
Client-Daten der Agentur (Ziele, Budgets, Regeln, geschützte Begriffe, Tags, Ansichten, Benachrichtigungen) sehen sie
nicht; der Helfer für Clients ist `visibleClientIds()`. Freigaben einzelner Profile an Kunden (`profile_grants`) und
mehrere Clients je Kunden-Org kommen erst bei Bedarf.

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
  und `canSeeProfile()`, für Clients `visibleClientIds()`, dazu `getOrgRole()`, `listMemberships()` und `listEnabledFeatures()`. Ausgeblendete und entfernte Profile sehen nur Org-Admins (`includeHidden`, `includeRemoved`).

## Verworfene Alternativen

- **Daten gehören der Kunden-Org:** Jede Amazon-Connection müsste pro Kunde laufen oder Daten müssten
  zwischen Orgs verschoben werden. Das widerspricht dem Agentur-Alltag (ein Login sieht viele Kundenkonten).
- **Kunden als Mitglieder der Agentur-Org:** Einfach, aber Entitlements und Rollen ließen sich nicht pro Kunde
  steuern, und ein Kunde könnte über Fehler in Abfragen fremde Profile sehen.
