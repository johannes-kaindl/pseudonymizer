/**
 * GUI-Smoke — fährt die Prüfpunkte aus docs/SMOKE.md gegen ein LAUFENDES Obsidian (CORE-TEST-02 b).
 * Stand: Grundstock (Aufgabe 8 des Bauplans). Das Plugin ist noch eine Hülle; der Treiber misst, was es von außen zeigt:
 * Befehle, API, Ansicht, Statusleiste. Mit der Engine kommen die Punkte für Einrichten, Sperre und Einblenden dazu.
 *
 * ## Zweitinstanz (eigenes Profil, eigener Port — NICHT die reguläre Instanz anfassen; `--port` ist Pflicht)
 *
 * Ein Aufruf statt der Schritte: `tools/obsidian-cdp/messlauf.sh` im Dach (Rezept und Lock im Kopf der Datei):
 * `REPO=pseudonymizer PORT=<Port aus dem Bereich der Linie>`; für die Gegenprobe zusätzlich `SMOKE_ARGS="--ohne-plugin"`.
 *
 * Gegenprobe `--ohne-plugin`: schaltet das Plugin nach dem Vorbereiten aus (nicht gespeichert) und misst alle Punkte trotzdem;
 * jeder Punkt muss rot werden, sonst misst er nichts vom Plugin.
 * Bilanz: `createBilanz` mit Soll-Liste. Exit 1 bei Rot oder „nichts gemessen“, Exit 2 bei Abbruch.
 */
import { join } from "node:path";
import { cwd } from "node:process";

import { createBilanz, parseArgs, runDriver } from "../../tools/obsidian-cdp/bilanz.js";
import { Cdp, attachTo, beimAbbruch, bereiteInstanzVor, clearNotices, clickReal, istAbgebrochen, notices, pollUntil, requireVisible } from "../../tools/obsidian-cdp/cdp.js";
import { buildVault, requireEigenerBuild, stagingVaultDir } from "../../tools/obsidian-cdp/vault.js";

const REPO_NAME = "pseudonymizer";
const PLUGIN_ID = "pseudonymizer";
const REPO_ROOT = cwd();
const FIXTURE_DIR = join(REPO_ROOT, "fixtures/vault");

/** Die dreizehn Befehle, unabhängig von `src/core/commands.ts` aufgeschrieben (der Treiber prüft das Plugin, nicht seine eigene Quelle). */
const COMMAND_IDS = [
  "toggle-plaintext", "pseudonymize-selection", "pseudonymize-note", "search-plaintext", "lookup-placeholder", "copy-plaintext", "copy-placeholders",
  "forget-person", "show-recovery-code", "enter-recovery-code", "replace-key", "open-view", "set-up",
] as const;

const PUNKTE = [
  "0 Plugin geladen (Restricted-Mode-Guard)",
  "C Dreizehn Befehle mit Symbol in app.commands.commands",
  "A API v1: version 1 und status().state not-set-up",
  "T transform ohne Einrichtung liefert { error: not-ready }",
  "V Die Ansicht öffnet mit drei Reitern",
  "S Statusleisten-Knopf: ohne aria-pressed im Zustand not-set-up, ein Klick zeigt die Notice der Einrichtungs-Hülle",
] as const;

const bilanz = createBilanz({ punkte: PUNKTE });
const { record } = bilanz;
const q = (s: unknown): string => JSON.stringify(s);
const P = `app.plugins.plugins[${q(PLUGIN_ID)}]`;

