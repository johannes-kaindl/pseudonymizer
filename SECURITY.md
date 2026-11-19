# Security Policy

## Supported Versions

Pseudonymizer is under construction and has no release yet. Once there is one, security updates are provided for the most recently released version only.

## Reporting a Vulnerability

Please do **not** report security vulnerabilities through public issues. Report them privately by email to **code@jkaindl.de** (PGP-encrypted mail is welcome). You will receive a prompt acknowledgement and updates as the fix progresses.

## Data Handling / Scope

Pseudonymizer is meant to be a fully local plugin:

- **No network access.** The plugin makes no outbound requests.
- **No telemetry, no analytics, no remote logging.**
- **Reads and writes notes** of the vault only when you ask it to pseudonymize a selection or a note.
- **Stores** its settings (`data.json`, never a name or a value) and an encrypted table in a folder of the vault. The key stays in the secret storage of your Obsidian profile.
- **Cryptography** uses WebCrypto (AES-256-GCM, HKDF-SHA-256) through building blocks that get a security review before any release.

If you have questions about the plugin's data handling beyond what is described here, the same private contact applies.
