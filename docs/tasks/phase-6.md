# Phase 6 – Steuern

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§2 Roadmap, §3 Navigation, §4 Rollen, §5), `docs/decisions/002-tenancy.md`
> (Entscheidung Punkte 3–5, „Offen für Phase 6“), `docs/tasks/phase-0.md` (0.4: better-auth-Allowlist, Audit-Hooks; 0.6
> „Offen für Phase 6“), `docs/tasks/phase-2.md` (2.4 „Offen für Phase 6“, 2.10 Mitgliederverwaltung), `docs/tasks/phase-5.md`
> („Offen nach Phase 5“), `design/DESIGN.md`.
>
> **Status: verfeinert (2026-10-11), Fragen F1–F7 entschieden (die Nummern gelten nur in dieser Datei). Fertig: 6.1–6.6; Phase 6 ist abgeschlossen (offene Punkte unter „Offen nach Phase 6“).**
>
> **Ausgangslage (Stand Code, 2026-10-11):**
> - Es gibt genau eine Organisation (Muuv, `type = internal`). `organizations.type` kennt `client`, benutzt wird es nicht.
> - Der Access-Layer (`packages/db/src/access.ts`) entscheidet über sichtbare Profile nur nach Mitgliedschaft, `is_hidden`
>   und `removed_at`; rund 90 Aufrufe in `packages/db` und `apps/api` laufen darüber. Viele Abfragen filtern daneben
>   eigene Tabellen nach `organization_id = aktive Organisation` (zulässig nach ADR 002, „Geltungsbereich“).
> - `audit_events` wird seit Phase 0 von jeder schreibenden Aktion gefüllt (Index `organization_id, created_at desc`),
>   eine Oberfläche gibt es nicht. `target` ist freies JSON (`{ type, id, … }`).
> - Das Admin-Plugin von better-auth ist eingerichtet (`superadmin`), per HTTP aber gesperrt (Allowlist in `app.ts`);
>   `requireSuperadmin()` existiert, wird aber von keiner Route benutzt. Der Seed-Admin ist Superadmin.
> - `/admin/audit` und `/admin/platform` sind Platzhalterseiten; der Wechsel der Organisation im Account-Menü existiert.
> - Mitgliederverwaltung (2.10) kennt nur die eigene Organisation; Nutzer mit Mitgliedschaft in einer zweiten Organisation
>   sind dort gesperrt (`OTHER_ORGANIZATION`).

## Ziel

Die Agentur behält die Kontrolle darüber, **wer was sieht und wer was getan hat**:
- **Audit-Log** (`/admin/audit`): Org-Admins sehen, wer wann was geändert hat, filterbar.
- **Profil-Freigaben je Mitglied**: Mitglieder der Agentur lassen sich auf einzelne Clients bzw. Profile einschränken.
- **Kundenzugang**: Ein Kunde bekommt einen eigenen Login (Kunden-Org, `type = client`) und sieht **nur lesend** die
  Profile seines Clients. Die Daten bleiben bei der Agentur-Org (ADR 002).
- **Plattform-Admin** (`/admin/platform`, nur Superadmin): Organisationen, Entitlements, Staff.
- **Impersonation**: Ein Superadmin sieht die App als ein bestimmter Nutzer, sichtbar gekennzeichnet und protokolliert.

## Definition of Done

Geprüft in 6.6 (2026-10-12); hinter jedem Punkt der Beleg.

- [x] Sichtbarkeit entscheidet weiter **nur** der Access-Layer (ADR 002 Punkt 5); seine Signaturen (`userId`, `orgId`)
      bleiben. Keine Route prüft Freigaben oder Kunden-Orgs selbst.
      *Beleg:* Freigaben und Kunden-Org stecken in `getMembership`/`visibilityConditions` (`access.ts`); in `apps/api`
      kennt nur `requireSession` den Typ der Organisation (Pfad-Liste als zweites Netz, keine Sichtbarkeit) und
      `routes/members.ts` reicht den Client an `clientAccessScope` weiter.
- [x] **Fail-closed:** Ein Kunden-Login sieht ausschließlich Daten der Profile seines Clients, ein eingeschränktes
      Mitglied nur seine Freigaben. Test je freigegebenem Endpunkt (fremder Client, fremde Organisation, ausgeblendetes
      Profil, entzogene Freigabe) und ein Test über **alle** registrierten Routen: Für einen Kunden-Login antwortet jede
      schreibende Route und jede nicht freigegebene lesende Route mit 403 oder liefert nichts.
      *Beleg:* `customer-org.test.ts` (alle Routen, auch die neuen aus 6.4/6.5), `routes/analytics-customer.test.ts`,
      `access-client-org.test.ts`, `access-grants.test.ts`.
- [x] Kunden-Orgs sind lesend: keine schreibende Aktion, unabhängig von der Rolle des Mitglieds.
      *Beleg:* `getOrgRole()`/`listMemberships()` liefern immer `viewer`; `customer-org.test.ts` mit Rolle `admin`.
- [x] Entitlements gelten je Organisation (ADR 002 Punkt 4): Der Kunde sieht nur, was für seine Org gebucht ist.
      *Beleg:* `CUSTOMER_ORG_FEATURES` beim Anlegen (6.3c), Buchen im Plattform-Admin (6.4, für Kunden-Orgs begrenzt).
- [x] Jede schreibende Aktion dieser Phase erzeugt ein `audit_event` (Freigaben, Kundenzugang anlegen und entziehen,
      Organisationen, Entitlements, Staff, Beginn und Ende einer Impersonation). Aktionen während einer Impersonation
      nennen den handelnden Superadmin.
      *Beleg:* `member.grants_update`, `client_access.*`, `platform.*`; `runAsImpersonator` (`audit.test.ts`,
      `routes/impersonation.test.ts`). Ausnahme: kein Ende-Ereignis bei Ablauf oder Abmelden (siehe unten).
- [x] Das Audit-Log zeigt nie Secrets (Tokens, Passwörter, Links) und nur Ereignisse der eigenen Organisation;
      plattformweite Ereignisse sieht nur der Superadmin.
      *Beleg:* `withoutSecrets` (`audit.test.ts`), `routes/audit-events.test.ts`, `GET /api/platform/audit-events`.
