# ADR 004 – Amazon-Ads-API für Entity-Sync und Reports

- **Status:** angenommen
- **Datum:** 2026-09-26 (vor Beginn von Phase 1, Doku-Stand vom selben Tag)
- **Beteiligte:** Dominik
- **Hinweis:** ADR 003 (Decimal-Library) entstand erst danach, deshalb die Nummerierung.

## Kontext

Phase 1 liest Entities (Portfolios, Kampagnen, Ad Groups, Targets, Negatives, Product Ads) und tägliche Kennzahlen je Ebene.
Amazon betreibt zwei API-Generationen parallel (Details und Quellen: `docs/tasks/phase-1.md`, „Stand der Amazon-Ads-API“):

- **Produktspezifisch:** SP v3, SB v4, SD; die **Exports-API** (asynchron, gemeinsames Modell für SP/SB/SD) und **Reporting v3**.
  Alles GA, nichts davon abgekündigt.
- **Amazon Ads API v1** (`/adsApi/v1/...`): Campaign Management GA seit 12/2025 für SP und SB (SD und Sponsored TV fehlen noch),
  Reporting v1 seit 11/2025 in **open beta** (24 Monate Tageshistorie statt 60–95 Tagen, neue Metrikdefinitionen).

## Entscheidung

- **Entities lesen:** Exports-API (`/campaigns/export`, `/adGroups/export`, `/targets/export`, `/ads/export`) für SP, SB und SD;
  Portfolios über den List-Endpunkt.
- **Kennzahlen:** Reporting v3 (`/reporting/reports`), tägliches rollierendes Fenster und Historie im Rahmen der v3-Aufbewahrung.
- Beides hinter einer eigenen, schmalen Schnittstelle in `packages/amazon-ads` mit eigenem normalisiertem Modell. Jobs und
  Datenbank kennen die Amazon-Endpunkte nicht; ein Wechsel auf v1 bleibt auf das Paket begrenzt.

## Begründung

- Nur GA-Schnittstellen im Fundament, auf dem später Budgets und Regeln rechnen.
- Ein asynchrones Muster (anfordern, abwarten, gzip laden) für Entities und Reports; ein gemeinsamer Zustand in der DB.
- SD ist über die Exports-API sofort abgedeckt, über v1 noch nicht.
- Wenige Aufrufe je Profil, das schont die dynamischen Rate-Limits.

## Konsequenzen

- Historie ist auf die v3-Aufbewahrung begrenzt (SP 95, SB 60, SD 65 Tage). Unsere DB wird ab dem ersten Sync die einzige längere Historie.
- Schreiben (Phase 3) ist hiermit nicht entschieden. Naheliegend ist Campaign Management v1; die Exports nutzen Amazons gemeinsames Modell,
  das nah an v1 liegt. Beim Start von Phase 3 als eigene Entscheidung prüfen.
- **Wiedervorlage:** Option „(a) plus einmaliger Rückgriff über Reporting v1“ (bis 24 Monate Historie beim ersten Sync, getrennt markiert,
  nie mit v3-Werten vermischt), sobald Reporting v1 GA ist oder ältere Historie gebraucht wird. Ebenso, falls Amazon Exports oder
  Reporting v3 abkündigt.

## Verworfene Alternativen

- **Campaign Management v1 + Reporting v3:** gleiches Modell wie spätere Writes, aber SD fehlt (zweiter Weg nötig) und viele
  synchrone, paginierte Aufrufe bei großen Konten.
- **Alles v1 inkl. Reporting v1:** mehr Historie und einheitliche Metriken, aber Beta mit erlaubten Brüchen und ohne SD im Campaign Management.
