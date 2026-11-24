# AGENTS.md

Orientierung für KI-Agenten (Claude Code, Codex, …) und Mitwirkende an diesem Repository. Workspace-weite Standards (comply-or-explain): siehe [`../../workspace/_docs/CONVENTIONS.md`](../../workspace/_docs/CONVENTIONS.md) (maintainer-lokal, nicht Teil dieses Repos — ignorieren, falls im Klon nicht vorhanden).

**Profil:** `ts-node` · `obsidian-plugin`.

**Stand 2026-11-24 (Welle 37):** Bauplan Version 1, Aufgaben 1 bis 19, gebaut und gepusht; Kit auf code-kit 0.86.1 und obsidian-kit 0.108.0. `restore` der Plugin-API hat den optionalen Schalter `skipAddressesAndCode` (Entscheidung Johannes 2026-11-20, Vorgabe „überall“, Bereiche wie `core/restore-zones.ts`). Release-Infrastruktur steht (Remotes `origin` und `github`, CHANGELOG, Trockenlauf von `release.mjs`); die Erstveröffentlichung 0.1.0 gibt Johannes nach den iPhone-Messungen frei (Schlüsselbund, WebCrypto, Sync der Endung `.pseudo`, Live Preview, Prüffenster am Telefon, mit Entscheidung D; Handover im Cockpit). Der GUI-Smoke (`npm run smoke:gui`, `docs/SMOKE.md`) und die README-Bilder (`npm run shots`) gehören vor dem Release an den Release-Stand. Stand je Aufgabe, Setzungen und Grenzen stehen als Vermerke im Bauplan „2026-11-18-pseudonymizer-plan-1“ im Coding-Cockpit (`25_Coding/pseudonymizer/` unter _SDD, neben der freigegebenen Design-Spec „2026-11-18-pseudonymizer-design“).

## Project character

**Projekt:** `pseudonymizer` — Obsidian-Plugin (in Bau): ersetzt personenbezogene Daten durch stabile Platzhalter, hält die Zuordnung verschlüsselt und setzt den Klartext beim Anzeigen und Exportieren wieder ein (Arbeitstitel war „Anonymizer“). Design: siehe Cockpit. Autor: Johannes Kaindl.

## Architecture principles

**PROF-OBS-03/04 — reiner Kern ohne `obsidian`-Import.** `src/core/` ist obsidian-frei und in Node ohne DOM testbar; nur `src/main.ts` und `src/obsidian/` importieren `obsidian`. `npm run check:pure` nagelt das fest.

**Kit-first, Vendoring statt Dependency.** Geteilte Bausteine liegen als Snapshot unter `src/vendor/kit/` (pure), `src/vendor/kit-obsidian/` und `tests/vendor/kit/`, je mit Herkunfts-Header und `VENDOR.json`. Nie von Hand editieren; Re-Vendoring über `node ../tools/kit-sync/kit-sync.mjs` (Pins in `tools/kit-sync.json`, Tags obsidian-kit 0.108.0 und code-kit 0.86.1). Kryptografie nur über die Kit-Bausteine, kein `node:crypto`, kein eigenes Verfahren.