- [x] Better-auth-Endpunkte des Admin-Plugins bleiben per HTTP gesperrt; die App nutzt eigene Routen mit Audit
      (`phase-0.md` 0.4).
      *Beleg:* Allowlist in `app.ts` unverändert, `middleware.test.ts` (`/api/auth/admin/set-role` → 404).
- [x] Ein Superadmin kann sich nicht selbst die Rolle nehmen, wenn er der letzte ist; Impersonation eines anderen
      Superadmins ist nicht möglich.
      *Beleg:* `platform.test.ts` (`LAST_SUPERADMIN`), `routes/impersonation.test.ts` (`IMPERSONATION_SUPERADMIN`).
- [x] Jede neue Datenansicht hat Loading-, Empty- und Error-Zustand; Texte über i18n; Formularfelder mit Label.
      *Beleg:* `AuditLogPage`, `ClientAccessDialog`, `PlatformPage` samt Tests.
- [ ] Browser-Pane geprüft wie in Phase 2–5 (1440 px, Tablet, Handy, Hell/Dunkel, Konsole), mit echten Bedienelementen;
      angelegte Testdaten über die Oberfläche wieder entfernt oder genau benannt.
      *Stand:* je Aufgabe geprüft und notiert (Handy, Tablet, Hell/Dunkel, Konsole, echte Bedienelemente, Reste
      benannt). **Offen: 1440 px** – die Browser-Pane war in allen Sessions schmaler (siehe „Offen nach Phase 6“).
- [x] `pnpm test`, `typecheck`, `lint`, `build`, beide Smoke-Tests und CI grün.
      *Beleg:* vor jedem PR gelaufen (zuletzt 3354 Tests), CI der PRs dieser Phase grün (zuletzt 110; 111 mit Auto-Merge).

## Fragen an Dominik

Gestellt zu Beginn der Session (2026-10-11), jede mit Empfehlung.

- **F1 – Was sieht ein Kunde?** Empfehlung: Dashboard und Explorer, nur lesend (Kennzahlen, Drill-Down, Chart, Grid).
  Weitere Bereiche (Budgets/Pacing, Ziele) erst, wenn sie gebraucht werden: Jede Seite muss einzeln „kundensicher“
  gemacht werden, weil ihre Einstellungen der Agentur gehören. Alternativen: zusätzlich Budgets und Ziele lesend; oder
  je Kunden-Org frei wählbar aus allen Features.
  **Entschieden (Dominik, 2026-10-11): Dashboard und Explorer, wie empfohlen.**
- **F2 – Profil-Freigaben für Agentur-Mitglieder: wie fein?** Empfehlung: je **Client** (ein eingeschränktes Mitglied
  sieht alle Profile der ihm zugeordneten Clients, neue Profile des Clients automatisch). Alternativen: je einzelnem
  Profil (`plan.md` §4 nennt Profile; mehr Pflege) oder jetzt gar nicht (Muuv hat heute nur wenige Mitglieder).
  **Entschieden (Dominik, 2026-10-11): je Client, wie empfohlen.** `plan.md` §4 wird in 6.2 angepasst.
- **F3 – Wer legt Kundenzugänge an?** Empfehlung: der Org-Admin der Agentur unter „Clients & Connections“ am Client
  („Kundenzugang“: Nutzer mit E-Mail anlegen, Link zum Passwortsetzen wie in 2.10). Die Kunden-Org entsteht dabei
  automatisch. Alternative: nur der Superadmin im Plattform-Admin.
  **Entschieden (Dominik, 2026-10-11): der Org-Admin am Client, wie empfohlen.**
- **F4 – Impersonation: was darf sie?** Empfehlung: Der Superadmin sieht die App als der Nutzer, **nur lesend**
  (schreibende Anfragen werden abgelehnt), höchstens eine Stunde, mit Banner „Du siehst die App als …“ und „Beenden“,
  Beginn und Ende im Audit-Log. Alternative: volle Rechte des Nutzers, jede Aktion im Audit mit dem Superadmin.
  **Entschieden (Dominik, 2026-10-11): volle Rechte des Nutzers** (abweichend von der Empfehlung). Folgen in 6.5:
  Jedes Audit-Event während einer Impersonation nennt den Superadmin als Handelnden und den Nutzer, als der er
  gehandelt hat; Banner und Zeitgrenze bleiben.
- **F5 – Plattform-Admin: Umfang.** Empfehlung: Organisationen (Liste, anlegen, umbenennen), Entitlements je
  Organisation (Schalter je Feature-Key), Staff (Superadmin-Rolle vergeben und entziehen), dazu „Als Nutzer ansehen“.
  Nicht: Organisation löschen, Nutzer sperren, Abrechnung. Alternative: zusätzlich Nutzer sperren (Ban des Admin-Plugins).
  **Entschieden (Dominik, 2026-10-11): Orgs, Entitlements, Staff, wie empfohlen.**
- **F6 – Modus „aus“ der Automatik** löscht beim nächsten Lauf die offenen Warenkorb-Zeilen der Automatik (Festlegung
  von Claude in 5.13a). Empfehlung: so lassen („aus“ heißt: nichts von der Automatik liegt herum; von Hand gelegte
  Zeilen bleiben). Alternative: Zeilen behalten.
  **Entschieden (Dominik, 2026-10-11): so lassen.**
- **F7 – Glättung des Optimizers (12 Klicks) und Spanne der Pacing-Schätzung** sind Konstanten. Empfehlung: Konstanten
  lassen, bis 5.12 zeigt, ob sie passen. Alternative: als Einstellung je Organisation (eigene Aufgabe vor 6.1).
  **Entschieden (Dominik, 2026-10-11): Konstanten lassen.**

**Ohne Frage geklärt (Dev-DB, 2026-10-11, nur Zähler gelesen):** `amazon_ads_entity_period_metrics` und
`automation_runs` sind leer, der einzige Import ist vom 2026-10-07. Damit bleiben **5.12** und die **Prüfung mit echten
Daten** offen (`phase-5.md` „Offen nach Phase 5“); ProfitBash ist noch nicht live, Wochen mit Läufen kann es nicht geben.

## Aufgaben (nach F1–F7, 2026-10-11)

