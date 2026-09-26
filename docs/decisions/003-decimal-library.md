# ADR 003 – Decimal-Library für Geldbeträge

- **Status:** angenommen
- **Datum:** 2026-09-26 (Beginn von Phase 1, Aufgabe 1.1)
- **Beteiligte:** Dominik (F13 in `docs/tasks/phase-1.md`)

## Kontext

Ab Phase 1 kommen Beträge von Amazon in die Datenbank (Kosten, Umsätze, Budgets, Gebote), ab Phase 2 wird mit ihnen gerechnet
(Summen, ACoS, ROAS, Pacing), ab Phase 3 schreiben wir Gebote und Budgets zurück. Leitplanke aus `docs/plan.md` §5: Geld nie als
Float, `numeric` in der DB, Decimal-Strings in der API, Rechnen mit einer Decimal-Library.

Anforderungen:
- Exakte Konstruktion aus Strings (auch Exponentialschreibweise wie `1e-7`), ohne Umweg über `number`.
- Beliebige Nachkommastellen (Gebote und CPC haben teils mehr als zwei), explizite Rundungsmodi.
- Ausgabe als normaler Decimal-String ohne Exponent (für `numeric` und die API).
- MIT o. ä., keine Abhängigkeiten, gepflegt, TypeScript-Typen.

## Entscheidung

**`decimal.js`** (MIT, ohne Abhängigkeiten, eigene Typen).

- Nur auf dem Server und in `packages/engine`. Das Web bekommt Decimal-Strings und formatiert sie über die Helper aus
  `@profitbash/shared` (`formatNumber`, `formatCurrency`, `formatPercent` nehmen Strings und geben sie ohne `number` an
  `Intl.NumberFormat`); dort kein `decimal.js`.
- Einlesen: `amazonDecimalSchema` in `packages/amazon-ads` normalisiert Beträge mit `decimal.js` zu einem Decimal-String
  (`toFixed()` ohne Argument: exakt, ohne Exponent, ohne Rundung). Die Konstruktion rundet nicht auf `precision`.
- Rechnen: Mit der ersten Berechnung (Phase 2) bekommt `packages/engine` **eine** konfigurierte Kopie (`Decimal.clone(...)`) mit
  festgelegter Genauigkeit und Rundungsmodus; alle Berechnungen nutzen sie, niemand ändert die globale Konfiguration.
  Gerundet wird erst beim Anzeigen oder beim Schreiben an Amazon (mit den Nachkommastellen, die Amazon je Feld erlaubt).

## Begründung

- Deckt alle Anforderungen ab, ist verbreitet und stabil (10.x seit Jahren, letzte Version 07/2025).
- Mehr Funktionen als nötig kosten hier nichts: Das Paket läuft nur auf dem Server, die Bundle-Größe spielt keine Rolle.
- Getestet am 2026-09-26: `0.1`, `1234567.89`, `0.005`, `1e-7`, `-0.00`, 33 Nachkommastellen und 30 Vorkommastellen kommen exakt an.

## Konsequenzen

- Neue Abhängigkeit in `packages/amazon-ads` (jetzt) und `packages/engine` (mit der ersten Berechnung).
- Exponenten müssen begrenzt werden: `new Decimal('1e-1000000').toFixed()` ergibt einen String mit einer Million Zeichen.
  `amazonDecimalSchema` lehnt Werte mit zu großem Exponenten ab.
- `numeric` ohne feste Skala in der DB speichert, was ankommt; Drizzle liefert `numeric` als String (Konvention in
  `docs/tasks/phase-1.md`, 1.1 „Umsetzung“).

## Verworfene Alternativen

- **`big.js`** (vom selben Autor, kleiner): konstruiert ebenso exakt, hat aber weniger Funktionen (vier statt neun Rundungsmodi,
  Potenzen nur mit ganzzahligem Exponenten, keine Logarithmen). Für Geld reicht das heute, aber der Wechsel später wäre teurer
  als der Mehrumfang jetzt.
  Der Größenvorteil zählt nur im Browser, wo wir nicht rechnen.
- **`dinero.js`**: Geld-Objekte mit eigener Währungs- und Skalenlogik (Ganzzahlen in kleinster Einheit). Passt nicht zu Beträgen
  mit mehr Nachkommastellen als die Währung (Gebote, CPC) und bringt Währungslogik mit, die wir getrennt halten
  (Betrag + `currency_code`, Wechselkurse ab Phase 2).
- **`bigint` in kleinster Einheit selbst verwalten:** Skala je Feld müsste überall mitgeführt werden, fehleranfällig bei Division
  (ACoS, CPC) und bei Werten mit mehr Nachkommastellen.
