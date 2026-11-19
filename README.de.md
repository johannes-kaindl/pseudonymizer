# Pseudonymizer

> [🇬🇧 English](README.md) · 🇩🇪 Deutsch

**Ersetzt personenbezogene Daten in deinen Notizen durch stabile Platzhalter, hält die Zuordnung verschlüsselt in deinem Vault und zeigt beim Lesen den Klartext.**

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Docs: CC BY-SA 4.0](https://img.shields.io/badge/docs-CC%20BY--SA%204.0-lightgrey.svg)](LICENSE-DOCS)
![Platform](https://img.shields.io/badge/platform-Obsidian%201.13.0%2B%20%C2%B7%20Desktop%20%26%20Mobil-7c3aed)

> [!warning]
> Pseudonymizer ist in Bau und noch nicht veröffentlicht. Es gibt weder ein Release noch einen Tag noch einen Store-Eintrag. Nichts in diesem Repository ist bereit, echte Daten zu schützen.

Agenten mit Dateizugriff, Sync-Dienste, Git-Remotes und Backups sehen deine Notizen als gewöhnliche Dateien. Pseudonymizer ersetzt Namen, Adressen, Telefonnummern und ähnliche Werte in diesen Dateien durch Platzhalter, damit diese Leser Platzhalter und eine verschlüsselte Tabelle sehen statt der Personen. In Obsidian selbst kommt der Klartext beim Lesen zurück.

## Features

- **Stabile Platzhalter** — dieselbe Person trägt überall denselben Platzhalter, Agenten erkennen also weiter, wer wer ist, ohne den Namen zu kennen.
- **Verschlüsselte Zuordnung im Vault** — die Tabelle liegt in einem Ordner deines Vaults, eine Datei je Gerät; zwei Geräte überschreiben sich so nie, und ein Sync-Konflikt kann keine Zuordnung verlieren.
- **Klartext beim Lesen** — Lesesicht und Live Preview zeigen statt des Platzhalters den Klartext; ein Schalter je Gerät blendet ihn aus.
- **Vergessen** — eine Person lässt sich endgültig vergessen; die Grenzen stehen unten.
- **Plugin-API** — andere Plugins können Text vor dem Versenden pseudonymisieren und danach zurücksetzen.

## Voraussetzungen

- **Obsidian 1.13.0+**, Desktop und Mobil.
- Die Tabelle ist eine Datei mit eigener Endung in deinem Vault. Sie zu synchronisieren verlangt einen Sync, der Dateien dieses Typs überträgt; das Plugin sagt es beim Einrichten, statt still unvollständig zu sein.
- Das Plugin macht keine Netzwerk-Anfragen.

## Install

Noch nicht verfügbar. Das Plugin ist in Bau und hat kein Release.

## Verwendung

Es gibt noch nichts zu benutzen; die Befehle und die Ansicht kommen Schritt für Schritt während des Baus.

## Was es schützt und was nicht

**Es schützt gegen alle, die nur die Dateien deines Vaults sehen.** Dazu zählen Agenten mit Dateizugriff, der Sync-Dienst, ein Git-Remote, Backups und jede Kopie des Vault-Ordners. Sie sehen Platzhalter und eine verschlüsselte Tabelle.

**Nachdem du eine Person vergessen hast**, kannst auch du den Namen aus älteren Kopien der Tabelle nicht mehr herstellen, sobald alle Geräte nachgezogen haben und der gesicherte Wiederherstellungs-Code erneuert ist.

**Es schützt nicht gegen:**

- Jemanden an deinem entsperrten Obsidian: Die Anzeige zeigt den Klartext, und die Befehle können ihn herausgeben.
- Andere Plugins im selben Obsidian. Der Schlüsselbund ist zwischen Plugins geteilt, und gerenderter Klartext steht in der Seite.
- Einen Agenten, der das laufende Obsidian fernsteuert und den Bildschirm oder die Seite liest.
- Verkettung über die Platzhalter: Dieselbe Person trägt überall denselben Platzhalter, wie oft jemand vorkommt und wer zusammen auftritt, bleibt sichtbar. Das ist gewollt, und es ist ein Seitenkanal.
- Werte, die ein angebundenes Plugin als Schlüssel behalten muss, etwa Nachrichten-IDs importierter Mails.
- Was schon im Klartext in deinem Sync-Verlauf, in Git oder in einem Backup lag, bevor du pseudonymisiert hast.
- Reste eines überschriebenen Schlüssels im lokalen Speicher deines Obsidian-Profils, bis dessen Datenbank aufräumt. Das ist noch nicht gemessen.

## Konfiguration

Einstellungen → Pseudonymizer. Zuerst die Hilfe, dann der Ordner der Tabelle, das Verhalten beim Kopieren, der Eintrag in der Statusleiste und welche Gruppen von Erkennungsregeln an sind.

## Dokumentation

- [Dokumentationsindex](docs/README.md)

## Lizenz

Code: AGPL-3.0-or-later ([LICENSE](LICENSE)). Dokumentation: CC BY-SA 4.0 ([LICENSE-DOCS](LICENSE-DOCS)). Doppellizenz auf Anfrage: [LICENSING.md](LICENSING.md).