**Begriffe:** **Eigentümer-Org** = die Agentur-Org, der Profile und Daten gehören. **Kunden-Org** = Organisation mit
`type = client`, verknüpft mit genau einem Client der Eigentümer-Org. **Freigabe** = Zuordnung eines Agentur-Mitglieds
zu Clients (bzw. Profilen, F2); ein Mitglied ohne Freigaben sieht wie bisher alles. **Staff** = Nutzer mit der
Plattform-Rolle `superadmin`.

**Festlegungen von Claude (2026-10-11; Dominik kann widersprechen):**
- **Kunden-Org ↔ Client:** Spalte `clients.client_organization_id` (ADR 002 Punkt 3), eindeutig: eine Kunden-Org gehört zu
  genau einem Client. Mehrere Clients für einen Kunden oder Freigaben einzelner Profile an Kunden
  (`profile_grants(grantee_organization_id, profile_id)` aus ADR 002) kommen erst bei Bedarf.
- **Regel im Access-Layer:** Für eine Kunden-Org liefert `visibleProfilesScope()` die nicht ausgeblendeten, nicht
  entfernten Profile des verknüpften Clients; `includeHidden`/`includeRemoved` sind dort nie erlaubt. Abfragen, die
  daneben nach `organization_id = aktive Organisation` filtern, liefern für Kunden nichts (fail-closed) und werden je
  freigegebener Seite (F1) einzeln umgestellt, mit Test.
- **Kunden-Mitglieder** haben immer die Rolle `viewer`; `write` ist für Kunden-Orgs zusätzlich in
  `resolveFeatureAccess` bzw. `requireFeature` gesperrt, damit ein falsch gesetzter Rollenwert nichts öffnet.
  Admin-Seiten (Connections, Mitglieder, Sync, Audit) gibt es für Kunden-Orgs nicht.
- **Was Kunden nie sehen:** Regeln, Leitplanken, Vorschläge, Warenkorb, Tags, gespeicherte Ansichten und Benachrichtigungen
  der Agentur, geschützte Begriffe, andere Clients. Eigene gespeicherte Ansichten der Kunden-Org sind erlaubt (gehören
  der Kunden-Org, der Access-Layer filtert ihren Inhalt schon heute).
- **Eingeschränkte Mitglieder** (F2): gilt für `editor` und `viewer`; Admins sehen immer alles. Schreibrechte bleiben
  an der Rolle, nur die Menge der Profile schrumpft. Org-weite Daten (Regeln, Katalog, Tags) bleiben für sie lesbar.
- **Audit-Log:** keine Löschfrist, kein Export, keine Volltextsuche im `target`; Filter nach Zeitraum, Nutzer und
  Bereich (Präfix der Aktion). Seitenweise per Cursor (`created_at`, `id`), nie alles laden.
- **Impersonation:** eigene Routen statt der gesperrten better-auth-Endpunkte; die Session trägt `impersonated_by`
  (Spalte des Admin-Plugins; beim Bau prüfen, ob sie im Schema steht). Audit-Events aus einer solchen Session nennen
  den Superadmin als `actor_user_id` und den Nutzer im `target` (`impersonatedUserId`); das Audit-Log (6.1) zeigt beides.

### 6.1 Audit-Log (`/admin/audit`)
- [x] `packages/db/src/audit.ts`: `listAuditEvents(db, { orgId, from, to, actorUserId, area, cursor, limit })` mit Name
      und E-Mail des Handelnden (auch „System“ bei `actor_user_id` leer, „gelöschter Nutzer“), neueste zuerst, Cursor.
      Liste der Bereiche und Handelnden für die Filter aus den vorhandenen Ereignissen.
- [x] `GET /api/audit-events` hinter `orgAdminOnly` (nur aktive Organisation; fremde Organisation, Editor → 403), zod für
      Query und Antwort, `pnpm api:generate`.
- [x] Seite: Tabelle (Zeit in der Zeitzone des Browsers, Nutzer, Aktion als lesbarer Text über i18n mit Rückfall auf den
      Schlüssel, Objekt), Details des `target` aufklappbar, Filterleiste, „Mehr laden“; Loading, Empty, Error.
- [x] Test, dass kein bekanntes Secret-Feld im `target` landet (Stichprobe über die vorhandenen Aufrufer von
      `recordAuditEvent`: Token, Passwort, Link).
- **Umsetzung (2026-10-11):**
  - `packages/db/src/audit.ts`: `listAuditEvents` (Organisation als Zugriffsregel wie bei Jobläufen, ADR 002; Filter
    Zeitraum `from` einschließlich / `to` ausschließlich, Handelnder, Bereich = Teil der Aktion vor dem Punkt als
    ganzer Vergleich, kein Muster) und `listAuditEventFilters` (vorkommende Bereiche und Handelnde). Der Cursor ist die
    ID der letzten Zeile und wird in der DB aufgelöst (volle Zeitauflösung, nur in derselben Organisation).
  - `GET /api/audit-events` und `/api/audit-events/filters` hinter `orgAdminOnly`, 50 je Seite (`AUDIT_EVENT_PAGE_SIZE`).
  - **Secrets:** Statt einer Stichprobe über die Aufrufer entfernt `listAuditEvents` beim Lesen alle Felder, deren Name
    `token`, `password` oder `secret` enthält, auch verschachtelt (zweites Netz, mit Test). In der Dev-DB und im Code
    gibt es heute kein solches Feld im `target`.
  - `pages/AuditLogPage.vue`: Filter stehen in der URL (`?area=&actor=&from=&to=`, Tage in der Zeitzone des Browsers,
    ungültige Werte gelten als „Alle“), Aktionen und Bereiche als Text über `audit.action.*` / `audit.area.*` (Punkt
    als `:`), unbekannte als Schlüssel; Details als aufklappbares JSON; „Ältere laden“.
  - **Abweichung:** Ereignisse ohne Nutzer und solche gelöschter Nutzer zeigen beide „System“ (`actor_user_id` ist in
    beiden Fällen leer). Plattformweite Ereignisse (`organization_id` leer) zeigt erst der Plattform-Admin (6.4).
  - Browser-Pane geprüft mit den 69 Ereignissen der Dev-DB (nur gelesen, nichts angelegt): Liste, Filter Bereich
    (echtes Auswahlfeld), „Ältere laden“, Details, Handy (375 px) und Tablet ohne waagerechtes Scrollen, Dunkel,
    Konsole leer. Nicht geprüft: 1440 px (Pane schmaler), Zeitraum-Auswahl von Hand (per Test abgedeckt).
  - Review (ponytail): keine Befunde zum Beheben. Bewusst so: Die Filterauswahl liest alle Ereignisse der Organisation
    (`distinct`), bei sehr großen Logs eigene Tabelle oder Cache.

