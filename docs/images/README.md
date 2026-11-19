# Capture contract — README images

This folder holds the images that `README.md` and `README.de.md` embed. This file is the contract: which images exist, what each one must show, and how to record them again.
The images show invented values only (`Max Mustermann`, `Anna Probe`, `Erika Musterfrau`, `max@example.org`, `030 1234567`). The interface language is English in all of them, also for `README.de.md`.

## Status

State 2026-11-19: all four images are recorded (`hero.png`, `review.png`, `persons.png`, `devices.png`), looked at one by one.
The theme is the light default (`moonstone`), set by the fixture. The status bar is cropped out of the images that would show it.
Not shown on purpose: the phone (the plugin's behaviour on the phone is not measured yet) and the setup dialog with the recovery code (a real code would show; the dialog is described in the README).

## Recipe

`npm run shots -- --setup` builds the staging vault from `fixtures/vault/`; `npm run shots -- --port <port>` records all images in one run against a second Obsidian instance with its own profile.
The recipe sets up the table through the real interface, writes a second device file with two invented persons (as a sync would), and then records each image from its own state. One call that does all of it, with the lock and a fresh profile, is `tools/obsidian-cdp/messlauf.sh` in the parent workspace with `RUNNER=shots SETUP_BEFEHL='npm run shots -- --setup'`.
Run `npm run build` before; `npm run shots` records what is installed in the vault, not what is in the working tree.

## The images

| File | Class | Referenced by | Must show |
|---|---|---|---|
| `hero.png` | hero | `README.md`, `README.de.md` (head) | The note *Call notes* twice side by side: on the left source mode with the placeholders (`Person_…`), on the right the reading view with the plain text (`Max Mustermann`, a phone number, a mail address, `Anna Probe`), each with the dotted underline. No inline title, no status bar. |
| `review.png` | feature | `README.md`, `README.de.md` (Usage, Pseudonymize) | The review window of an interactive `transform`: the summary line, one card for the name with two places and one for the phone number, the three ways (Replace, Keep here, Always keep), *Belongs to*, Cancel and the primary button. |
| `persons.png` | feature | `README.md`, `README.de.md` (Usage, Persons and devices) | The tab *Persons* with the search field and one opened entry (Anna Probe): each value with its field, its plain text and its placeholder, *Detach value*, *Merge with another entry* and *Forget*. |
| `devices.png` | feature | `README.md`, `README.de.md` (Usage, Persons and devices) | The tab *Devices and keys*: the name of this device, two device files both *Read*, the key section with the saved recovery code and the buttons *Show recovery code*, *Replace key*, *Forget a person*. |

## Conventions

The binding standard is `readme-spec.json` (block `images`) in the maintainer's workspace documentation; `npm run shots:check` runs the lint and skips itself when that folder is not there.
Images are embedded with `<img width>` and absolute raw URLs, never with bare Markdown syntax. `review.png`, `persons.png` and `devices.png` are embedded at 600 px (their files are 1200 px wide, so 600 px is the sharp size on a retina display).
