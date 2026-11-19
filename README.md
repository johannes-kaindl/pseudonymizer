# Pseudonymizer

> 🇬🇧 English · [🇩🇪 Deutsch](README.de.md)

**Replaces personal data in your notes with stable placeholders, keeps the mapping encrypted in your vault and shows the plain text while you read.**

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Docs: CC BY-SA 4.0](https://img.shields.io/badge/docs-CC%20BY--SA%204.0-lightgrey.svg)](LICENSE-DOCS)
![Platform](https://img.shields.io/badge/platform-Obsidian%201.13.0%2B%20%C2%B7%20desktop%20%26%20mobile-7c3aed)

> [!warning]
> Pseudonymizer is under construction and not published yet. There is no release, no tag and no store entry. Nothing in this repository is ready to protect real data.

Agents with file access, sync services, Git remotes and backups see your notes as plain files. Pseudonymizer replaces names, addresses, phone numbers and similar values in those files with placeholders, so that these readers see placeholders and an encrypted table instead of the people. In Obsidian itself the plain text comes back while you read.

## Features

- **Stable placeholders** — the same person carries the same placeholder everywhere, so agents can still recognise who is who without knowing the name.
- **Encrypted mapping in the vault** — the table lives in a folder of your vault, one file per device, so two devices never overwrite each other and a sync conflict cannot lose a mapping.
- **Plain text while reading** — reading view and Live Preview show the plain text in place of the placeholder; a switch per device turns it off.
- **Forgetting** — a person can be forgotten for good; see the limits below.
- **Plugin API** — other plugins can pseudonymize text before they send it somewhere and restore it afterwards.

## Requirements

- **Obsidian 1.13.0+**, desktop and mobile.
- The table is a file with its own extension in your vault. Syncing it needs a sync that transfers files of that type; the plugin will say so during setup instead of being silently incomplete.
- The plugin makes no network requests.

## Install

Not available yet. The plugin is in construction and has no release.

## Usage

There is nothing to use yet; the commands and the view arrive step by step during the build.

## What it protects and what it does not

**It protects against everyone who sees only the files of your vault.** That includes agents with file access, the sync service, a Git remote, backups and any copy of the vault folder. They see placeholders and an encrypted table.

**After you forget a person**, even you cannot rebuild the name from older copies of the table, once every device has caught up and the saved recovery code has been renewed.

**It does not protect against:**

- Someone at your unlocked Obsidian: the display shows the plain text and the commands can hand it out.
- Other plugins in the same Obsidian. The secret storage is shared between plugins, and rendered plain text is in the page.
- An agent that remote-controls the running Obsidian and reads the screen or the page.
- Linking by placeholder: the same person carries the same placeholder everywhere, so how often someone appears and who appears together stays visible. That is intended, and it is a side channel.
- Values that a connected plugin has to keep as keys, such as message IDs of imported mail.
- Whatever already sat in plain text in your sync history, in Git or in a backup before you pseudonymized it.
- Traces of an overwritten key in the local storage of your Obsidian profile, until its database cleans up. This is not measured yet.

## Configuration

Settings → Pseudonymizer. Help comes first, then the folder of the table, how copying behaves, the status bar item and which groups of detection rules are on.

## Documentation

- [Documentation index](docs/README.md)

## License

Code: AGPL-3.0-or-later ([LICENSE](LICENSE)). Documentation: CC BY-SA 4.0 ([LICENSE-DOCS](LICENSE-DOCS)). Dual-license option: [LICENSING.md](LICENSING.md).
