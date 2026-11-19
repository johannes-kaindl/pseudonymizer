/**
 * GUI-Smoke — fährt die Prüfpunkte aus docs/SMOKE.md gegen ein LAUFENDES Obsidian (CORE-TEST-02 b).
 * Stand: Aufgabe 12 Teil b. Der Treiber misst, was das Plugin von außen zeigt (Befehle, API, Ansicht, Statusleiste) und, seit Aufgabe 11/12,
 * die Gerätedateien: Einrichten (Abbruch, Kontrollkästchen, Datei und Schlüssel), eine fremde Fassung im Ordner, den Reiter „Geräte und Schlüssel“,
 * die Sperre nach gelöschtem Schlüssel und die Code-Eingabe, dazu (Teil b) „Trotzdem einrichten“, Schlüssel ersetzen, Person vergessen (die Gerätedatei auf der Platte
 * wird mit dem Schlüssel im Treiber geöffnet und auf Klartext geprüft) und Gerät entfernen. Das Einblenden kommt später dazu.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

import { createBilanz, parseArgs, runDriver } from "../../tools/obsidian-cdp/bilanz.js";
import { Cdp, attachTo, beimAbbruch, bereiteInstanzVor, clearNotices, clickReal, istAbgebrochen, notices, pollUntil, requireVisible, schliesseDialog } from "../../tools/obsidian-cdp/cdp.js";
import { istZerstoerendJs } from "../../tools/obsidian-cdp/knoepfe.js";
import { buildVault, requireEigenerBuild, stagingVaultDir } from "../../tools/obsidian-cdp/vault.js";
import { closingDeviceId, decodeClosing, decodePayload, encodePayload } from "../src/core/payload.js";
import { openEnvelope, readEnvelopeHeader, sealEnvelope } from "../src/vendor/kit/key-envelope.js";
import { encryptionKey, type ChainState } from "../src/vendor/kit/key-ratchet.js";
import { emptyTable, serializeTable, tableAddEntry, tableAddValue, type PlaceholderTable } from "../src/vendor/kit/placeholder-table.js";
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
  "H Einrichten mit vorhandenen Dateien: Abbrechen ändert nichts, „Trotzdem einrichten“ führt zu ready mit neuer Kette, die alte eigene Datei liegt beiseite",
  "X Schlüssel ersetzen: Bestätigung, neuer Code mit Kontrollkästchen, danach ready mit neuer Kette (Stand 0), gezeigter Code = gespeicherter Schlüssel, alter Platzhalter löst weiter auf, die Abschlussdatei der alten Kette sperrt ein Gerät mit dem alten Schlüssel und steht nicht in der Geräteliste",
  "Z Person vergessen: Wahl, Warndialog mit Werten und Grenzen, danach nennt restore den Platzhalter in forgotten, Stand n+1, die Gerätedatei auf der Platte trägt keinen Klartext der Person",
  "D Gerät entfernen: Knopf im Reiter, Warnung bei nicht lesbarer Fassung, danach ist die fremde Datei weg und die eigene bleibt",
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

interface FremdePerson { id: string; name: string; mail?: string; telefon?: string }

/** Die Personen der fremden Fassung nach H: Max mit Mail und Telefon, dazu Berta (alles erfunden). */
const FREMD2_ID = "q7d2w8n4tz";
const PERSONEN: FremdePerson[] = [
  { id: FREMD_ID, name: "Max Mustermann", mail: "max@example.org", telefon: "030 1234567" },
  { id: FREMD2_ID, name: "Berta Beispiel" },
];

function tabelleVon(personen: readonly FremdePerson[]): PlaceholderTable | null {
  let t = emptyTable();
  for (const pe of personen) {
    const e = tableAddEntry(t, pe.id, "person");
    if (!e.ok) return null;
    t = e.table;
    for (const [field, text] of [[null, pe.name], ["mail", pe.mail], ["phone", pe.telefon]] as const) {
      if (text === undefined) continue;
      const w = tableAddValue(t, { id: pe.id, field, text });
      if (!w.ok) return null;
      t = w.table;
    }
  }
  return t;
}

