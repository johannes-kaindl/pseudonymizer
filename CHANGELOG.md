# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (without a `v` prefix).

## [Unreleased]

### Added

- Stable placeholders for persons and their data (mail address, phone number, address, IBAN); a value carries the identifier of a person only after you confirmed it belongs to them.
- Encrypted mapping in a folder of the vault, one file per device; the key lives in Obsidian's secret storage. Setup, recovery code, replacing the key and removing a device.
- Plain text in reading view and Live Preview without changing the file, switchable per device; commands "Copy with plain text" and "Copy with placeholders".
- Review window for new findings: replace, keep here, always keep.
- Commands to pseudonymize a selection or a whole note, including its text properties.
- Persons and exceptions: search, merge, detach a value, exception list, forget a person for good.
- Plugin API v1 (`status`, `transform`, `restore`, `containsPlaceholder`); `restore` takes the optional `skipAddressesAndCode` to leave placeholders in link targets, image URLs, bare URLs and code.
