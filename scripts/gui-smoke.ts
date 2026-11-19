/**
 * GUI-Smoke — fährt die Prüfpunkte aus docs/SMOKE.md gegen ein LAUFENDES Obsidian (CORE-TEST-02 b).
 * Stand: Aufgabe 12 Teil a. Der Treiber misst, was das Plugin von außen zeigt (Befehle, API, Ansicht, Statusleiste) und, seit Aufgabe 11/12,
 * die Gerätedateien: Einrichten (Abbruch, Kontrollkästchen, Datei und Schlüssel), eine fremde Fassung im Ordner, den Reiter „Geräte und Schlüssel“,
 * die Sperre nach gelöschtem Schlüssel und die Code-Eingabe. Vergessen, Schlüssel ersetzen und Gerät entfernen (Teil b) sowie das Einblenden kommen später dazu.
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
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

import { createBilanz, parseArgs, runDriver } from "../../tools/obsidian-cdp/bilanz.js";
import { Cdp, attachTo, beimAbbruch, bereiteInstanzVor, clearNotices, clickReal, istAbgebrochen, notices, pollUntil, requireVisible, schliesseDialog } from "../../tools/obsidian-cdp/cdp.js";
import { buildVault, requireEigenerBuild, stagingVaultDir } from "../../tools/obsidian-cdp/vault.js";
import { encodePayload } from "../src/core/payload.js";
import { sealEnvelope } from "../src/vendor/kit/key-envelope.js";
import { encryptionKey, type ChainState } from "../src/vendor/kit/key-ratchet.js";
import { emptyTable, serializeTable, tableAddEntry, tableAddValue } from "../src/vendor/kit/placeholder-table.js";
import { encodeRecoveryCode } from "../src/vendor/kit/recovery-code.js";

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
  "S Statusleisten-Knopf: ohne aria-pressed im Zustand not-set-up, ein Klick öffnet den Einrichten-Dialog (Sync-Hinweis, Sprachwahl), Abbrechen ändert nichts",
  "E Einrichten, Abbruch vor dem Kontrollkästchen: weder Gerätedatei noch Schlüssel, Zustand bleibt not-set-up",
  "R Einrichten bis ready: Weiter erst nach dem Kontrollkästchen, gezeigter Code ist der gespeicherte Schlüssel (Stand 0), eigene Datei und Schlüssel stehen",
  "F Fremde Fassung im Ordner (im Treiber erzeugt, erfundener Name): binnen 60 s gelesen, restore löst ihren Platzhalter auf",
  "G Reiter „Geräte und Schlüssel“: beide Geräte mit Stand und Status Gelesen, Gerätename ändern geht in die Gerätedatei",
  "L Schlüssel gelöscht: Zustand locked (no-key), Reiter nennt den Ausweg, restore liefert locked",
  "K Code-Eingabe: ein falsches Prüfzeichen speichert nichts und nennt den Grund; der richtige Code macht das Gerät wieder ready",
] as const;

const bilanz = createBilanz({ punkte: PUNKTE });
const { record } = bilanz;
const q = (s: unknown): string => JSON.stringify(s);
const P = `app.plugins.plugins[${q(PLUGIN_ID)}]`;

/** Die Wurzel des obersten Dialogs: Titel, Text, Zahl der Auswahlknöpfe der Sprachwahl. */
const MODAL_INFO = `
  const m = document.querySelector(".modal");
  if (!m) return null;
  const titel = m.querySelector(".modal-title");
  return { titel: titel ? titel.textContent.trim() : "", text: m.textContent, radios: m.querySelectorAll('[role="radio"]').length };
`;
const MODAL_BTN = (text: string): string => `(Array.from(document.querySelectorAll(".modal button")).find((b) => b.textContent.trim() === ${q(text)}) || null)`;
const GERAETE_ZEILEN = `
  const root = document.querySelector(".pseu-root");
  const panels = root ? Array.from(root.querySelectorAll(".pseu-panel")) : [];
  const dev = panels[2];
  if (!dev) return null;
  const zeilen = Array.from(dev.querySelectorAll(".pseu-device"));
  if (zeilen.length === 0) return null;
  return { n: zeilen.length, texte: zeilen.map((z) => z.textContent), knoepfe: Array.from(dev.querySelectorAll("button")).map((b) => b.textContent.trim()) };
`;