### 6.2 Profil-Freigaben je Mitglied (F2)
- [x] Tabelle `member_client_grants` (Mitglied, Client, Organisation; zusammengesetzte Fremdschlüssel wie üblich).
      Migration. `plan.md` §4 anpassen (Freigaben je Client statt je Profil, F2).
- [x] Access-Layer: Hat ein Mitglied (nicht Admin) Freigaben, begrenzt `visibilityConditions` auf Profile dieser
      Clients. Tests in `access.test.ts` (ohne Freigabe alles, mit Freigabe nur diese, Admin immer alles, Profil ohne
      Client für Eingeschränkte unsichtbar).
- [x] Prüfen, welche nutzerseitigen Abfragen Profildaten **ohne** Profil-Scope lesen (nur nach Organisation): Befunde
      beheben oder als Ausnahme in ADR 002 begründen. Benachrichtigungen mit Profil folgen schon dem Scope.
- [x] API und Oberfläche in der Mitgliederverwaltung: „Zugriff: alle Clients / ausgewählte“, Audit `member.grants_update`.
- **Umsetzung (2026-10-11):**
  - Migration `0048_member_client_grants`: Mitglied (`members.id`, mit der Mitgliedschaft gelöscht), Client
    (zusammengesetzter FK mit der Organisation, **ohne** `cascade`: Ein Client mit Freigaben lässt sich nicht löschen,
    sonst sähe ein Mitglied nach dem Löschen seines letzten Clients plötzlich alles).
  - Access-Layer: `visibilityConditions` hängt für Nicht-Admins eine Bedingung an („keine Freigaben oder Client
    freigegeben“), damit gilt sie in allen Abfragen über `visibleProfilesScope()`, `canSeeProfile()` und
    `listVisibleClientsAndProfiles()`. Neu `visibleClientIds()` (`null` = alle) für Client-Daten ohne Profil.
  - **Abfragen ohne Profil-Scope geprüft** (alle direkten Zugriffe auf `clients`): Der Struktur-Katalog listete alle
    Clients und ließ Presets fremder Clients setzen → behoben (`getStructureCatalog`, `setClientPreset`, mit Test).
    Bewusst org-weit (ADR 002 ergänzt): Regeln der Automatik (Clients nur als ID), Katalog, Tags, Zähler
    „Produktgruppen je Preset“, Benachrichtigungen ohne Profil. Clients, Connections, Sync-Status und Audit-Log sind
    ohnehin nur für Admins.
  - `setMemberClientGrants` (ersetzt die Liste, leer = alle; `UNKNOWN_CLIENT` für fremde Clients; Audit
    `member.grants_update` mit vorher/nachher nur bei Änderung), `PUT /api/members/{id}/client-grants` hinter
    `orgAdminOnly`, `Member.clientIds`.
  - Mitgliederverwaltung: Auswahl „Zugriff“ je Zeile unter der Rolle (nur bei Editor und Viewer; Platzhalter „Alle
    Clients“), speichert bei jeder Änderung. Freigaben eines Admins bleiben gespeichert, wirken aber nicht.
  - Browser-Pane geprüft: Test-Mitglied angelegt, Client über das echte Auswahlfeld freigegeben (API zeigt die
    Freigabe), Handy ohne waagerechtes Scrollen, Dunkel; Mitglied über die Oberfläche wieder entfernt. **Reste in der
    Dev-DB:** Nutzer `pruefung-6-2@muuv.test` (ohne Mitgliedschaft) und drei Audit-Events (`member.create`,
    `member.grants_update`, `member.remove`). Nicht geprüft: Anmeldung als eingeschränktes Mitglied im Browser (per
    API-Test abgedeckt: Filterauswahl zeigt nur den freigegebenen Client).
  - Review (ponytail): keine Befunde zum Beheben. Bekannte Grenze: Legt ein Admin einen neuen Client an, sehen ihn
    Eingeschränkte nicht, bis er freigegeben wird (gewollt).

### 6.3a Kunden-Org: Modell und Access-Layer
- [x] `clients.client_organization_id` (eindeutig, FK auf `organizations`), Migration; ADR 002 ergänzen
      („Offen für Phase 6“ auflösen).
- [x] Access-Layer nach der Festlegung oben; `listVisibleClientsAndProfiles` liefert für Kunden genau ihren Client
      (`phase-2.md` 2.4). Tests: Kunde sieht nur seinen Client, nie Ausgeblendetes, nie mit `includeHidden`.
- [x] `resolveFeatureAccess`/`requireFeature`: Kunden-Org nie `write`; `/api/me` nennt den Typ der aktiven Organisation
      (steht schon in `organizations[].type`).
