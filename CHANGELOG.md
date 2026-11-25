# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (without a `v` prefix).

## [Unreleased]

## [0.1.2] — 2026-11-25

### Changed

- README and help: Obsidian Sync with *Sync all other types* turned on at both devices carries the `.pseudo` files byte for byte (measured from a Mac to an iPhone); the note "not measured yet" is gone.

## [0.1.1] — 2026-11-25

### Fixed

- Community store review: the bundled cryptography modules reached WebCrypto through `globalThis`, which the store scanner reports (medium) and which lowered the review to Satisfactory. They now use `crypto` directly, the same browser object; encryption, keys and files are unchanged (code-kit 0.91.1).
- A code block that opens inside a list item and is never closed now ends where the list item ends, as CommonMark reads it. Before, the text after it counted as code up to the end of the note or up to the next fence line outside the item: it was not pseudonymized, not shown as plain text in Live Preview and not restored when copying (code-kit 0.87.0 to 0.91.1).

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