/** Ein erfundener Platzhalter für die Person der fremden Fassung (Form wie Spec 8.1, nur erfundene Werte). */
const FREMD_ID = "m4t8c6r2vp";
const FREMD_PLATZHALTER = `Person_${FREMD_ID}`;
const FREMD_GERAET = "smoke-fremd1";
const ORDNER = "_pseudonymizer";

interface SchluesselInhalt { chainId: number[]; stand: number; key: number[] }

async function klickeKnopf(cdp: Cdp, text: string): Promise<boolean> {
  return clickReal(cdp, MODAL_BTN(text));
}

/** Zustand von außen: der Zustand der API, ob ein Schlüssel im Schlüsselbund liegt, und die Gerätedateien im Ordner auf der Platte (nicht, was das Plugin meint). */
async function zustandsInfo(cdp: Cdp, basePath: string): Promise<{ state: string | null; hatSchluessel: boolean; dateien: string[] }> {
  const r = await cdp.evaluate<{ state: string | null; hatSchluessel: boolean }>(`
    const p = ${P};
    if (!p) return { state: null, hatSchluessel: false };
    const k = p.keys.read();
    return { state: p.api.status().state, hatSchluessel: k !== null };
  `);
  const ordner = join(basePath, ORDNER);
  const dateien = existsSync(ordner) ? readdirSync(ordner).filter((n) => n.endsWith(".pseudo")).sort() : [];
  return { ...r, dateien };
}

/** Der Schlüssel dieses Geräts als Zahlenlisten (nur in der Messung; ein erfundener Schlüssel in einem Wegwerf-Profil). */
async function leseSchluessel(cdp: Cdp): Promise<SchluesselInhalt | null> {
  return cdp.evaluate<SchluesselInhalt | null>(`
    const p = ${P};
    if (!p) return null;
    const k = p.keys.read();
    if (!k || k.error) return null;
    return { chainId: Array.from(k.chainId), stand: k.stand, key: Array.from(k.key) };
  `);
}

/** Startet den Befehl „Set up“ und wartet auf den Dialog zur Sprache. */
async function starteEinrichten(cdp: Cdp): Promise<boolean> {
  await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:set-up`)}); return true;`);
  const d = await pollUntil<{ titel: string }>(cdp, MODAL_INFO, 6000, 250);
  return Boolean(d) && d!.titel === "Set up the table";
}

/** Bestätigt den Dialog zur Sprache und wartet auf den Code; liefert den gezeigten Code (mit Bindestrichen) oder `null`. */
async function weiterZumCode(cdp: Cdp): Promise<{ code: string } | null> {
  if (!(await klickeKnopf(cdp, "Set up"))) return null;
  return pollUntil<{ code: string }>(cdp, `
    const c = document.querySelector(".modal .pseu-code");
    return c ? { code: Array.from(c.querySelectorAll(".pseu-code-group, .pseu-code-sep")).map((x) => x.textContent).join("") } : null;
  `, 6000, 250);
}