- [x] Test über alle registrierten Routen mit einem Kunden-Login (Definition of Done, fail-closed).
- **Umsetzung (2026-10-11):**
  - Migration `0049_client_organization`: `clients.client_organization_id` (FK auf `organizations`, `set null` beim
    Löschen der Kunden-Org, eindeutiger Index).
  - Access-Layer (`getMembership`): Kunden-Org = Typ `client` **oder** verknüpft (ein falsch gesetzter Wert allein
    öffnet nichts). Regel wie festgelegt; ohne Verknüpfung sieht die Kunden-Org nichts. `visibleClientIds()` nennt nur
    den verknüpften Client. `listVisibleClientsAndProfiles` filtert die Clients nicht mehr nach `orgId` (die IDs
    stammen aus dem Scope).
  - **Nie `write`:** Statt `resolveFeatureAccess` zu ändern, liefern `getOrgRole()` und `listMemberships()` für
    Kunden-Orgs immer `viewer`. Damit gilt es an allen Stellen (`requireFeature`, `requireRole`, `orgAdminOnly`,
    `/api/me`, Routen mit eigener Rollenprüfung), auch bei falsch gespeicherter Rolle.
  - **Fail-closed über alle Routen:** `requireSession` lässt für eine aktive Kunden-Org nur freigegebene Pfade zu
    (`isOpenForCustomerOrgs` in `middleware.ts`; heute `/api/me` und `/api/settings*`), sonst 403
    `CUSTOMER_ORG_FORBIDDEN`. `apps/api/src/customer-org.test.ts` ruft jede registrierte Route als Kunde auf (alle
    Features gebucht, Rolle falsch auf `admin`): 403, kein Text des zweiten Clients, kein neues Audit-Event. Eine
    neue Route ist damit für Kunden zu, bis sie in Middleware **und** Test eingetragen ist (6.3b: Auswertungen).
  - **Abweichungen / offen:** Eigene gespeicherte Ansichten der Kunden-Org (Festlegung „erlaubt“) sind noch nicht
    freigegeben; sie brauchen `write`, das Kunden nie haben. Bei Bedarf in 6.3b entscheiden. Persönliche
    Einstellungen (`PUT /api/settings`, Audit ohne Organisation) dürfen Kunden ändern. Tests, die eine zweite
    **Agentur** mit `type: 'client'` anlegten, nutzen jetzt `internal` (`access.test.ts`).
  - Keine Änderung an der Oberfläche (folgt in 6.3b), daher keine Browser-Prüfung.

### 6.3b Kunden-Org: freigegebene Seiten (F1)
- [x] Dashboard und Explorer (Auswertungs-Endpunkte, Filteroptionen, Währungen) für Kunden-Logins: Abfragen, die nach
      der aktiven Organisation filtern, auf den Profil-Scope umstellen; je Endpunkt Test mit zweitem Client.
- [x] Web: Shell für Kunden-Orgs (nur gebuchte Einträge, keine Platzhalter späterer Phasen, kein Warenkorb, keine
      Quick-Tools, keine Glocke); Bedienelemente zum Bearbeiten im Explorer hängen bereits an `write`.
- [x] Browser-Prüfung als Kunde (mit 6.3c: Erst dort lässt sich ein Kundenzugang über die Oberfläche anlegen
      und wieder entfernen; Ergebnis in der Notiz zu 6.3c).
- **Umsetzung (2026-10-11):**
  - **Freigegeben** (`CUSTOMER_ORG_PATHS` in `middleware.ts`): `POST /api/ads/filter-options`, `/dashboard`,
    `/explorer/rows`, `/timeseries`. Die ASIN-Suche (Quick-Tool) und alles andere bleiben zu.
  - **Abfragen:** Die Auswertungen liefen schon über `visibleProfilesScope()`. Umgestellt: „Letzter Sync“ im
    Datenstand liest die Läufe der Eigentümer-Org des Profils statt der aktiven Organisation
    (`queryDashboardStatus`); Tags in den Explorer-Zeilen und der Tag-Filter zählen nur Zuweisungen der aktiven
    Organisation (Kunden sehen und filtern keine Tags der Agentur).
  - **Tests:** `routes/analytics-customer.test.ts` je Endpunkt mit zweitem Client, zweiter Kunden-Org,
    ausgeblendetem Profil, gelöster Verknüpfung; `customer-org.test.ts` führt die vier Pfade als freigegeben.
  - **Web:** `isCustomerOrg()`/`useIsCustomerOrg()`; neue Zugriffsart `agency` (Menüeintrag Benachrichtigungen,
    Route Suchbegriff-Analyse). Für Kunden entfallen Glocke und Live-Kanal, Quick-Tools, gespeicherte Ansichten und
    der Reiter „Suchbegriff-Analyse“. Tests in `ExplorerPage.test.ts` und `DashboardPage.test.ts` prüfen, dass ein
    Kunden-Login nur freigegebene Pfade anfragt (`isOpenForCustomers` in `test/fixtures.ts` spiegelt die Liste der API).
  - **Bewusst so:** Die Explorer-Ebene „Suchbegriffe“ (Kennzahlen) bleibt für Kunden sichtbar, die Analyse mit Regeln
    und geschützten Begriffen nicht. Gespeicherte Ansichten für Kunden gibt es nicht (siehe 6.3a).

### 6.3c Kundenzugang verwalten (F3)
- [x] `packages/db`: Kunden-Org zu einem Client anlegen (Typ `client`, Entitlements nach F1), Kunden-Nutzer anlegen
      (Rolle `viewer`, Passwort-Link aus 2.10 wiederverwenden), entziehen (Mitgliedschaft und Sessions beenden),
      Audit `client_access.*`. Ein Nutzer, der schon Mitglied der Agentur ist, kann kein Kunden-Nutzer werden.