/** Schreibt die Gerätedatei eines fremden Geräts in den Ordner, wie es der Sync täte: gleiche Kette, Stand wie der Schlüssel, mit dem Kit-Umschlag gebaut. Nur erfundene Werte. */
async function schreibeFremdeFassung(basePath: string, k: SchluesselInhalt, personen: readonly FremdePerson[] = [{ id: FREMD_ID, name: "Max Mustermann" }]): Promise<string | null> {
  const stand: ChainState = { chainId: Uint8Array.from(k.chainId), stand: k.stand, chainKey: Uint8Array.from(k.key) };
  const key = await encryptionKey(stand);
  if (!key.ok) return null;
  const tabelle = tabelleVon(personen);
  if (tabelle === null) return null;
  const klar = encodePayload({
    format: "pseudonymizer-device", version: 1,
    device: { name: "iPhone (Treiber)", codeShownAtStand: null },
    vault: { language: "de" },
    table: serializeTable(tabelle),
  });
  const sealed = await sealEnvelope(key.value, { deviceId: FREMD_GERAET, chainId: stand.chainId, stand: stand.stand }, klar);
  if (!sealed.ok) return null;
  const ordner = join(basePath, ORDNER);
  mkdirSync(ordner, { recursive: true });
  const datei = `${FREMD_GERAET}.pseudo`;
  writeFileSync(join(ordner, datei), sealed.bytes);
  return datei;
}

/** Die eigene Gerätedatei auf der Platte, geöffnet mit dem Schlüssel des Treibers (der Stand der Datei steht im Kopf; der Schlüssel muss auf diesem Stand stehen). Nur in der Messung. */
async function oeffneEigeneDatei(basePath: string, eigeneId: string, k: SchluesselInhalt): Promise<{ stand: number; chainId: string; tabelle: string } | null> {
  const pfad = join(basePath, ORDNER, `${eigeneId}.pseudo`);
  if (!existsSync(pfad)) return null;
  const bytes = Uint8Array.from(readFileSync(pfad));
  const h = readEnvelopeHeader(bytes);
  if (!h.ok) return null;
  const chainId = Array.from(h.header.chainId, (b) => b.toString(16).padStart(2, "0")).join("");
  if (h.header.stand !== k.stand) return { stand: h.header.stand, chainId, tabelle: "" };
  const key = await encryptionKey({ chainId: Uint8Array.from(k.chainId), stand: k.stand, chainKey: Uint8Array.from(k.key) });
  if (!key.ok) return null;
  const o = await openEnvelope(key.value, bytes);
  if (!o.ok) return null;
  const p = decodePayload(o.plaintext);
  if ("error" in p || typeof p.table !== "string") return null;
  return { stand: h.header.stand, chainId, tabelle: p.table };
}

