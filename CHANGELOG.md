# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (without a `v` prefix).

## [Unreleased]

## [0.1.0] — 2026-11-25

### Added

- Stable placeholders for persons and their data (mail address, phone number, address, IBAN); a value carries the identifier of a person only after you confirmed it belongs to them.
- Encrypted mapping in a folder of the vault, one file per device; the key lives in Obsidian's secret storage. Setup, recovery code, replacing the key and removing a device.
- Plain text in reading view and Live Preview without changing the file, switchable per device; commands "Copy with plain text" and "Copy with placeholders".
- Review window for new findings: replace, keep here, always keep.
- Commands to pseudonymize a selection or a whole note, including its text properties.
- Persons and exceptions: search, merge, detach a value, exception list, forget a person for good.
- Plugin API v1 (`status`, `transform`, `restore`, `containsPlaceholder`); `restore` takes the optional `skipAddressesAndCode` to leave placeholders in link targets, image URLs, bare URLs and code.
- File names (`transform` with `kind: "filename"`): the extension is never read; known values with a hyphen are replaced as a whole, and a mail address not known yet is read greedily, so a word in front of it goes into the placeholder with it (`Rechnung-max@example.org.pdf`). Known addresses, header addresses, `keep` and the exception list take precedence.
- Desktop and mobile: the phone shows plain text like the desktop (secret storage and WebCrypto measured on an iPhone). Setup tells you that Obsidian Sync needs *Sync all other types* on every device to carry the `.pseudo` files.