- [x] API hinter `orgAdminOnly` der Eigentümer-Org; Oberfläche am Client unter „Clients & Connections“.
- **Umsetzung (2026-10-11):**
  - **Wiederverwendung statt zweiter Verwaltung:** `clientAccessScope()` (`packages/db/src/members.ts`) prüft den
    Client der Eigentümer-Org und liefert die Eingabe für die vorhandenen `listMembers`, `addMember` (immer `viewer`),
    `regeneratePasswordLink` und `removeMember`, mit `orgId` = Kunden-Org. Mit `create` entsteht die Kunden-Org beim
    ersten Nutzer (Name des Clients, Slug `kunde-<clientId>`, Typ `client`, Entitlements `CUSTOMER_ORG_FEATURES` =
    Dashboard und Explorer, Audit `client_access.org_create`).
  - **Audit** steht im Log der Agentur, nicht in dem der Kunden-Org: `client_access.create`, `.link_create`,
    `.remove` (je mit `clientId`), über `recordMemberEvent`. Texte unter `audit.action` / `audit.area`.
  - **API** hinter `orgAdminOnly` (in `routes/members.ts`, teilt Nutzeranlage, Link-URL und Fehlerabbildung):
    `GET`/`POST /api/clients/{id}/access`, `POST …/{memberId}/password-link`, `DELETE …/{memberId}`. Fremder oder
    unbekannter Client und fremde Mitgliedschaft → 404; wer schon irgendwo Mitglied ist → 409 `MEMBER_EMAIL_TAKEN`.
  - **Oberfläche:** Knopf „Kundenzugang“ je Client in der Kachel „Clients“ (`ClientAccessDialog.vue`): Liste mit
    Status, „Neuer Link“, Entziehen mit Rückfrage in der Zeile, Formular zum Anlegen, Link einmalig mit „Kopieren“;
    Loading, Empty, Error.
  - **Browser-Pane geprüft (auch für 6.3b):** Als Admin Kunden-Nutzer für „Kranich (Demo)“ über die echten
    Bedienelemente angelegt, Passwort über den Link gesetzt, als Kunde angemeldet: Sidebar nur Dashboard und Explorer,
    keine Glocke, keine Quick-Tools, keine Ansichten; nur freigegebene Anfragen (`/api/me`, Einstellungen, vier
    Auswertungs-Endpunkte); Explorer zeigt nur Kampagnen von Kranich; `/ads/explorer/search-term-analysis` und
    `/admin/connections` → „Kein Zugriff“; Handy (375 px, hell) und Tablet ohne waagerechtes Scrollen, Konsole ohne
    Fehler außer den erwarteten 401 beim Abmelden. Zugang über die Oberfläche wieder entzogen; das Audit-Log zeigt
    die drei Ereignisse. Nicht geprüft: 1440 px (Pane schmaler), „Link kopieren“ (Zwischenablage), „Neuer Link“ im
    Browser (per Test abgedeckt).
  - **Reste in der Dev-DB:** Nutzer `pruefung-6-3@kunde.test` (ohne Mitgliedschaft, mit Passwort), leere Kunden-Org
    „Kranich (Demo)“ (Typ `client`, verknüpft mit dem Client, zwei Entitlements), Audit-Events
    `client_access.org_create`, `.create`, `.remove` bei der Agentur und `member.password_set` der Kunden-Org.
  - **Bewusst nicht:** Kunden-Org wieder lösen oder löschen (bleibt leer bestehen), Entitlements je Kunden-Org
    ändern (6.4), Kunden-Nutzer umbenennen. Der Name der Kunden-Org folgt einer späteren Umbenennung des Clients nicht.

### 6.4 Plattform-Admin (`/admin/platform`, F5)
- [x] API hinter `requireSuperadmin()`: Organisationen (Liste mit Typ, Mitgliederzahl, verknüpftem Client; anlegen,
      umbenennen), Entitlements je Organisation (Feature-Keys aus `FEATURE_KEYS`), Staff (Liste, Rolle vergeben und
      entziehen, letzter Superadmin geschützt). Audit je Aktion (`platform.*`, `organization_id` der betroffenen Org).
- [x] Seite mit den Reitern Orgs · Entitlements · Staff (`plan.md` §3).
- **Umsetzung (2026-10-12):**
  - `packages/db/src/platform.ts` (kein Org-Kontext, nur hinter `requireSuperadmin()`): `listPlatformOrganizations`
    (Typ, Kunden-Org nach Typ oder Verknüpfung, Mitgliederzahl, verknüpfter Client, gebuchte Features),
    `createPlatformOrganization`, `renamePlatformOrganization`, `setPlatformEntitlements`, `listPlatformStaff`,
    `grantPlatformStaff`, `revokePlatformStaff`.
  - **API** (`routes/platform.ts`): `GET`/`POST /api/platform/organizations`, `PATCH …/{id}`,
    `PUT …/{id}/entitlements`, `GET`/`POST /api/platform/staff`, `DELETE /api/platform/staff/{id}`,
    `GET /api/platform/audit-events`. Org-Admins ohne Plattform-Rolle → 403, Kunden-Logins → 403
    (`customer-org.test.ts` erfasst die neuen Routen von selbst). Die Endpunkte des Admin-Plugins bleiben gesperrt.
  - **Audit:** `platform.organization_create`, `.organization_rename`, `.entitlements_update` (vorher/nachher) mit
    der `organization_id` der betroffenen Org (stehen damit auch in deren Audit-Log); `platform.staff_grant`,
    `.staff_revoke` ohne Organisation. Diese plattformweiten Ereignisse zeigt nur der Reiter „Staff“ (Protokoll,
    die letzten 50; `listAuditEvents` nimmt dafür `orgId: null`).
  - **Festlegungen von Claude (Dominik kann widersprechen):**
    - Anlegen erzeugt eine **Agentur-Org** (`internal`; Kunden-Orgs entstehen weiter am Client, 6.3c), Slug aus dem
      Namen (vergeben → 409), ohne Features. Der Anlegende wird ihr **Admin**, sonst käme niemand hinein; er wechselt
      über das Account-Menü und legt dort Mitglieder an. Umbenennen lässt den Slug stehen.
    - **Kunden-Orgs** lassen sich nur `CUSTOMER_ORG_FEATURES` buchen (Server: 409, Oberfläche bietet nur diese
      beiden an); die Konstante liegt jetzt in `packages/shared/src/features.ts`.
    - **Staff** wird nur, wer Mitglied einer Agentur-Org ist (sonst 409 `PLATFORM_NOT_AGENCY_MEMBER`): Ein
      Kunden-Login oder ein Konto ohne Mitgliedschaft zählte sonst als „weiterer Superadmin“ und höbe den Schutz des
      letzten auf. Die Rolle wirkt sofort (Rollen werden je Anfrage frisch gelesen), Sessions enden beim Entziehen nicht.
  - **Seite** `pages/PlatformPage.vue`, Reiter im Pfad (`/admin/platform/orgs|entitlements|staff`): Liste, Dialog
    zum Anlegen und Umbenennen, Häkchen je Feature (speichert sofort), Staff mit Formular, Rückfrage vor dem
    Entziehen und Protokoll; Loading, Empty, Error je Bereich.
  - **Browser-Pane geprüft** (echte Bedienelemente, als Seed-Admin): Kunden-Org umbenannt und zurück, Feature
    „Explorer“ der Kunden-Org ab- und wieder angewählt, Rolle an `pruefung-6-2@muuv.test` vergeben (vor der
    Einschränkung auf Agentur-Mitglieder) und nach Rückfrage entzogen, Protokoll zeigt beides; Handy (375 px, hell)
    und Tablet ohne waagerechtes Scrollen, Dunkel, Konsole leer. Nicht geprüft: 1440 px (Pane schmaler),
    „Organisation anlegen“ im Browser (lässt sich nicht zurücknehmen; per Test abgedeckt), die eigene Rolle abgeben.
  - **Reste in der Dev-DB:** Audit-Events vom 2026-10-12: zweimal `platform.organization_rename` und zweimal
    `platform.entitlements_update` bei der Kunden-Org „Kranich (Demo)“, `platform.staff_grant` und `.staff_revoke`
    (plattformweit); `pruefung-6-2@muuv.test` hat die Plattform-Rolle `user` (vorher leer).
  - Review (ponytail): Staff nur für Agentur-Mitglieder, Feature-Liste aus der DB in JavaScript nachsortiert
    (Vergleich vorher/nachher), Staff-Abfragen nur auf dem Reiter „Staff“; alle drei behoben.
  - **Bewusst nicht:** Organisation löschen, Typ ändern, Slug ändern, Nutzer sperren (F5); Blättern im Protokoll.