```
src/main.ts                 onload: Sprache, Einstellungen, Gerätezustand, Einstellungsseite (wächst mit den Aufgaben)
src/core/constants.ts       Präfix der geräteeigenen Schlüssel
src/core/settings.ts        PseudonymizerSettings, loadSettings (Feldreparatur), withFolder (Ordnerregel)
src/obsidian/device.ts      geräteeigene Werte im lokalen Speicher (Klartext zeigen, Gerätename)
src/obsidian/settings-tab.ts  deklarativer Tab, Hilfe-Zeile zuerst
src/core/                   reiner Kern (Einstellungen, Zustand, Protokoll, Inhalt der Gerätedatei, API-Hülle)
src/core/devices-view.ts    Modell des Reiters „Geräte und Schlüssel“ (Zeilen, Fortschritt des Vergessens, Stand des Codes)
src/core/transform.ts       rein: `planTransform` (Erkenner, bekannte Formen, Entities, geschützte Bereiche, Dateinamen) und `applyPlan` (Antworten zu Einträgen und Texten); Grenzen im Modulkopf
src/core/forget-plan.ts     rein: Einträge zur Wahl, Plan des Warndialogs (Werte, nicht lesbare Geräte, Ausnahmeliste)
src/core/review-model.ts    rein: Karten des Prüffensters (je Wert eine, Vorgabe der Engine), Antworten, „Gehört zu“, Kontext, Text mit Markierungen
src/obsidian/review-modal.ts Prüffenster als `ReviewFn` (Ergebnis oder `null`; Esc und Abbrechen schreiben nichts)
src/obsidian/table-store.ts Gerätedateien öffnen, vereinigen, schreiben; `setUp`, `adopt` (auch nach Schlüsselwechsel: alte Fassung mit dem alten Schlüssel übernehmen), `markCodeShown`, `forget` (immer n+1), `replaceKey`, `removeDevice`
src/obsidian/setup.ts       Abläufe Einrichten, Code eingeben, Code anzeigen (Reihenfolge der Fragen und Schreibvorgänge; Fenster als `SetupUi`)
src/obsidian/setup-modals.ts, setup-ui.ts  Fenster des Einrichtens und ihr Anschluss
src/obsidian/forget.ts, key-actions.ts  Abläufe Person vergessen, Schlüssel ersetzen, Gerät entfernen (Fenster als `KeyActionsUi`)
src/obsidian/key-actions-ui.ts  Personenwahl (SuggestModal), Warndialoge, Meldungen
src/obsidian/devices-panel.ts  Reiter „Geräte und Schlüssel“
src/obsidian/persons-panel.ts, exceptions-panel.ts  Reiter „Personen“ (Suche, Detail, Zustand der Suche in `PersonsPanelState`) und „Ausnahmen“
src/obsidian/persons-actions.ts  zusammenführen, Wert abhängen, Ausnahmeliste, Vergessen starten (`PersonsApi`; jede Änderung ein `persist`, Fenster als `PersonsUi`), `persons-ui.ts` ihr Anschluss
src/obsidian/reading.ts     Lesesicht: Postprozessor mit Auflöser aus der Tabelle, Auffrischen je Fenster, Haken `onRefresh` für Live Preview
src/obsidian/copy.ts        Kopier-Handler je Fenster (auch beim Ziehen), Befehle „Mit Klartext kopieren“ und „Mit Platzhaltern kopieren“
src/obsidian/live-preview.ts  Live Preview: Verdrahtung des Kit-Bausteins `text-swap-editor` mit demselben Auflöser, Zaunliste je Dokumentstand (`fenceSpans`), Kopier-Handler des Editors (`editorCopyHandler`), Auffrischen aller Editoren (`refreshEditors`, am Haken `onRefresh`)
src/core/note-parts.ts      rein: Notiz in Teile für `transform` zerlegen (Text, Text-Eigenschaften), Ergebnis zu EINEM Gesamttext setzen (`patchFrontmatter`)
src/obsidian/note-actions.ts  Befehle Auswahl und Notiz pseudonymisieren (Reihenfolge Tabelle vor Notiz, ein `swapNote`; Fenster und Editor als `NoteUi`/`NoteHost`)
src/obsidian/note-actions-ui.ts  Art (`askChoice`), Personenwahl (SuggestModal), Auswahl im Editor, Schreib-Ports des Kits
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
- **Der Ordner der Tabelle darf kein Segment mit Punkt am Anfang tragen** (`withFolder`): Obsidian führt versteckte Ordner nicht im Vault-Index, und die Lint-Regel `hardcoded-config-path` verbietet den Namen des Konfigurationsordners im Quelltext.
- **Der Rückweg setzt nie in Attribute (`href`, `src`, `title`, `alt`, `data-*`) und nie in Code ein** (Spec 2, 8.6). Beide Kopierwege (Befehl und Live Preview) setzen nur innerhalb von `restoreZones` (`src/core/restore-zones.ts`) ein.
- **Schlüssel ersetzen sperrt andere Geräte über eine Abschlussdatei der alten Kette** (`closed-<Gerät>-<Kette>.pseudo`, Inhalt nur die Markierung, `core/payload.ts`; das Kit-Format bleibt unberührt). Sie liegt unter dem gelesenen Höchststand der alten Kette plus `CLOSING_LEAD` = 64 (ein Gerät, das bei Sync-Verzug bis zu 64 Stände weitergedreht hat, öffnet sie noch; darüber nicht, Grenze benannt in den READMEs) und ist kein Gerät (Liste, Befunde, „Gerät entfernen“). `adopt` lehnt einen Code ab, sobald irgendeine Abschlussdatei seiner Kette im Ordner liegt, am Namen erkannt (`key-replaced`). Sie wird vor der neuen Fassung geschrieben (die Marke `replace-pending` davor, nach dem Schreiben zurückgelesen: weicht sie ab, bricht das Ersetzen vor der Abschlussdatei ab) und bei deren Scheitern zurückgenommen; das ersetzende Gerät heilt sich nur mit der Marke und räumt sie weg, sobald keine andere Datei der alten Kette mehr liegt. Ein Gerät, das sie mit seinem Schlüssel öffnet, ist `locked`/`key-replaced`.
- **Kein Tag ohne Freigabe von Johannes.** Die Sicherheits-Reviews nach Spec 11.3 (Kryptografie, Tabelle und Einblendung, je zwei Runden) sind in Welle 36 abgenommen; die Erstveröffentlichung 0.1.0 hängt an den iPhone-Messungen und ist von den freigegebenen Releases der Wellen ausgenommen. Eine neue Änderung an Kryptografie, Tabelle oder Einblendung braucht vor dem nächsten Tag wieder ein Review.
- **`grep` ist auf diesem Rechner ugrep und respektiert `.gitignore`;** über Repos hinweg `/usr/bin/grep`.

## Context index

- Bevor du am Design weiterarbeitest oder etwas baust: die Design-Spec im Coding-Cockpit (Note „2026-11-18-pseudonymizer-design“ unter _SDD, maintainer-lokal, CORE-META-14), besonders Abschnitt 5 (Entscheidungen) und Abschnitt 2 (Anti-Ziele).
- Bevor du am Design weiterarbeitest: die Recherche zu Kit-Bausteinen und Store-Nachbarn im Coding-Cockpit (Note „2026-11-18-recherche-kit-bausteine-und-store-nachbarn“ unter _SDD, maintainer-lokal, CORE-META-14).

## Memory

- 2026-11-19: Bau-Session (Sonnet, Linie design-pseudonymizer) setzt die Aufgaben 1 und 2 des Bauplans um.

## Abweichungen von der Leitkonvention

Keine bekannt.