/** Die Abschlussdatei der alten Kette (Spec 8.3): mit dem ALTEN Schlüssel geöffnet, wie es ein Gerät mit dem alten Schlüssel tut; `gesperrt` heißt, sie trägt die Markierung „ersetzt“ (und sonst nichts: der Inhalt ist genau die Markierung). */
async function oeffneAbschlussdatei(basePath: string, eigeneId: string, alt: SchluesselInhalt): Promise<{ vorhanden: boolean; gesperrt: boolean; nurMarkierung: boolean }> {
  const kette = alt.chainId.map((b) => b.toString(16).padStart(2, "0")).join("");
  const pfad = join(basePath, ORDNER, `${closingDeviceId(eigeneId, kette)}.pseudo`);
  if (!existsSync(pfad)) return { vorhanden: false, gesperrt: false, nurMarkierung: false };
  const bytes = Uint8Array.from(readFileSync(pfad));
  const h = readEnvelopeHeader(bytes);
  if (!h.ok || h.header.stand !== alt.stand) return { vorhanden: true, gesperrt: false, nurMarkierung: false };
  const key = await encryptionKey({ chainId: Uint8Array.from(alt.chainId), stand: alt.stand, chainKey: Uint8Array.from(alt.key) });
  if (!key.ok) return { vorhanden: true, gesperrt: false, nurMarkierung: false };
  const o = await openEnvelope(key.value, bytes);
  if (!o.ok) return { vorhanden: true, gesperrt: false, nurMarkierung: false };
  const c = decodeClosing(o.plaintext);
  return { vorhanden: true, gesperrt: "closed" in c, nurMarkierung: new TextDecoder().decode(o.plaintext) === '{"format":"pseudonymizer-closed","version":1,"replaced":true}' };
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
    const nurEinKnopf = Boolean(zeilen) && q(zeilen!.knoepfe) === q(["Remove device", "Show recovery code", "Replace key", "Forget a person"]);
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

    // --- H ---
    console.log("\nH · Trotzdem einrichten");
    const vorH = await leseSchluessel(cdp);
    await cdp.evaluate(`const p = ${P}; if (!p) return false; p.keys.clear(); await p.refreshTables(); return true;`);
    const hGesperrt = await pollUntil<boolean>(cdp, `const p = ${P}; return Boolean(p) && p.api.status().state === "locked";`, 8000, 300);
    const dateienVorH = (await zustandsInfo(cdp, info.basePath)).dateien;
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:set-up`)}); return true;`);
    const warnung = hGesperrt ? await pollUntil<{ titel: string; knoepfe: string[] }>(cdp, `
      const m = document.querySelector(".modal");
      if (!m) return null;
      const t = m.querySelector(".modal-title");
      return { titel: t ? t.textContent.trim() : "", knoepfe: Array.from(m.querySelectorAll("button")).map((b) => b.textContent.trim()) };
    `, 6000, 250) : null;
    const warnungOk = Boolean(warnung) && warnung!.titel === "Device files are already here" && q(warnung!.knoepfe) === q(["Cancel", "Enter code", "Set up anyway"]);
    const hAbbruch = warnungOk ? await klickeKnopf(cdp, "Cancel") : false;
    await pollUntil<boolean>(cdp, `return document.querySelectorAll(".modal").length === 0;`, 4000, 200);
    const nachHAbbruch = await zustandsInfo(cdp, info.basePath);
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:set-up`)}); return true;`);
    const warnung2 = hAbbruch ? await pollUntil<{ titel: string }>(cdp, MODAL_INFO, 6000, 250) : null;
    const hWeiter = warnung2 && warnung2.titel === "Device files are already here" && (await klickeKnopf(cdp, "Set up anyway"));
    const hCode = hWeiter ? await pollUntil<{ titel: string }>(cdp, MODAL_INFO, 6000, 250) : null;
    const hZurCode = hCode && hCode.titel === "Set up the table" ? await weiterZumCode(cdp) : null;
    const hGekreuzt = hZurCode ? await clickReal(cdp, `document.querySelector(".modal .pseu-code-confirm input")`) : false;
    const hGeklickt = hGekreuzt ? await klickeKnopf(cdp, "Continue") : false;
    const hBereit = hGeklickt ? await pollUntil<boolean>(cdp, `const p = ${P}; return Boolean(p) && p.api.status().state === "ready";`, 10_000, 250) : null;
    const nachH = await zustandsInfo(cdp, info.basePath);
    const neuH = await leseSchluessel(cdp);
    const ordnerH = join(info.basePath, ORDNER);
    const beiseite = existsSync(ordnerH) ? readdirSync(ordnerH).filter((n) => n.includes(".damaged-")) : [];
    const andereKette = vorH !== null && neuH !== null && q(vorH.chainId) !== q(neuH.chainId);
    record("H Einrichten mit vorhandenen Dateien: Abbrechen ändert nichts, „Trotzdem einrichten“ führt zu ready mit neuer Kette, die alte eigene Datei liegt beiseite",
      Boolean(hGesperrt) && warnungOk && hAbbruch && nachHAbbruch.state === "locked" && !nachHAbbruch.hatSchluessel && q(nachHAbbruch.dateien) === q(dateienVorH)
        && Boolean(hBereit) && andereKette && neuH!.stand === 0 && nachH.state === "ready" && nachH.dateien.length === 2 && beiseite.length === 1,
      `gesperrt=${Boolean(hGesperrt)}, Warnung=${q(warnung)}, nach Abbrechen=${q(nachHAbbruch)} (Dateien vorher ${q(dateienVorH)}), ready=${Boolean(hBereit)}, andere Kette=${andereKette}, Stand=${neuH?.stand ?? null}, Dateien=${q(nachH.dateien)}, beiseitegelegt=${q(beiseite)}`);
    await clearNotices(cdp);

    // Zwei erfundene Personen in einer fremden Fassung unter der neuen Kette; sie stehen binnen einer Frist in der Tabelle.
    const fremdH = neuH ? await schreibeFremdeFassung(info.basePath, neuH, PERSONEN) : null;
    const personenDa = fremdH ? await pollUntil<boolean>(cdp, `
      const p = ${P};
      if (!p) return null;
      const a = p.api.restore(${q(`Hallo ${FREMD_PLATZHALTER}, ${FREMD_PLATZHALTER}_Mail und Person_${FREMD2_ID}`)}, { caller: "gui-smoke" });
      return a && a.text === ${q("Hallo Max Mustermann, max@example.org und Berta Beispiel")} ? true : null;
    `, 60_000, 1000) : null;

    // --- X ---
    console.log("\nX · Schlüssel ersetzen");
    const vorX = await leseSchluessel(cdp);
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:replace-key`)}); return true;`);
    const xFrage = personenDa ? await pollUntil<{ titel: string; text: string }>(cdp, MODAL_INFO, 8000, 250) : null;
    const xFrageOk = Boolean(xFrage) && xFrage!.titel === "Replace the key?" && /locked until you enter the new recovery code/.test(xFrage!.text);
    const xBestaetigt = xFrageOk ? await klickeKnopf(cdp, "Replace key") : false;
    const xCode = xBestaetigt ? await pollUntil<{ code: string }>(cdp, `
      const c = document.querySelector(".modal .pseu-code");
      return c ? { code: Array.from(c.querySelectorAll(".pseu-code-group, .pseu-code-sep")).map((x) => x.textContent).join("") } : null;
    `, 8000, 250) : null;
    const keinSchluesselWechselVorHaken = xCode ? await leseSchluessel(cdp) : null;
    const xWeiterVorher = xCode ? await cdp.evaluate<boolean | null>(`const b = ${MODAL_BTN("Continue")}; return b ? Boolean(b.disabled) : null;`) : null;
    const xGekreuzt = xCode ? await clickReal(cdp, `document.querySelector(".modal .pseu-code-confirm input")`) : false;
    const xGeklickt = xGekreuzt ? await klickeKnopf(cdp, "Continue") : false;
    const neuX = xGeklickt ? await pollUntil<SchluesselInhalt>(cdp, `
      const p = ${P};
      if (!p) return null;
      const k = p.keys.read();
      if (!k || k.error) return null;
      const alt = ${q(vorX?.chainId ?? [])};
      const gleich = alt.length === k.chainId.length && alt.every((b, i) => b === k.chainId[i]);
      return !gleich && p.api.status().state === "ready" ? { chainId: Array.from(k.chainId), stand: k.stand, key: Array.from(k.key) } : null;
    `, 10_000, 250) : null;
    const erwartetX = neuX ? encodeRecoveryCode({ chainId: Uint8Array.from(neuX.chainId), stand: neuX.stand, key: Uint8Array.from(neuX.key) }) : null;
    const codeGleichX = erwartetX !== null && erwartetX.ok && xCode?.code === erwartetX.code;
    const eigeneId = (await cdp.evaluate<string | null>(`const p = ${P}; return p ? p.deviceId : null;`)) ?? "";
    const dateiX = neuX && eigeneId ? await oeffneEigeneDatei(info.basePath, eigeneId, neuX) : null;
    const nochDa = await cdp.evaluate<unknown>(`const p = ${P}; return p ? p.api.restore(${q(`Hallo ${FREMD_PLATZHALTER} und Person_${FREMD2_ID}`)}, { caller: "gui-smoke" }) : null;`);
    const fremdZeile = await cdp.evaluate<string | null>(`const p = ${P}; if (!p) return null; const r = p.devicesModel().rows.find((x) => !x.own); return r ? r.status : "keine Zeile";`);
    const abschluss = vorX && eigeneId ? await oeffneAbschlussdatei(info.basePath, eigeneId, vorX) : null;
    const zeilenIds = await cdp.evaluate<string[]>(`const p = ${P}; return p ? p.devicesModel().rows.map((x) => x.deviceId) : [];`);
    const abschlussKeineZeile = zeilenIds.length > 0 && zeilenIds.every((id) => !id.startsWith("closed-"));
    record("X Schlüssel ersetzen: Bestätigung, neuer Code mit Kontrollkästchen, danach ready mit neuer Kette (Stand 0), gezeigter Code = gespeicherter Schlüssel, alter Platzhalter löst weiter auf, die Abschlussdatei der alten Kette sperrt ein Gerät mit dem alten Schlüssel und steht nicht in der Geräteliste",
      Boolean(personenDa) && xFrageOk && xBestaetigt && Boolean(xCode) && xWeiterVorher === true
        && keinSchluesselWechselVorHaken !== null && q(keinSchluesselWechselVorHaken.chainId) === q(vorX?.chainId ?? []) && neuX !== null && neuX.stand === 0 && codeGleichX
        && dateiX !== null && dateiX.stand === 0 && neuX !== null && dateiX.chainId === neuX.chainId.map((b) => b.toString(16).padStart(2, "0")).join("")
        && (nochDa as { text?: string } | null)?.text === "Hallo Max Mustermann und Berta Beispiel" && fremdZeile === "not-opened"
        && abschluss !== null && abschluss.vorhanden && abschluss.gesperrt && abschluss.nurMarkierung && abschlussKeineZeile,
      `Personen da=${Boolean(personenDa)}, Frage=${q(xFrage ? xFrage.titel : null)}, bestätigt=${xBestaetigt}, Code gezeigt=${Boolean(xCode)}, Schlüssel vor dem Kontrollkästchen unverändert=${keinSchluesselWechselVorHaken !== null && q(keinSchluesselWechselVorHaken.chainId) === q(vorX?.chainId ?? [])}, Weiter gesperrt vorher=${xWeiterVorher}, neuer Schlüssel Stand=${neuX?.stand ?? null}, Code = Schlüssel: ${codeGleichX}, Datei=${q(dateiX ? { stand: dateiX.stand, kette: dateiX.chainId } : null)}, restore=${q(nochDa)}, fremde Zeile=${q(fremdZeile)}, Abschlussdatei (mit altem Schlüssel geöffnet)=${q(abschluss)}, Zeilen=${q(zeilenIds.length)} ohne Abschlussdatei=${abschlussKeineZeile}`);
    await clearNotices(cdp);

    // --- Z ---
    console.log("\nZ · Person vergessen");
    const vorZ = await leseSchluessel(cdp);
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:forget-person`)}); return true;`);
    const liste = neuX ? await pollUntil<string[]>(cdp, `
      const items = Array.from(document.querySelectorAll(".prompt .suggestion-item"));
      return items.length ? items.map((i) => i.textContent.trim()) : null;
    `, 8000, 250) : null;
    const maxItem = `(Array.from(document.querySelectorAll(".prompt .suggestion-item")).find((e) => e.textContent.includes("Max Mustermann")) || null)`;
    const listeOk = Boolean(liste) && liste!.length === 2 && liste!.some((x) => x.includes("Max Mustermann")) && liste!.some((x) => x.includes("Berta Beispiel"));
    const gewaehlt = listeOk ? await clickReal(cdp, maxItem) : false;
    const warndialog = gewaehlt ? await pollUntil<{ titel: string; text: string; zerstoerend: boolean }>(cdp, `
      const m = document.querySelector(".modal");
      if (!m) return null;
      const t = m.querySelector(".modal-title");
      const b = Array.from(m.querySelectorAll("button")).find((x) => x.textContent.trim() === "Forget for good");
      return { titel: t ? t.textContent.trim() : "", text: m.textContent, zerstoerend: b ? ${istZerstoerendJs("b")} : false };
    `, 8000, 250) : null;
    const wd = warndialog?.text ?? "";
    const warnOk = Boolean(warndialog) && warndialog!.titel === 'Forget "Max Mustermann"?' && warndialog!.zerstoerend
      && wd.includes("max@example.org") && wd.includes("030 1234567") && wd.includes(`Person_${FREMD_ID}_Mail`)
      && /only when the version of every device carries the mark/.test(wd) && wd.includes("Until then") && wd.includes("local storage") && wd.includes("iPhone (Treiber)");
    const zGeklickt = warnOk ? await klickeKnopf(cdp, "Forget for good") : false;
    const vergessen = zGeklickt ? await pollUntil<{ text: string; forgotten: string[] }>(cdp, `
      const p = ${P};
      if (!p) return null;
      const r = p.api.restore(${q(`Hallo ${FREMD_PLATZHALTER}`)}, { caller: "gui-smoke" });
      return r && Array.isArray(r.forgotten) && r.forgotten.length > 0 ? { text: r.text, forgotten: r.forgotten } : null;
    `, 15_000, 250) : null;
    const bertaNoch = await cdp.evaluate<unknown>(`const p = ${P}; return p ? p.api.restore(${q(`Person_${FREMD2_ID}`)}, { caller: "gui-smoke" }) : null;`);
    const nachZ = await leseSchluessel(cdp);
    const dateiZ = nachZ && eigeneId ? await oeffneEigeneDatei(info.basePath, eigeneId, nachZ) : null;
    const klartextWeg = dateiZ !== null && dateiZ.tabelle !== "" && !/Mustermann|max@example\.org|030 1234567/.test(dateiZ.tabelle) && dateiZ.tabelle.includes("Berta Beispiel");
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:open-view`)}); return true;`);
    await cdp.evaluate(`const l = app.workspace.getLeavesOfType("pseudonymizer-view")[0]; if (l && l.view.showTab) l.view.showTab("devices"); return true;`);
    const fortschritt = await pollUntil<string>(cdp, `
      const k = document.querySelector(".pseu-devices-panel .pseu-devices-key");
      return k && /caught up/.test(k.textContent) ? k.textContent : null;
    `, 8000, 300);
    record("Z Person vergessen: Wahl, Warndialog mit Werten und Grenzen, danach nennt restore den Platzhalter in forgotten, Stand n+1, die Gerätedatei auf der Platte trägt keinen Klartext der Person",
      listeOk && gewaehlt && warnOk && zGeklickt && Boolean(vergessen) && vergessen!.text === `Hallo ${FREMD_PLATZHALTER}` && vergessen!.forgotten.includes(FREMD_PLATZHALTER)
        && (bertaNoch as { text?: string } | null)?.text === "Berta Beispiel" && vorZ !== null && nachZ !== null && nachZ.stand === vorZ.stand + 1
        && dateiZ !== null && dateiZ.stand === nachZ.stand && klartextWeg
        && Boolean(fortschritt) && /1 of 2 devices have caught up/.test(fortschritt!) && /key stand 0; the current stand is 1/.test(fortschritt!),
      `Liste=${q(liste)}, gewählt=${gewaehlt}, Warndialog=${q(warndialog ? { titel: warndialog.titel, zerstoerend: warndialog.zerstoerend } : null)} Inhalt ok=${warnOk}, restore=${q(vergessen)}, Berta=${q(bertaNoch)}, Stand ${vorZ?.stand ?? null} -> ${nachZ?.stand ?? null}, Datei Stand=${dateiZ?.stand ?? null}, ohne Klartext der Person (Berta als Gegenprobe lesbar)=${klartextWeg}, Reiter=${q(fortschritt ? fortschritt.slice(0, 160) : null)}`);
    await clearNotices(cdp);

    // --- D ---
    console.log("\nD · Gerät entfernen");
    const entfernenKnopf = `document.querySelector(".pseu-devices-panel .pseu-device-remove")`;
    const dKnopf = await pollUntil<boolean>(cdp, `return Boolean(${entfernenKnopf});`, 8000, 250);
    const dEigene = await cdp.evaluate<number>(`return Array.from(document.querySelectorAll(".pseu-devices-panel .pseu-device")).filter((z) => z.textContent.includes("this device") && z.querySelector(".pseu-device-remove")).length;`);
    const dGeklickt = dKnopf ? await clickReal(cdp, entfernenKnopf) : false;
    const dFrage = dGeklickt ? await pollUntil<{ titel: string; text: string }>(cdp, MODAL_INFO, 8000, 250) : null;
    const dFrageOk = Boolean(dFrage) && dFrage!.titel === 'Remove device "iPhone (Treiber)"?' && /cannot be read/.test(dFrage!.text) && /lost with it/.test(dFrage!.text);
    const dBestaetigt = dFrageOk ? await klickeKnopf(cdp, "Remove device") : false;
    const dWeg = dBestaetigt ? await pollUntil<boolean>(cdp, `return document.querySelectorAll(".pseu-devices-panel .pseu-device").length === 1;`, 10_000, 250) : null;
    const nachD = await zustandsInfo(cdp, info.basePath);
    record("D Gerät entfernen: Knopf im Reiter, Warnung bei nicht lesbarer Fassung, danach ist die fremde Datei weg und die eigene bleibt",
      Boolean(dKnopf) && dEigene === 0 && dGeklickt && dFrageOk && dBestaetigt && Boolean(dWeg) && nachD.state === "ready"
        && !nachD.dateien.includes(`${FREMD_GERAET}.pseudo`) && nachD.dateien.includes(`${eigeneId}.pseudo`),
      `Knopf da=${Boolean(dKnopf)}, Knopf an der eigenen Zeile=${dEigene}, Dialog=${q(dFrage ? dFrage.titel : null)} Warnung ok=${dFrageOk}, bestätigt=${dBestaetigt}, Zeile weg=${Boolean(dWeg)}, Dateien=${q(nachD.dateien)}`);
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