/** Tippt einen Code ins Eingabefeld des Dialogs (Wert setzen und `input` auslösen, wie eine Eingabe oder das Einfügen). */
async function tippeCode(cdp: Cdp, code: string): Promise<boolean> {
  return cdp.evaluate<boolean>(`
    const f = document.querySelector(".modal .okit-prompt-field");
    if (!f) return false;
    f.focus(); f.value = ${q(code)}; f.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
}

/** Schreibt die Gerätedatei eines fremden Geräts in den Ordner, wie es der Sync täte: gleiche Kette, Stand wie der Schlüssel, mit dem Kit-Umschlag gebaut. Nur erfundene Werte. */
async function schreibeFremdeFassung(basePath: string, k: SchluesselInhalt): Promise<string | null> {
  const stand: ChainState = { chainId: Uint8Array.from(k.chainId), stand: k.stand, chainKey: Uint8Array.from(k.key) };
  const key = await encryptionKey(stand);
  if (!key.ok) return null;
  const eintrag = tableAddEntry(emptyTable(), FREMD_ID, "person");
  if (!eintrag.ok) return null;
  const wert = tableAddValue(eintrag.table, { id: FREMD_ID, field: null, text: "Max Mustermann" });
  if (!wert.ok) return null;
  const klar = encodePayload({
    format: "pseudonymizer-device", version: 1,
    device: { name: "iPhone (Treiber)", codeShownAtStand: null },
    vault: { language: "de" },
    table: serializeTable(wert.table),
  });
  const sealed = await sealEnvelope(key.value, { deviceId: FREMD_GERAET, chainId: stand.chainId, stand: stand.stand }, klar);
  if (!sealed.ok) return null;
  const ordner = join(basePath, ORDNER);
  mkdirSync(ordner, { recursive: true });
  const datei = `${FREMD_GERAET}.pseudo`;
  writeFileSync(join(ordner, datei), sealed.bytes);
  return datei;
}

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
      await schliesseDialog(cdp);
      // Der Schlüssel der Messung bleibt nicht im Schlüsselbund des Wegwerf-Profils stehen.
      await cdp.evaluate(`const p = ${P}; if (p && p.keys) p.keys.clear(); return true;`);
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
    const dialog = geklickt ? await pollUntil<{ titel: string; text: string; radios: number }>(cdp, MODAL_INFO, 6000, 250) : null;
    const dialogOk = Boolean(dialog) && dialog!.titel === "Set up the table" && /Not checked/.test(dialog!.text) && dialog!.text.includes(".pseudo") && dialog!.radios === 2;
    const abgebrochen = dialog ? await klickeKnopf(cdp, "Cancel") : false;
    const zu = abgebrochen ? await pollUntil<boolean>(cdp, `return document.querySelectorAll(".modal").length === 0;`, 4000, 200) : null;
    const nachS = await zustandsInfo(cdp, info.basePath);
    record("S Statusleisten-Knopf: ohne aria-pressed im Zustand not-set-up, ein Klick öffnet den Einrichten-Dialog (Sync-Hinweis, Sprachwahl), Abbrechen ändert nichts",
      Boolean(knopf) && knopf!.pressed === null && geklickt && dialogOk && Boolean(zu) && nachS.state === "not-set-up" && !nachS.hatSchluessel && nachS.dateien.length === 0,
      `Knopf=${q(knopf)}, geklickt=${geklickt}, Dialog=${q(dialog ? { titel: dialog.titel, radios: dialog.radios, syncHinweis: /Not checked/.test(dialog.text), endung: dialog.text.includes(".pseudo") } : null)}, zu=${Boolean(zu)}, danach=${q(nachS)}`);
    await clearNotices(cdp);

    // --- E ---
    console.log("\nE · Einrichten, Abbruch");
    const eStart = await starteEinrichten(cdp);
    const codeDialog = eStart ? await weiterZumCode(cdp) : null;
    const eAbbruch = codeDialog ? await klickeKnopf(cdp, "Cancel") : false;
    const eZu = eAbbruch ? await pollUntil<boolean>(cdp, `return document.querySelectorAll(".modal").length === 0;`, 4000, 200) : null;
    await new Promise((r) => setTimeout(r, 500));
    const nachE = await zustandsInfo(cdp, info.basePath);
    record("E Einrichten, Abbruch vor dem Kontrollkästchen: weder Gerätedatei noch Schlüssel, Zustand bleibt not-set-up",
      eStart && Boolean(codeDialog) && eAbbruch && Boolean(eZu) && nachE.state === "not-set-up" && !nachE.hatSchluessel && nachE.dateien.length === 0,
      `Dialog zur Sprache=${eStart}, Code gezeigt=${Boolean(codeDialog)}, Abbrechen geklickt=${eAbbruch}, danach=${q(nachE)}`);
    await clearNotices(cdp);

    // --- R ---
    console.log("\nR · Einrichten bis ready");
    const rStart = await starteEinrichten(cdp);
    const rCode = rStart ? await weiterZumCode(cdp) : null;
    const weiterVorher = rCode ? await cdp.evaluate<boolean | null>(`const b = ${MODAL_BTN("Continue")}; return b ? Boolean(b.disabled) : null;`) : null;
    const gekreuzt = rCode ? await clickReal(cdp, `document.querySelector(".modal .pseu-code-confirm input")`) : false;
    const weiterNachher = gekreuzt ? await cdp.evaluate<boolean | null>(`const b = ${MODAL_BTN("Continue")}; return b ? Boolean(b.disabled) : null;`) : null;
    const weiterGeklickt = gekreuzt && weiterNachher === false ? await klickeKnopf(cdp, "Continue") : false;
    const bereit = weiterGeklickt ? await pollUntil<boolean>(cdp, `const p = ${P}; return Boolean(p) && p.api.status().state === "ready";`, 10_000, 250) : null;
    const nachR = await zustandsInfo(cdp, info.basePath);
    const schluessel = await leseSchluessel(cdp);
    const erwarteterCode = schluessel ? encodeRecoveryCode({ chainId: Uint8Array.from(schluessel.chainId), stand: schluessel.stand, key: Uint8Array.from(schluessel.key) }) : null;
    const gezeigt = rCode?.code ?? null;
    const codeGleich = erwarteterCode !== null && erwarteterCode.ok && gezeigt === erwarteterCode.code;
    record("R Einrichten bis ready: Weiter erst nach dem Kontrollkästchen, gezeigter Code ist der gespeicherte Schlüssel (Stand 0), eigene Datei und Schlüssel stehen",
      weiterVorher === true && weiterNachher === false && Boolean(bereit) && schluessel !== null && schluessel.stand === 0 && codeGleich && nachR.dateien.length === 1 && nachR.state === "ready",
      `Weiter gesperrt vorher=${weiterVorher}, nachher=${weiterNachher}, ready=${Boolean(bereit)}, Schlüssel-Stand=${schluessel?.stand ?? null}, gezeigter Code = gespeicherter Schlüssel: ${codeGleich}, danach=${q(nachR)}`);
    await clearNotices(cdp);

    // --- F ---
    console.log("\nF · Fremde Fassung");
    const fremd = schluessel ? await schreibeFremdeFassung(info.basePath, schluessel) : null;
    const t0 = Date.now();
    const gelesen = fremd ? await pollUntil<{ text: string; restored: unknown; unknown: unknown }>(cdp, `
      const p = ${P};
      if (!p) return null;
      const r = p.api.restore(${q(`Hallo ${FREMD_PLATZHALTER}`)}, { caller: "gui-smoke" });
      return r && r.text === ${q("Hallo Max Mustermann")} ? r : null;
    `, 60_000, 1000) : null;
    const sekunden = Math.round((Date.now() - t0) / 100) / 10;
    record("F Fremde Fassung im Ordner (im Treiber erzeugt, erfundener Name): binnen 60 s gelesen, restore löst ihren Platzhalter auf",
      fremd !== null && Boolean(gelesen),
      `Datei=${fremd ?? "nicht geschrieben"}, restore ${gelesen ? "löst auf" : "löst nicht auf"} nach ${sekunden} s (Frist 60 s), Antwort=${q(gelesen)}`);

    // --- G ---
    console.log("\nG · Reiter Geräte und Schlüssel");
    await cdp.evaluate(`for (const l of app.workspace.getLeavesOfType("pseudonymizer-view")) l.detach(); return true;`);
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:open-view`)}); return true;`);
    await cdp.evaluate(`const l = app.workspace.getLeavesOfType("pseudonymizer-view")[0]; if (l && l.view.showTab) l.view.showTab("devices"); return true;`);
    const zeilen = await pollUntil<{ n: number; texte: string[]; knoepfe: string[] }>(cdp, GERAETE_ZEILEN, 8000, 300);
    const zweiLesbar = Boolean(zeilen) && zeilen!.n === 2 && zeilen!.texte.every((x) => x.includes("Read") && x.includes("key stand 0")) && zeilen!.texte.some((x) => x.includes("this device"));
    const nurEinKnopf = Boolean(zeilen) && q(zeilen!.knoepfe) === q(["Show recovery code"]);
    // Name ändern, wie ein Nutzer: ins Feld schreiben, `change` auslösen.
    const nameGesetzt = zeilen ? await cdp.evaluate<boolean>(`
      const i = document.querySelector(".pseu-devices-panel .setting-item input[type=text]");
      if (!i) return false;
      i.focus(); i.value = "Mac Büro"; i.dispatchEvent(new Event("change", { bubbles: true })); i.blur();
      return true;
    `) : false;
    const namenImModell = nameGesetzt ? await pollUntil<boolean>(cdp, `
      const p = ${P};
      if (!p) return false;
      const own = p.devicesModel().rows.find((r) => r.own);
      return Boolean(own) && own.name === "Mac Büro" && p.device.deviceName === "Mac Büro";
    `, 8000, 300) : null;
    record("G Reiter „Geräte und Schlüssel“: beide Geräte mit Stand und Status Gelesen, Gerätename ändern geht in die Gerätedatei",
      zweiLesbar && nurEinKnopf && nameGesetzt && Boolean(namenImModell),
      `Zeilen=${q(zeilen)}, Name gesetzt=${nameGesetzt}, Name im Modell=${Boolean(namenImModell)}`);
    await cdp.evaluate(`for (const l of app.workspace.getLeavesOfType("pseudonymizer-view")) l.detach(); return true;`);

    // --- L ---
    console.log("\nL · Schlüssel gelöscht");
    const vorL = await leseSchluessel(cdp);
    await cdp.evaluate(`const p = ${P}; if (!p) return false; p.keys.clear(); await p.refreshTables(); return true;`);
    const gesperrt = await pollUntil<{ state: string; reason: string | null }>(cdp, `
      const p = ${P};
      if (!p) return null;
      const s = p.api.status().state;
      return s === "locked" ? { state: s, reason: p.memory.reason() } : null;
    `, 8000, 300);
    const restoreGesperrt = await cdp.evaluate<unknown>(`const p = ${P}; return p ? p.api.restore("Hallo Person_m4t8c6r2vp", { caller: "gui-smoke" }) : null;`);
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:open-view`)}); return true;`);
    await cdp.evaluate(`const l = app.workspace.getLeavesOfType("pseudonymizer-view")[0]; if (l && l.view.showTab) l.view.showTab("devices"); return true;`);
    const hinweis = await pollUntil<{ text: string; knoepfe: string[]; dateien: number }>(cdp, `
      const root = document.querySelector(".pseu-root");
      const empty = root && root.querySelector(".pseu-panel:not(.is-hidden) .pseu-empty, .pseu-panel .pseu-empty");
      if (!empty) return null;
      const panels = Array.from(root.querySelectorAll(".pseu-panel"));
      const dev = panels[2];
      return { text: empty.textContent, knoepfe: Array.from(dev ? dev.querySelectorAll("button") : []).map((b) => b.textContent.trim()), dateien: dev ? dev.querySelectorAll(".pseu-device").length : 0 };
    `, 6000, 300);
    const hinweisOk = Boolean(hinweis) && /no key yet/.test(hinweis!.text) && hinweis!.knoepfe.includes("Enter code") && !hinweis!.knoepfe.includes("Set up") && hinweis!.dateien === 2;
    record("L Schlüssel gelöscht: Zustand locked (no-key), Reiter nennt den Ausweg, restore liefert locked",
      vorL !== null && Boolean(gesperrt) && gesperrt!.reason === "no-key" && (restoreGesperrt as { error?: string } | null)?.error === "locked" && hinweisOk,
      `Schlüssel vorher da=${vorL !== null}, Zustand=${q(gesperrt)}, restore=${q(restoreGesperrt)}, Reiter=${q(hinweis)}`);
    await cdp.evaluate(`for (const l of app.workspace.getLeavesOfType("pseudonymizer-view")) l.detach(); return true;`);

    // --- K ---
    console.log("\nK · Code-Eingabe");
    const richtig = vorL ? encodeRecoveryCode({ chainId: Uint8Array.from(vorL.chainId), stand: vorL.stand, key: Uint8Array.from(vorL.key) }) : null;
    const richtigerCode = richtig !== null && richtig.ok ? richtig.code : null;
    // Ein Zeichen verändert: das Prüfzeichen stimmt nicht mehr.
    const falscherCode = richtigerCode === null ? null : `${richtigerCode[0] === "0" ? "1" : "0"}${richtigerCode.slice(1)}`;
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:enter-recovery-code`)}); return true;`);
    const prompt = await pollUntil<boolean>(cdp, `return Boolean(document.querySelector(".modal .okit-prompt-field"));`, 6000, 250);
    const falschGetippt = prompt && falscherCode !== null ? await tippeCode(cdp, falscherCode) : false;
    const falschAbgeschickt = falschGetippt ? await klickeKnopf(cdp, "Check code") : false;
    const fehlerText = falschAbgeschickt ? await pollUntil<string>(cdp, `const e = document.querySelector(".modal .okit-prompt-error"); return e && e.textContent ? e.textContent : null;`, 4000, 200) : null;
    const offenGeblieben = await cdp.evaluate<boolean>(`return Boolean(document.querySelector(".modal .okit-prompt-field"));`);
    const nachFalsch = await zustandsInfo(cdp, info.basePath);
    const richtigGetippt = offenGeblieben && richtigerCode !== null ? await tippeCode(cdp, richtigerCode) : false;
    const richtigAbgeschickt = richtigGetippt ? await klickeKnopf(cdp, "Check code") : false;
    const wiederBereit = richtigAbgeschickt ? await pollUntil<boolean>(cdp, `const p = ${P}; return Boolean(p) && p.api.status().state === "ready";`, 10_000, 250) : null;
    const nachK = await zustandsInfo(cdp, info.basePath);
    const wieder = await leseSchluessel(cdp);
    const aufgeloest = await cdp.evaluate<unknown>(`const p = ${P}; return p ? p.api.restore(${q(`Hallo ${FREMD_PLATZHALTER}`)}, { caller: "gui-smoke" }) : null;`);
    record("K Code-Eingabe: ein falsches Prüfzeichen speichert nichts und nennt den Grund; der richtige Code macht das Gerät wieder ready",
      Boolean(prompt) && Boolean(fehlerText) && /check symbol/.test(fehlerText ?? "") && offenGeblieben && !nachFalsch.hatSchluessel && nachFalsch.state === "locked"
        && Boolean(wiederBereit) && wieder !== null && wieder.stand === 0 && (aufgeloest as { text?: string } | null)?.text === "Hallo Max Mustermann",
      `Eingabefeld da=${Boolean(prompt)}, Fehlertext=${q(fehlerText)}, Dialog blieb offen=${offenGeblieben}, nach falschem Code=${q(nachFalsch)}, ready danach=${Boolean(wiederBereit)}, Schlüssel-Stand=${wieder?.stand ?? null}, restore=${q(aufgeloest)}, Zustand=${q(nachK)}`);
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
