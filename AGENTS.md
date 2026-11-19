# AGENTS.md

Orientierung für KI-Agenten (Claude Code, Codex, …) und Mitwirkende an diesem Repository. Workspace-weite Standards (comply-or-explain): siehe [`../../workspace/_docs/CONVENTIONS.md`](../../workspace/_docs/CONVENTIONS.md) (maintainer-lokal, nicht Teil dieses Repos — ignorieren, falls im Klon nicht vorhanden).

**Profil:** `ts-node` · `obsidian-plugin`.

**Stand 2026-11-19:** Gerüst nach Dach-Standard steht (Aufgabe 1 des Bauplans), Einstellungen, Gerätezustand und Texte folgen (Aufgabe 2). Die Design-Spec für Version 1 ist von Johannes am 2026-11-18 freigegeben und liegt im Coding-Cockpit (`25_Coding/pseudonymizer/`, Note „2026-11-18-pseudonymizer-design“ unter _SDD); der Bauplan „2026-11-18-pseudonymizer-plan-1“ liegt daneben. Die Kit-Bausteine sind beim Kit-Master bestellt (Tasks in den Cockpits code-kit und obsidian-kit). Kein Tag und kein Release, bevor das Sicherheits-Review der Kryptografie-Bausteine durch ist.

## Project character

**Projekt:** `pseudonymizer` — Obsidian-Plugin (in Bau): ersetzt personenbezogene Daten durch stabile Platzhalter, hält die Zuordnung verschlüsselt und setzt den Klartext beim Anzeigen und Exportieren wieder ein (Arbeitstitel war „Anonymizer“). Design: siehe Cockpit. Autor: Johannes Kaindl.

## Architecture principles

**PROF-OBS-03/04 — reiner Kern ohne `obsidian`-Import.** `src/core/` ist obsidian-frei und in Node ohne DOM testbar; nur `src/main.ts` und `src/obsidian/` importieren `obsidian`. `npm run check:pure` nagelt das fest.

**Kit-first, Vendoring statt Dependency.** Geteilte Bausteine liegen als Snapshot unter `src/vendor/kit/` (pure), `src/vendor/kit-obsidian/` und `tests/vendor/kit/`, je mit Herkunfts-Header und `VENDOR.json`. Nie von Hand editieren; Re-Vendoring über `node ../tools/kit-sync/kit-sync.mjs` (Pins in `tools/kit-sync.json`, Tags obsidian-kit 0.99.1 und code-kit 0.78.0). Kryptografie nur über die Kit-Bausteine, kein `node:crypto`, kein eigenes Verfahren.

```
src/main.ts                 onload: Sprache, Strings (wächst mit den Aufgaben)
src/core/                   reiner Kern (Einstellungen, Zustand, Protokoll, Inhalt der Gerätedatei, API-Hülle)
src/obsidian/               Obsidian-Schicht (Gerätezustand, Einstellungsseite, Befehle, Ansicht)
src/i18n/strings.ts         alle Nutzertexte, EN kanonisch, DE vollständig
src/vendor/                 vendorte Kit-Module (nie von Hand)
tests/                      vitest; `tests/__mocks__/obsidian.ts` zeigt auf den vendorten Kit-Mock
tools/kit-sync.json         Pins und Module; `tools/sync-kit.sh` ist der Wrapper aus der Vorlage
```

## Commands

- `npm run gate` — lint + typecheck + typecheck:test + typecheck:scripts + test + check:pure + build; Pflicht vor jedem Commit, null Errors und null Warnings.
- `node ../tools/kit-sync/kit-sync.mjs [--check]` — Kit-Vendoring aus `../obsidian-kit` und `../../libs/code-kit`.
- `python3 ../tools/template_drift_check.py 2>&1 | grep -A3 pseudonymizer` — Vorlagen-Drift (Release-Dateien, Wrapper, Konfig).
- `python3 ../tools/bibliothek/gate.py --repo pseudonymizer --liste` — Bibliothek-Gate, Ziel 0 offen.
- `node ../tools/css_baseline/check.mjs styles.css` — CSS-Baseline (sobald `styles.css` Regeln trägt).

## Conventions

- Markdown-Dateien: ein Absatz je Zeile (Johannes' Regel seit 2026-09-19).
- Texte ausschließlich in `src/i18n/strings.ts`, EN kanonisch, DE vollständig; `tests/strings.test.ts` prüft die Schlüsselmengen. Jeder Befehl trägt ein `icon`.
- CSS-Präfix `pseu-`, nur Theme-Variablen, kein `!important` (UI-STANDARD §3).
- Keine Lookbehind-RegExp (iOS Safari vor 16.4), kein `require()`, kein Import aus `electron`, `fs` oder Node-Builtins, kein Netz.
- `data.json` trägt nur Einstellungen, nie einen Namen, Wert oder Platzhalter-Klartext. Geräteeigenes liegt in `app.saveLocalStorage` unter Schlüsseln mit Präfix `pseudonymizer-`.
- Kein Klartext in `console`, Fehlermeldungen, Notices über Fehler und Logs.
- Tests, Fixtures und Beispiele enthalten nur erkennbar erfundene Werte (`Max Mustermann`, `max@example.org`, `030 1234567`, `DE89 3704 0044 0532 0130 00`).
- Vendorte Dateien nie von Hand editieren; `eslint.overrides.mjs` klammert `src/vendor/**` aus.
- Release-Dateien (`.github/workflows/release.yml`, `eslint.config.mjs`, `scripts/check-*.mjs`, `scripts/build-release-assets.mjs`, `scripts/plugin-zip.mjs`, `tools/sync-kit.sh`) sind byte-gleich zur Vorlage im Dach; Änderungen passieren dort.

## Gotchas

- **Obsidians `saveLocalStorage(key, false)` speichert nichts** (gemessen in filename-sanitizer 1.15.1): Ein Gerätewert, der aus sein kann, wird als Text gespeichert (`on`/`off`), nie als Boolean.
- **Der Rückweg setzt nie in Attribute (`href`, `src`, `title`, `alt`, `data-*`) und nie in Code ein** (Spec 2, 8.6).
- **Kein Tag und kein Release** vor dem Sicherheits-Review der Kryptografie-Bausteine (Spec 11.3); die Release-Dateien liegen nur, weil die Vorlage sie verlangt.
- **`grep` ist auf diesem Rechner ugrep und respektiert `.gitignore`;** über Repos hinweg `/usr/bin/grep`.

## Context index

- Bevor du am Design weiterarbeitest oder etwas baust: die Design-Spec im Coding-Cockpit (Note „2026-11-18-pseudonymizer-design“ unter _SDD, maintainer-lokal, CORE-META-14), besonders Abschnitt 5 (Entscheidungen) und Abschnitt 2 (Anti-Ziele).
- Bevor du am Design weiterarbeitest: die Recherche zu Kit-Bausteinen und Store-Nachbarn im Coding-Cockpit (Note „2026-11-18-recherche-kit-bausteine-und-store-nachbarn“ unter _SDD, maintainer-lokal, CORE-META-14).

## Memory

- 2026-11-19: Bau-Session (Sonnet, Linie design-pseudonymizer) setzt die Aufgaben 1 und 2 des Bauplans um.

## Abweichungen von der Leitkonvention

Keine bekannt.
