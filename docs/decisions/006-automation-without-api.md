# ADR 006 – Automatik ohne Ads-API

- **Status:** angenommen
- **Datum:** 2026-10-10 (Phase 5, Aufgabe 5.7)
- **Beteiligte:** Dominik (F1, F3 in `docs/tasks/phase-5.md`; Festlegungen aus dem Review des Plans; Punkt 7 bestätigt am 2026-10-11)

## Kontext

Phase 5 soll Gebote und Budgets überwachen und Vorschläge machen. Es gibt weiterhin keinen Zugang zur Amazon-Ads-API:
Daten kommen nur aus der Bulk-Datei, die Dominik wöchentlich je Profil lädt (Zeitraumsummen je Kampagne, Ad Group und
Target, keine Tageswerte), und geschrieben wird wie in Phase 3 über Warenkorb, Übermittlung und eine Bulk-Datei, die von
Hand hochgeladen wird. Die Automatik muss damit heute nützlich sein und später ohne Umbau auf die API wechseln können.

## Entscheidung

1. **Zeitraumsummen statt Tageswerte.** Die Automatik rechnet auf den Summen der zuletzt hochgeladenen Datei mit
   Kennzahlen (`amazon_ads_entity_period_metrics`, 5.1). Entities, deren Summen aus einer Datei mit früherem
   Zeitraumende stammen, bleiben außen vor.
2. **Der Datenstand ist der Takt.** Der Job `automation-run` läuft je Profil nach jedem Import mit Kennzahlen und einmal
   täglich (07:30 Berlin). Ein Lauf entsteht nur, wenn sich seit dem letzten etwas geändert hat: Ein Hash über
   Datenstand, Regeln, Ziele, Leitplanken, Modus und zuständigen Nutzer (`automation_runs.fingerprint`) entscheidet;
   sonst gibt es weder einen Lauf noch einen `job_runs`-Eintrag. Der Tageskurs gehört nicht in den Hash.
   Der Modus „aus“ eines Clients schaltet nur die Vorschläge ab; der Lauf entsteht trotzdem und liefert Cap-Meldungen
   und Prüfungen (Dominik, 2026-10-11, `phase-5.md` 5.13a).
3. **Vorschläge statt Writes.** Jeder Lauf speichert, worauf er gerechnet hat, und je Vorschlag Herkunft (Regel oder
   Optimizer), vorher/nachher, Kennzahlen und begrenzende Leitplanken (`automation_runs`, `automation_proposals`). An
   Amazon geht nichts: Im Schattenmodus bleiben Vorschläge im Protokoll; im Modus `cart` werden sie ausstehende
   Änderungen (`ad_changes`, Herkunft `automation`) und gehen den Weg aus Phase 3.
4. **Warenkorb-Zuordnung.** Der Warenkorb gehört je einem Nutzer. Vorschläge landen deshalb im Warenkorb des
   **zuständigen Nutzers** des Clients; fehlt er oder hat er kein Schreibrecht mehr, fällt der Lauf auf den
   Schattenmodus zurück und meldet das den Admins. Die Automatik ersetzt nur ihre eigenen offenen Zeilen. Eine
   von Hand gelegte offene Änderung sperrt die Entity für Vorschläge; ändert der Nutzer eine Zeile der Automatik, wird
   sie zu seiner. Ein eigener Index erlaubt je Entity und Feld höchstens einen offenen Vorschlag im Warenkorb.
5. **Verwerfen gilt je Datenstand.** Was verworfen wurde (in der Liste oder durch Löschen im Warenkorb), kommt erst
   mit einer neuen Datei mit Kennzahlen wieder (Dominik, 2026-10-10).
6. **Reihenfolge je Entity:** erste passende Regel, sonst (nur Targets) der Optimizer, danach die Leitplanken; die
   Entscheidung liegt ohne I/O in `packages/engine` (`decideTarget`, `decideCampaign`). Budgets ändert nur eine Regel.
7. **Basis der Leitplanken.** Ausgangswert ist der neueste Wert aus übermittelten Änderungen und aus Änderungen, die
   in den letzten 7 Tagen angewendet wurden, sonst der Wert der Entity; der Wert zu Beginn der 7 Tage ist der Stand vor
   der ältesten Änderung im Fenster. Ältere angewendete Änderungen zählen nicht mehr: Der nächste Import bringt den
   Stand aus der Konsole, und der hat dann Vorrang.

## Folgen

- Vorschläge sind so alt wie die Datei. Die Oberfläche (5.8) zeigt je Lauf den Zeitraum; lädt jemand nachträglich eine
  ältere Datei hoch, trägt der Lauf den Hinweis `olderPeriod`.
- Änderungen in der Werbekonsole sieht ProfitBash erst mit dem nächsten Import, ohne Datum. Die Grenze „je 7 Tage“ zählt
  deshalb nur Änderungen über ProfitBash.
- Ein Teil-Export verschiebt den Datenstand des Profils: Entities, die darin fehlen, bekommen bis zur nächsten
  vollständigen Datei keine Vorschläge.
- Automatisches Übermitteln ist nicht vorgesehen (F3: Entscheidung, wenn die API da ist).

## Weg zur API

Mit der API tauscht nur die Datenquelle: Tageswerte werden über das gewünschte Fenster summiert und liefern dieselben
Summen je Entity (`source: 'daily'` im Datenstand), der Takt wird der tägliche Report-Import. Engine, Leitplanken,
Tabellen und Oberfläche bleiben. Übermittelt würde über den vorhandenen Weg `api` der Übermittlungen (ADR 005); ob ohne
Rückfrage, ist eine eigene Entscheidung.