### 6.5 Impersonation (F4)
- [x] `POST /api/platform/impersonation` (Superadmin, Ziel kein Superadmin) und `DELETE` (beenden); Ablauf nach
      höchstens einer Stunde; Audit für Beginn und Ende.
- [x] Volle Rechte des Nutzers (F4): Der Handelnde im Audit kommt an **einer** Stelle aus der Session (Superadmin als
      `actor_user_id`, Nutzer im `target`), nicht je Aufrufer; Test über eine schreibende Route je Bereich und über die
      better-auth-Hooks. Plattform-Routen und Mitgliederverwaltung sind während einer Impersonation gesperrt (sonst
      ließe sich über den fremden Nutzer die eigene Spur verwischen oder ein Passwort-Link ziehen).
- [x] Web: Banner über der Shell mit „Beenden“, Start aus dem Plattform-Admin.
- **Umsetzung (2026-10-12):**
  - **Session über das Admin-Plugin, serverseitig:** `POST /api/platform/impersonation` (`{ userId }`, hinter
    `requireSuperadmin()`) ruft `auth.api.impersonateUser`, `DELETE` ruft `auth.api.stopImpersonating`; die
    HTTP-Endpunkte des Plugins bleiben gesperrt. Das Plugin legt eine eigene Session des Nutzers an
    (`sessions.impersonated_by` steht im Schema, Ablauf nach einer Stunde, wird nicht verlängert) und merkt sich
    die Session des Superadmins in einem signierten Cookie; Beenden löscht die Session des Nutzers und stellt
    die des Superadmins wieder her. Fehlt dieser Cookie oder ist die Session abgelaufen, endet nur die des
    Nutzers (der Superadmin meldet sich neu an). Unbekannter Nutzer → 404, Superadmin als Ziel → 409
    `IMPERSONATION_SUPERADMIN` (zusätzlich lehnt das Plugin es ab), ohne Impersonation beenden → 409.
  - **Handelnder an einer Stelle:** `runAsImpersonator()` in `packages/db/src/audit.ts` (AsyncLocalStorage);
    darin setzt `recordAuditEvent` den Superadmin als `actor_user_id` und den Nutzer als
    `target.impersonatedUserId`. Aufgerufen aus der Session in `requireSession` (alle eigenen Routen) und in den
    Organization-Hooks von better-auth (`auth.ts`). Kein Aufrufer von `recordAuditEvent` wurde geändert. Ereignisse
    ohne Nutzer (System) bleiben ohne Nutzer.
  - **Audit:** `platform.impersonation_start` und `.impersonation_stop` (plattformweit, im Protokoll des Reiters
    „Staff“). Der Beginn wird vor dem Anlegen der Session geschrieben (lieber ein Beginn zu viel als einer zu wenig).
    Das Audit-Log (6.1) zeigt bei solchen Aktionen „als <Name>“ (bzw. „als anderer Nutzer“, wenn der Nutzer selbst
    nie im Log vorkommt; die ID steht in den Details).
  - **Gesperrt während einer Impersonation** (`IMPERSONATION_BLOCKED` in `middleware.ts`, 403
    `IMPERSONATION_FORBIDDEN`): `/api/members*`, `/api/clients/{id}/access*`, `/api/platform/*` außer dem Beenden.
    Für einen angesehenen Kunden-Nutzer gelten dessen Grenzen (`CUSTOMER_ORG_PATHS`); Beenden bleibt möglich.
  - `/api/me` nennt `impersonatedBy` (`{ id, name }` oder `null`). Neu `GET /api/platform/organizations/{id}/members`
    (Auswahl im Plattform-Admin).
  - **Web:** Reiter „Orgs“ klappt je Organisation die Mitglieder auf, „Als Nutzer ansehen“ (nicht bei Superadmins);
    `ImpersonationBanner.vue` über jeder Seite der Shell mit „Beenden“. Start und Ende leeren den Query-Cache und
    laden `/api/me` neu.
  - **Tests:** `routes/impersonation.test.ts` (Rechte, Ablauf, Audit über `PUT /api/settings`, `POST /api/clients`
    und den Hook `organization.update`, Sperren, Beenden, Kunden-Nutzer), `audit.test.ts` (auch in Transaktionen).
    **Abweichung:** nicht je Bereich eine Route, sondern zwei Routen und ein Hook: Die Umschreibung sitzt in
    `recordAuditEvent` selbst, der einzigen Stelle, die `audit_events` schreibt.
  - **Browser-Pane geprüft:** Testmitglied über die Mitgliederverwaltung aufgenommen (`pruefung-6-2@muuv.test`),
    im Plattform-Admin „Als Nutzer ansehen“: Banner, Account-Menü zeigt den Nutzer, `/api/members` und
    `/api/platform/organizations` → 403, Handy (375 px, hell) ohne waagerechtes Scrollen; „Beenden“ führt zurück in
    den Plattform-Admin, das Protokoll zeigt Beginn und Ende; Mitglied über die Oberfläche wieder entfernt. Nicht
    geprüft: 1440 px, Ablauf nach einer Stunde und eine schreibende Aktion im Browser (per Test abgedeckt).
  - **Reste in der Dev-DB (2026-10-12):** `member.create`, `member.remove` (Muuv), `platform.impersonation_start`
    und `.impersonation_stop`, ein gesperrter Passwort-Link für `pruefung-6-2@muuv.test`.
  - **Bekannte Grenzen:** Läuft die Session ab, gibt es kein Ende-Ereignis (der Beginn nennt den Zeitpunkt, die
    Dauer ist auf eine Stunde begrenzt); beim Abmelden seit 2026-10-12 schon („Offen nach Phase 6“). Der Hook für
    `/organization/leave` kennt die Impersonation nicht; der Endpunkt ist per HTTP gesperrt.
  - Review (ponytail): Kennzeichnung im Audit-Log ergänzt (Festlegung „zeigt beides“); sonst keine Befunde.

