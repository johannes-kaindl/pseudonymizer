# GUI smoke checklist (maintainer material)

Runs with `npm run smoke:gui -- --port <port>` against a second Obsidian instance with its own profile; one call with `tools/obsidian-cdp/messlauf.sh` in the parent workspace builds, sets up the staging vault, starts the instance, runs the driver and stops the instance (recipe and lock in the header of `scripts/gui-smoke.ts`).
The fixture vault is `fixtures/vault/` and is rebuilt by `npm run smoke:gui -- --setup`.
All values in the fixture are invented (`Person_k3x9m2ab7q`, `Person_k3x9m2ab7q_Mail`).

This is the foundation stand: the plugin is still a shell (commands, status bar and view without an engine).
Points for setting up, locking, revealing and `transform` with a table arrive with the engine (tasks 9 to 18 of the plan); `aria-pressed` on the status bar button is only present in the state `ready`, so that is measured from task 11 on.

## Check points

| # | What is measured | How |
|---|---|---|
| 0 | Plugin loaded, restricted mode of a fresh profile lifted | `app.plugins.plugins["pseudonymizer"]` exists; the hint of `bereiteInstanzVor` is part of the line |
| C | Thirteen commands with the prefix `pseudonymizer:`, each with an icon, none unknown | `app.commands.commands` read in the renderer |
| A | `api.version === 1` and `api.status().state === "not-set-up"` | called in the renderer |
| T | `api.transform(...)` with a valid request but without a table answers `{ error: "not-ready" }` | called in the renderer, the answer is printed |
| V | The view opens through its command with exactly one leaf and three tabs (`persons`, `exceptions`, `devices`) | tab buttons read below the plugin's own root `.pseu-root` |
| S | The status bar button exists, has no `aria-pressed` in the state `not-set-up`, and a real click shows the notice of the set-up shell ("Not available yet.") | entry through the plugin's own anchor `.pseu-status`, notices cleared before the click, real mouse click, notice text read |

## Counter-probe

`SMOKE_ARGS="--ohne-plugin"` (with `messlauf.sh`) switches the plugin off after the preparation (not saved) and measures every point anyway; all six must turn red, otherwise a point measures something other than the plugin.
The driver switches the plugin back on in its cleanup.

## Runs

| Date | Obsidian | Result | Counter-probe | Notes |
|---|---|---|---|---|
| 2026-11-19 | 1.15.1 (second instance, fresh process and profile, English interface, foreign HOME with keychain link, port 9853, `messlauf.sh`) | 6 green · 0 red · 0 skipped · 0 not measured, denominator 6 (3 s) | `--ohne-plugin`: 0 green · 6 red · 0 not measured, denominator 6 (16 s), as expected: 0 `pseudonymizer fehlt`, C 0 of 13 commands, A and T no `api`, V command not executed and no tab, S no button | First run of the foundation driver. T answers `{"error":"not-ready","message":"the table is not set up"}`; S: button text "Not set up", no `aria-pressed`, notice "Not available yet.". The counter-probe keeps the point lines honest: every point reads the plugin's own object or DOM and turns red without it. |