function setup(): void {
  const vaultDir = stagingVaultDir(REPO_NAME);
  const log = buildVault({ repoRoot: REPO_ROOT, vaultDir, fixtureDir: FIXTURE_DIR, pluginId: PLUGIN_ID });
  console.log(`Staging-Vault gebaut: ${vaultDir}`);
  for (const l of log) console.log(`  · ${l}`);
  console.log("\nZweitinstanz starten (Rezept im Dateikopf), dann:\n  npm run smoke:gui -- --port <Port>");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.has("setup")) { setup(); return; }
  const portArg = args.value("port");
  if (!portArg || !Number.isInteger(Number(portArg))) throw new Error("--port <Port> ist Pflicht (Zweitinstanz) — kein Standardport.");
  const port = Number(portArg);
  const gegenprobe = args.has("ohne-plugin");

  console.log(`GUI-Smoke pseudonymizer — Obsidian auf Port ${port}${gegenprobe ? " (GEGENPROBE: Plugin aus)" : ""}`);
  const cdp = await attachTo("workspace", port, REPO_NAME);
  if (!cdp) throw new Error(`Kein Obsidian-Hauptfenster auf Port ${port} für Vault „${REPO_NAME}“.`);

  const warnungen: string[] = [];
  const zustandZurueck = async (): Promise<void> => {
    try {
      await cdp.evaluate(`for (const l of app.workspace.getLeavesOfType("pseudonymizer-view")) l.detach(); return true;`);
      await clearNotices(cdp);
      if (gegenprobe) await cdp.evaluate(`try { await app.plugins.enablePlugin(${q(PLUGIN_ID)}); } catch {} return true;`);
    } catch { console.log("  ! Aufräumen fehlgeschlagen — Staging-Vault mit --setup neu bauen"); }
  };
  const zustand = beimAbbruch(zustandZurueck, "Ansicht schließen, Notices räumen, Plugin wieder einschalten");
  try {
    await requireVisible(cdp);
    const klar = await bereiteInstanzVor(cdp, { pluginIds: [PLUGIN_ID], nurVault: REPO_NAME, sprache: "en" });
    console.log(`  (${klar.hinweis})`);
    const info = await cdp.evaluate<{ name: string; basePath: string; configDir: string }>(`return { name: app.vault.getName(), basePath: app.vault.adapter.basePath, configDir: app.vault.configDir };`);
    console.log(`Vault: ${info.name} (${info.basePath})\n`);
    requireEigenerBuild(join(info.basePath, info.configDir, "plugins", PLUGIN_ID, "main.js"), join(REPO_ROOT, "main.js"), (m) => warnungen.push(m));

    // --- 0 ---
    console.log("0 · Grundlage");
    // Die Gegenprobe läuft erst nach dem Laden: „Plugin aus“ heißt, dass es zuvor an war und der Punkt es nun nicht mehr findet.
    if (gegenprobe) await cdp.evaluate(`await app.plugins.disablePlugin(${q(PLUGIN_ID)}); return true;`);
    const geladen = (await cdp.evaluate<{ g: boolean }>(`return { g: Boolean(${P}) };`)).g;
    record("0 Plugin geladen (Restricted-Mode-Guard)", geladen, geladen ? `Vault ${info.name} (${klar.hinweis})` : `${PLUGIN_ID} fehlt — ${klar.hinweis}`);
    if (!geladen && !gegenprobe) throw new Error("Ohne geladenes Plugin ist jeder weitere Punkt gegenstandslos.");

    // --- C ---
    console.log("\nC · Befehle");
    const cmds = await cdp.evaluate<{ gesamt: number; fehlt: string[]; ohneSymbol: string[]; unbekannt: string[] }>(`
      const soll = ${q(COMMAND_IDS)}.map((id) => ${q(`${PLUGIN_ID}:`)} + id);
      const alle = app.commands.commands || {};
      const eigene = Object.keys(alle).filter((id) => id.startsWith(${q(`${PLUGIN_ID}:`)}));
      return {
        gesamt: eigene.length,
        fehlt: soll.filter((id) => !alle[id]),
        ohneSymbol: soll.filter((id) => alle[id] && !alle[id].icon),
        unbekannt: eigene.filter((id) => !soll.includes(id)),
      };
    `);
    record("C Dreizehn Befehle mit Symbol in app.commands.commands",
      cmds.gesamt === COMMAND_IDS.length && cmds.fehlt.length === 0 && cmds.ohneSymbol.length === 0 && cmds.unbekannt.length === 0,
      `Befehle mit Präfix=${cmds.gesamt} von ${COMMAND_IDS.length}, fehlen=${q(cmds.fehlt)}, ohne Symbol=${q(cmds.ohneSymbol)}, unbekannt=${q(cmds.unbekannt)}`);

    // --- A ---
    console.log("\nA · API");
    const api = await cdp.evaluate<{ da: boolean; version: unknown; state: unknown }>(`
      const api = ${P} && ${P}.api;
      if (!api) return { da: false, version: null, state: null };
      let state = null;
      try { state = api.status().state; } catch (e) { state = "Ausnahme: " + e.message; }
      return { da: true, version: api.version, state };
    `);
    record("A API v1: version 1 und status().state not-set-up", api.da && api.version === 1 && api.state === "not-set-up",
      `api da=${api.da}, version=${q(api.version)}, status().state=${q(api.state)}`);

    // --- T ---
    console.log("\nT · transform ohne Einrichtung");
    const tr = await cdp.evaluate<{ da: boolean; wert: unknown }>(`
      const api = ${P} && ${P}.api;
      if (!api) return { da: false, wert: null };
      try {
        const wert = await api.transform({ caller: "gui-smoke", documentKey: "smoke.md", interactive: false, parts: [{ id: "p1", kind: "text", value: "Hallo Max Mustermann" }] });
        return { da: true, wert };
      } catch (e) { return { da: true, wert: { ausnahme: String(e && e.message) } }; }
    `);
    const fehler = (tr.wert as { error?: unknown } | null)?.error;
    record("T transform ohne Einrichtung liefert { error: not-ready }", tr.da && fehler === "not-ready", `api da=${tr.da}, Antwort=${q(tr.wert)}`);

    // --- V ---
    console.log("\nV · Ansicht");
    await cdp.evaluate(`for (const l of app.workspace.getLeavesOfType("pseudonymizer-view")) l.detach(); return true;`);
    const ausgefuehrt = await cdp.evaluate<boolean>(`return Boolean(app.commands.executeCommandById(${q(`${PLUGIN_ID}:open-view`)}));`);
    const reiter = await pollUntil<{ tabs: string[]; ansichten: number }>(cdp, `
      const root = document.querySelector(".pseu-root");
      if (!root) return null;
      const tabs = Array.from(root.querySelectorAll('.okit-hub-tabs [role="tab"]')).map((b) => b.getAttribute("data-tab"));
      return tabs.length ? { tabs, ansichten: app.workspace.getLeavesOfType("pseudonymizer-view").length } : null;
    `, 8000, 300);
    const erwartet = ["persons", "exceptions", "devices"];
    record("V Die Ansicht öffnet mit drei Reitern", Boolean(reiter) && reiter!.ansichten === 1 && q(reiter!.tabs) === q(erwartet),
      `Befehl ausgeführt=${ausgefuehrt}, Reiter=${q(reiter?.tabs ?? null)}, Ansichten=${reiter?.ansichten ?? 0}`);
    await cdp.evaluate(`for (const l of app.workspace.getLeavesOfType("pseudonymizer-view")) l.detach(); return true;`);

    // --- S ---
    console.log("\nS · Statusleiste");
    // Einstieg über den plugin-eigenen Anker `.pseu-status`, nicht über eine nackte Obsidian-Klasse.
    const knopfSel = `document.querySelector(".status-bar .pseu-status .pseu-status-btn")`;
    const knopf = await pollUntil<{ text: string; pressed: string | null; label: string | null }>(cdp, `
      const b = ${knopfSel};
      return b ? { text: b.textContent.trim(), pressed: b.getAttribute("aria-pressed"), label: b.getAttribute("aria-label") } : null;
    `, 5000, 300);
    await clearNotices(cdp);
    const geklickt = knopf ? await clickReal(cdp, knopfSel) : false;
    let meldung = "";
    if (geklickt) {
      await pollUntil(cdp, `return document.querySelectorAll(".notice").length > 0;`, 3000, 200);
      meldung = await notices(cdp);
    }
    record("S Statusleisten-Knopf: ohne aria-pressed im Zustand not-set-up, ein Klick zeigt die Notice der Einrichtungs-Hülle",
      Boolean(knopf) && knopf!.pressed === null && geklickt && meldung === "Not available yet.",
      `Knopf=${q(knopf)}, geklickt=${geklickt}, Notice=${q(meldung)}`);
    await clearNotices(cdp);
  } finally {
    await zustand.schliesse();
    if (istAbgebrochen()) return;
    cdp.close();
  }
  for (const wn of warnungen) console.log(`  ⚠ ${wn}`);
  bilanz.abschluss();
}

runDriver(main);