### 6.6 Abschluss
- [x] Definition of Done prüfen und belegen, ADR 002 und `plan.md` (§3, §4) auf den Stand bringen, „Offen nach Phase 6“.
- **Umsetzung (2026-10-12):** Definition of Done oben mit Belegen abgehakt (ein Punkt offen: 1440 px). `plan.md` §2
  (Stand Phase 6), §3 (Plattform-Zeile, Kunden-Logins, „Als Nutzer ansehen“) und §4 (Plattform-Rolle, Kundenzugang,
  Impersonation) angepasst; ADR 002 wurde je Aufgabe ergänzt (6.1–6.5) und nennt keine offene Frage zu Phase 6 mehr.
  Nur Dokumente, kein Code.

## Offen nach Phase 6 (Stand 2026-10-12)

**Bestätigt (Dominik, 2026-10-12: „alles so lassen“) – Festlegungen von Claude:**
- **Gespeicherte Ansichten für Kunden** sind nicht freigegeben (die Festlegung hätte eigene Ansichten der Kunden-Org
  erlaubt; sie brauchen `write`, das Kunden nie haben; 6.3a/6.3b).
- **Kunden-Org** lässt sich nicht lösen oder löschen und folgt einer Umbenennung des Clients nicht (6.3c). Seit 6.4
  kann der Plattform-Admin sie von Hand umbenennen.
- **Neue Organisation** (6.4): immer Agentur-Org, der anlegende Superadmin wird ihr Admin. Ein Superadmin kann damit
  Mitglied mehrerer Organisationen sein; `removeMember` beendet dann alle seine Sessions, und „Link neu erzeugen“ ist
  für ihn gesperrt (`OTHER_ORGANIZATION`, ohnehin `PROTECTED`).
- **Staff** nur für Mitglieder einer Agentur-Org (6.4).

**Nicht gebaut oder nicht geprüft:**
- **1440 px** in der Browser-Pane (Definition of Done): in keiner Session möglich, die Pane war schmaler. Nachholen
  in einem breiten Fenster: `/admin/audit`, `/admin/platform/*`, Kundenzugang-Dialog, Banner.
- **Impersonation ohne Ende-Ereignis:** nur noch bei Ablauf nach einer Stunde (kein Job dafür; der Beginn nennt den
  Zeitpunkt, die Dauer ist begrenzt). Nach dem Ablauf muss sich der Superadmin neu anmelden.
  **Nachgezogen (2026-10-12):** Abmelden während der Impersonation schreibt `platform.impersonation_stop`
  (`hooks.before` für `/sign-out` in `auth.ts`, Test in `routes/impersonation.test.ts`). Der Cookie mit der eigenen
  Session des Superadmins bleibt dabei bis zum Ablauf im Browser liegen; diese Session wird nicht beendet.
- **Protokoll im Plattform-Admin** zeigt die letzten 50 plattformweiten Ereignisse ohne Blättern (6.4); die
  Filterauswahl des Audit-Logs liest alle Ereignisse der Organisation (6.1).
- **Nutzerverwaltung über Organisationen hinweg** gibt es nicht: Nutzer ohne Mitgliedschaft (z. B. entfernte
  Mitglieder) tauchen im Plattform-Admin nicht auf und lassen sich nicht ansehen oder löschen.
- **Anmeldung als eingeschränktes Mitglied** im Browser (6.2, per API-Test abgedeckt); „Organisation anlegen“ und die
  eigene Plattform-Rolle abgeben im Browser (6.4, per Test abgedeckt).
- **Aus Phase 5 weiter offen:** 5.12 und die Prüfung mit echten Daten (`phase-5.md` „Offen nach Phase 5“).
- **Aufgefallen, nicht geprüft:** `plan.md` §3 nennt den Feature-Key `organic`, `FEATURE_KEYS`
  (`packages/shared/src/features.ts`) kennt ihn nicht; damit lässt er sich im Plattform-Admin nicht buchen.

**Dev-DB (Reste, nicht per psql löschbar; migriert bis `0049_client_organization`, Phase 6.4–6.6 ohne Migration):**
Nutzer `pruefung-6-2@muuv.test` (Plattform-Rolle `user`, ohne Mitgliedschaft) und `pruefung-6-3@kunde.test`, leere
Kunden-Org „Kranich (Demo)“, dazu die je Aufgabe genannten Audit-Events (6.2, 6.3c, 6.4, 6.5).

## Bewusst nicht in Phase 6

- Alles mit SP-API: Bestellungen, Kosten, P&L, TACoS (Phase 7); Rechner Deal & Coupon, LTV, B2B-Inkrementalität
  (Ideen-Dokument G, dort Phase 7).
- Schreibrechte für Kunden, Freigaben oder Kommentare von Kunden zu Vorschlägen.
- Selbstregistrierung, Einladungen per E-Mail, Passwort-Reset per E-Mail, SSO, Zwei-Faktor (kein Mail-Dienst, keine
  zusätzlichen Konten).
- Abrechnung, Pläne, Preise; Organisation löschen; White-Label je Kunde (Logo, Farben).
- Export des Audit-Logs, Löschfristen, Benachrichtigungen an Kunden.
- 5.12 und die Prüfung mit echten Daten aus Phase 5 (bleiben in `phase-5.md` offen, bis Daten vorliegen).

## Reihenfolge für Claude Code

6.1 → 6.2 → 6.3a → 6.3b → 6.3c → 6.4 → 6.5 → 6.6. 6.1 hängt an nichts; 6.3b braucht 6.3a; 6.5 braucht 6.4. Bis zu drei
Aufgaben je Session (`CLAUDE.md`), nach jedem Schritt Tests grün, Commit, Häkchen und „Umsetzung“-Notiz.
