# GUI smoke checklist (maintainer material)

Runs with `npm run smoke:gui -- --port <port>` against a second Obsidian instance with its own profile; one call with `tools/obsidian-cdp/messlauf.sh` in the parent workspace builds, sets up the staging vault, starts the instance, runs the driver and stops the instance (recipe and lock in the header of `scripts/gui-smoke.ts`).
The fixture vault is `fixtures/vault/` and is rebuilt by `npm run smoke:gui -- --setup`.
All values in the fixture are invented (`Person_k3x9m2ab7q`, `Person_k3x9m2ab7q_Mail`).

This is the stand of task 12 part a: setting up, a device file of a foreign device, the tab "Devices and keys", locking by a deleted key and entering the code are measured (points E to K).
Forgetting, replacing the key and removing a device (part b), `transform` with a table and revealing arrive with the later tasks of the plan; `aria-pressed` on the status bar button is present in the state `ready` and is measured from the revealing task on.
Points E to K change the state in this order (not set up, ready, locked, ready); they run once per instance and clean up the key of the throw-away profile in the cleanup.

## Check points

| # | What is measured | How |
|---|---|---|
| 0 | Plugin loaded, restricted mode of a fresh profile lifted | `app.plugins.plugins["pseudonymizer"]` exists; the hint of `bereiteInstanzVor` is part of the line |
| C | Thirteen commands with the prefix `pseudonymizer:`, each with an icon, none unknown | `app.commands.commands` read in the renderer |
| A | `api.version === 1` and `api.status().state === "not-set-up"` | called in the renderer |
| T | `api.transform(...)` with a valid request but without a table answers `{ error: "not-ready" }` | called in the renderer, the answer is printed |
| V | The view opens through its command with exactly one leaf and three tabs (`persons`, `exceptions`, `devices`) | tab buttons read below the plugin's own root `.pseu-root` |
| S | The status bar button exists, has no `aria-pressed` in the state `not-set-up`, and a real click opens the set-up dialog (title "Set up the table", the unchecked sync prerequisite with `.pseudo`, two language choices); Cancel leaves no key and no device file | entry through the plugin's own anchor `.pseu-status`, real mouse click, dialog read, folder read on disk |
| E | Set-up, cancelled in the code dialog before the checkbox: no device file on disk, no key, state still `not-set-up` | `set-up` command, real clicks on "Set up" and "Cancel", folder read with Node, key read through the plugin |
| R | Set-up to the end: "Continue" is disabled until the checkbox is ticked, the code shown equals the code of the stored key (stand 0), exactly one device file exists, state `ready` | real clicks on the checkbox and "Continue"; the expected code is encoded in the driver from the stored key |
| F | A device file of a foreign device (same chain, built in the driver with the kit envelope, invented name `Max Mustermann`) is dropped into the folder from outside; within 60 s `api.restore` resolves its placeholder | file written with Node, `restore` polled in the renderer, seconds printed |
| G | The tab "Devices and keys" shows both devices with "Read" and "key stand 0", the own one marked, only the button "Show recovery code"; changing the device name in the field reaches the model | tab opened by command and `showTab`, field set with a `change` event |
| L | Key cleared: state `locked` with reason `no-key`, `restore` answers `locked`, the view names the way out ("Enter code", never "Set up") and still lists both files | `keys.clear()` through the plugin, then refresh |
| K | Entering a code with a wrong check symbol saves nothing and names the reason, the dialog stays open; the right code makes the device `ready` again and `restore` resolves the foreign placeholder | `enter-recovery-code` command, value set with an `input` event, real click on "Check code" |

## Counter-probe

`SMOKE_ARGS="--ohne-plugin"` (with `messlauf.sh`) switches the plugin off after the preparation (not saved) and measures every point anyway; all twelve must turn red, otherwise a point measures something other than the plugin.
The driver switches the plugin back on in its cleanup.

## Runs

| Date | Obsidian | Result | Counter-probe | Notes |
|---|---|---|---|---|
| 2026-11-19 | 1.15.1 (second instance, fresh process and profile, English interface, foreign HOME with keychain link, port 9853, `messlauf.sh`) | 6 green · 0 red · 0 skipped · 0 not measured, denominator 6 (3 s) | `--ohne-plugin`: 0 green · 6 red · 0 not measured, denominator 6 (16 s), as expected: 0 `pseudonymizer fehlt`, C 0 of 13 commands, A and T no `api`, V command not executed and no tab, S no button | First run of the foundation driver. T answers `{"error":"not-ready","message":"the table is not set up"}`; S: button text "Not set up", no `aria-pressed`, notice "Not available yet.". The counter-probe keeps the point lines honest: every point reads the plugin's own object or DOM and turns red without it. |
| 2026-11-19 | 1.15.1 (second instance, fresh process and profile, English interface, foreign HOME with keychain link, port 9854, `messlauf.sh`) | 12 green · 0 red · 0 skipped · 0 not measured, denominator 12 (6 s) | `--ohne-plugin`: 0 green · 12 red · 0 not measured, denominator 12 (57 s), as expected | Task 12 part a. F: the foreign file is read after 1 s (vault event), restore answers `Hallo Max Mustermann`. L: `locked`/`no-key`, `restore` answers `locked`. K: the wrong check symbol keeps the dialog open and stores nothing. Two earlier runs were red for F, L and K only because the driver passed `restore` a string instead of `{ caller }`. |
