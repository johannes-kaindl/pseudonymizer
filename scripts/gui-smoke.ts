/**
 * GUI-Smoke — fährt die Prüfpunkte aus docs/SMOKE.md gegen ein LAUFENDES Obsidian (CORE-TEST-02 b).
 * Stand: gebündelter Lauf der Aufgaben 14 bis 18 am 2026-11-19 (52 Punkte, grün; Gegenprobe 52 rot, `docs/SMOKE.md` § Runs). Fehlersuche: `--stop-nach <Punkt>` hält den Treiber nach einem Punkt an (weiter mit `touch /tmp/pseu-weiter`). Der Treiber misst, was das Plugin von außen zeigt (Befehle, API, Ansicht, Statusleiste) und, seit Aufgabe 11/12,
 * die Gerätedateien: Einrichten (Abbruch, Kontrollkästchen, Datei und Schlüssel), eine fremde Fassung im Ordner, den Reiter „Geräte und Schlüssel“,
 * die Sperre nach gelöschtem Schlüssel und die Code-Eingabe, dazu (Teil b) „Trotzdem einrichten“, Schlüssel ersetzen, Person vergessen (die Gerätedatei auf der Platte
 * wird mit dem Schlüssel im Treiber geöffnet und auf Klartext geprüft) und Gerät entfernen; seit Aufgabe 16 die Lesesicht (Einblenden, Umschalter, Sperren, Vergessen, Kopieren, Kopier-Befehle, Popout, Zug mit der Maus, PDF-Export). Live Preview folgt mit Aufgabe 17.
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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd } from "node:process";

import { createBilanz, parseArgs, runDriver } from "../../tools/obsidian-cdp/bilanz.js";
import { Cdp, attachTo, beimAbbruch, bereiteInstanzVor, clearNotices, clickReal, istAbgebrochen, notices, pollUntil, requireVisible, schliesseDialog } from "../../tools/obsidian-cdp/cdp.js";
import { istZerstoerendJs } from "../../tools/obsidian-cdp/knoepfe.js";
import { boxOf, capture, setWindowSize } from "../../tools/obsidian-cdp/shot.js";
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
  "W Lesesicht: Platzhalter im Fließtext zeigt Klartext mit gepunkteter Unterstreichung und dem Platzhalter im Tooltip; in Code, pre, Link-Ziel, Bild-URL, title und alt bleibt der Platzhalter, kein Attribut und kein Netzabruf trägt Klartext; ein noch nicht lesbarer Wert nennt den Grund, ein unbekannter bleibt Text",
  "U Umschalter „Klartext zeigen“: wechselt alle sichtbaren Stellen ohne Neuaufbau (dieselben Knoten), im DOM steht bei „aus“ kein Klartext, die Datei der Notiz bleibt byte-gleich (Prüfsumme vorher und nachher)",
  "Y Kopieren in der Lesesicht (echte Auswahl, copy-Ereignis mit DataTransfer): Vorgabe Platzhalter, auch bei nur teilweise erfasster Stelle und bei zwei gleichen Texten nebeneinander; „was ich sehe“ liefert Klartext, bei ausgeblendetem Klartext wieder Platzhalter",
  "M Befehle „Mit Klartext kopieren“ und „Mit Platzhaltern kopieren“: Auswahl und ganze Notiz in der Zwischenablage, ein unlesbarer Platzhalter hält alles zurück und steht (ohne Klartext) in der Notice",
  "N Sperren und Entsperren schalten gezeigte Stellen ohne Neuöffnen um: gesperrt nicht lesbar mit Grund und ohne Klartext im DOM, entsperrt wieder Klartext",
  "O Popout-Fenster: Umschalter und Kopieren wirken auch im eigenen document des Popouts",
  "Q Ziehen markierten Texts aus der Lesesicht (dragstart mit vorgefülltem DataTransfer; ein echter Mauszug beginnt über CDP keinen Zug aus Text): der Zug trägt in der Vorgabe den Platzhalter, nie den Klartext",
  "P PDF-Export (Speicherdialog im Renderer ersetzt): mit „Klartext zeigen“ trägt das PDF den Klartext und nicht den Platzhalter, ohne den Platzhalter und nicht den Klartext",
  "LP1 Live Preview: Platzhalter mitten in der Zeile als Widget mit Klartext (gepunktete Linie, der Platzhalter im Tooltip und im Attribut), nicht lesbare gestrichelt, Unbekanntes bleibt Text, kein Attribut trägt Klartext",
  "LP2 Cursor oder Auswahl auf dem Platzhalter zeigt den Platzhalter (die beiden anderen Stellen der Zeile bleiben Widgets); weg vom Platzhalter kommt das Widget zurück",
  "LP3 Quelltextmodus zeigt die Platzhalter (kein Widget); zurück in Live Preview erscheinen die Widgets wieder, ohne die Notiz neu zu öffnen",
  "LP4 Kopieren und Ausschneiden aus Live Preview (echtes copy- und cut-Ereignis am Editor, eigene Zwischenablage): Vorgabe liefert den Dateitext; „was ich sehe“ mit Klartext die eingeblendete Fassung, ausgeblendet oder bei Unbekanntem den Dateitext, Inline-Code und Zäune bleiben Platzhalter; Ausschneiden löscht die Auswahl wie ohne Plugin",
  "LP5 Umschalter, Sperren, Entsperren und Cursor-Bewegung in der offenen Live Preview ohne Neuöffnen: aus zeigt die Platzhalter ohne Klartext im DOM, gesperrt alle Stellen nicht lesbar, entsperrt wieder Klartext; Datei und Editorinhalt bleiben byte-gleich (SHA-256)",
  "LP6 Platzhalter in einem Zaun (flach und Tilde, auch hinter einer Leerzeile) und in Inline-Code bleibt Platzhalter: keine Zeile dort trägt ein Widget, die Berta-Stelle neben dem Inline-Code schon",
  "LP7 Notiz mit 10 000 Zeilen und 500 Platzhaltern (Zäune mit weiteren darin): die Zeit je Tastendruck liegt gegen die gleich große Notiz ohne Platzhalter unter dem Kit-Schwellenwert (Aufschlag unter 8 ms, Median unter 50 ms); im DOM stehen nur die Widgets des sichtbaren Bereichs; Scrollen und Cursor lassen die Datei byte-gleich",
  "LP8 Vergessen in der offenen Live Preview: die Stellen der vergessenen Person schalten ohne Neuöffnen auf „vergessen“ (Klasse, doppelte Linie, Tooltip, Text der Platzhalter), kein Klartext von ihr bleibt im DOM, die Stelle der anderen Person bleibt lesbar, Unbekanntes bleibt Text",
  "Z Person vergessen: Wahl, Warndialog mit Werten und Grenzen, danach nennt restore den Platzhalter in forgotten, Stand n+1, die Gerätedatei auf der Platte trägt keinen Klartext der Person",
  "J Vergessen in der offenen Lesesicht: die Stellen der vergessenen Person schalten ohne Neuöffnen auf „vergessen“ (Klasse, Tooltip, kein Klartext im DOM), die der anderen Person bleiben lesbar",
  "D Gerät entfernen: Knopf im Reiter, Warnung bei nicht lesbarer Fassung, danach ist die fremde Datei weg und die eigene bleibt",
  "B1 Prüffenster: ein transform mit interactive true öffnet es; eine Karte je Wert (Name mit zwei Stellen, eine Nummer), Kopfzeile mit Zahlen, die drei Wege als Radiogruppe mit Ersetzen als Vorgabe, „Gehört zu“ ohne Vorschlag auf „niemandem“, Abbrechen links, „übernehmen“ rechts als mod-cta",
  "B2 Abbrechen und Esc (echte Taste): transform liefert cancelled, die Gerätedatei auf der Platte bleibt byte-gleich, ein unbeaufsichtigter transform fragt weiter (deferred)",
  "B3 Wege und übernehmen: „Hier lassen“ lässt den Namen stehen und gilt nur für denselben documentKey, die Nummer wird ersetzt und steht in der Gerätedatei auf der Platte (mit dem Schlüssel geöffnet), die Platte änderte sich erst mit „übernehmen“",
  "B4 Text ansehen und markieren: eine Auswahl im Text wird als Person hinzugefügt, jede freie Stelle wird eine Karte und nach „übernehmen“ mit einer Kennung ersetzt, ein längeres Wort bleibt",
  "B5 Bilder des Prüffensters: Desktop und 402 px Breite (am Telefon bildschirmfüllend, Wege als Tippflächen von mindestens 44 px gemessen); die Bilder sind selbst anzusehen",
  "NA1 Auswahl pseudonymisieren im Quelltext: Art und Person gewählt, die Auswahl wird durch einen Platzhalter ersetzt, die Datei auf der Platte folgt, restore löst ihn auf, ein Rückgängig stellt den Text her",
  "NA2 Auswahl pseudonymisieren in Live Preview: dasselbe Ergebnis wie im Quelltext",
  "NA3 Diese Notiz pseudonymisieren mit Prüffenster und „übernehmen“: Frontmatter und Text in genau einem Schreibvorgang der Notiz, die Eigenschaft up mit dem Wikilink bleibt byte-gleich, from und cc ungequotet mit den Platzhaltern, kein Klartext mehr in der Notiz",
  "NA4 Der Eigenschaften-Bereich zeigt den Wert von from und den Listeneintrag von cc zeichengleich zur Datei",
  "NA5 Diese Notiz pseudonymisieren, im Prüffenster abgebrochen: die Notiz ist byte-gleich, die Notice nennt den Abbruch ohne Klartext",
  "NA6 Eine Notiz mit mail_id bleibt unberührt, es öffnet kein Prüffenster, die Notice verweist auf mailstone",
  "NA7 Eigenschaften, die der Kit-Leser nicht ganz liest (Fortsetzungszeile, Liste von Abbildungen, Kommentar im Wert): parseYaml auf dem Block liefert für die flachen Werte genau den gelesenen Wert und für die anderen etwas anderes, der Befehl lässt diese byte-gleich und meldet ihre Namen, Frontmatter-Zeilen gehen nicht verloren, der Rest wird pseudonymisiert",
  "AP1 Reiter Personen: die Suche (echte Eingabe) findet über Mail, Telefon in anderer Schreibweise, Namensteil und Großschreibung; ein Treffer ohne Ergebnis sagt es in Worten",
  "AP2 Reiter Personen, Detail: ein Eintrag klappt auf (aria-expanded), zeigt jeden Wert mit Feld, Klartext und Platzhalter, je Wert „Wert abhängen“, darunter Zusammenführen und Vergessen (mod-warning); kein Klartext in einem aria-label",
  "AP3 Zusammenführen aus dem Reiter: Partnerwahl, Bestätigung (nicht zerstörend), danach lösen beide Platzhalter-IDs weiter auf, die Ansicht zeigt einen Eintrag mit dem Hinweis auf beide Kennungen, die Gerätedatei auf der Platte trägt beide Namen",
  "AP4 Wert abhängen aus dem Reiter: Bestätigung, der alte Platzhalter löst weiter auf, der Wert ist ein eigener Eintrag ohne Träger und steht nicht mehr beim alten Eintrag",
  "AP5 Vergessen aus dem Reiter: derselbe Warndialog wie der Befehl, ohne Personenwahl; der abgehängte Wert fehlt in der Liste der Werte und bleibt nach dem Vergessen lesbar, die zusammengeführten IDs sind beide vergessen, die Gerätedatei trägt nur noch den abgehängten Wert",
  "AP6 Reiter Ausnahmen: Leerzustand mit „Ausnahme hinzufügen“, Eingabe im Dialog, die Liste zeigt den Text, die Gerätedatei trägt ihn und data.json nicht; Entfernen leert die Liste wieder",
  "AP7 Bilder der Reiter Personen und Ausnahmen (Desktop) und Tippflächen von mindestens 44 px am Telefon (nachgestellt über die Körperklasse is-mobile); die Bilder sind selbst anzusehen",
] as const;

const bilanz = createBilanz({ punkte: PUNKTE });
// Fehlersuche: `--stop-nach <Punkt>` hält den Treiber nach diesem Punkt an, bis die Datei `$PSEU_WEITER` (Standard /tmp/pseu-weiter) existiert, damit man den Zustand der Instanz ansehen kann.
let stopNach: string | null = null;
function haltepunkt(): void {
  const datei = process.env.PSEU_WEITER ?? "/tmp/pseu-weiter";
  console.log(`  (angehalten, weiter mit: touch ${datei})`);
  const schlaf = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 2400 && !existsSync(datei); i++) Atomics.wait(schlaf, 0, 0, 500);
  rmSync(datei, { force: true });
}
const record = (name: (typeof PUNKTE)[number], passed: boolean, detail?: string): void => {
  bilanz.record(name, passed, detail);
  if (stopNach !== null && name.split(" ")[0] === stopNach) haltepunkt();
};
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
const FREMD2_PLATZHALTER = `Person_${FREMD2_ID}`;
const PERSONEN: FremdePerson[] = [
  { id: FREMD_ID, name: "Max Mustermann", mail: "max@example.org", telefon: "030 1234567" },
  { id: FREMD2_ID, name: "Berta Beispiel" },
];

/** Zweite fremde Fassung für die Punkte AP: zwei erfundene Personen, Anna mit Mail und Telefon, damit Suche, Zusammenführen und Abhängen etwas zu tun haben. */
const GERAET2 = "smoke-fremd2";
const ANNA_ID = "h7n2p5r8st";
const ANTON_ID = "w3x6y9z4bc";
const ANNA_PLATZHALTER = `Person_${ANNA_ID}`;
const ANTON_PLATZHALTER = `Person_${ANTON_ID}`;
const PERSONEN2: FremdePerson[] = [
  { id: ANNA_ID, name: "Anna Probe", mail: "anna@example.org", telefon: "030 5550101" },
  { id: ANTON_ID, name: "Anton Probe" },
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
async function schreibeFremdeFassung(basePath: string, k: SchluesselInhalt, personen: readonly FremdePerson[] = [{ id: FREMD_ID, name: "Max Mustermann" }], ziel: { geraet: string; name: string } = { geraet: FREMD_GERAET, name: "iPhone (Treiber)" }): Promise<string | null> {
  const stand: ChainState = { chainId: Uint8Array.from(k.chainId), stand: k.stand, chainKey: Uint8Array.from(k.key) };
  const key = await encryptionKey(stand);
  if (!key.ok) return null;
  const tabelle = tabelleVon(personen);
  if (tabelle === null) return null;
  const klar = encodePayload({
    format: "pseudonymizer-device", version: 1,
    device: { name: ziel.name, codeShownAtStand: null },
    vault: { language: "de" },
    table: serializeTable(tabelle),
  });
  const sealed = await sealEnvelope(key.value, { deviceId: ziel.geraet, chainId: stand.chainId, stand: stand.stand }, klar);
  if (!sealed.ok) return null;
  const ordner = join(basePath, ORDNER);
  mkdirSync(ordner, { recursive: true });
  const datei = `${ziel.geraet}.pseudo`;
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

// ---- Lesesicht (Aufgabe 16): Notizen aus dem Fixture, in der Lesesicht geöffnet und gemessen ----

const NOTIZ_LESEN = "Lesesicht.md";
const NOTIZ_KOPIEREN = "Kopieren.md";
/** Alles, was nach Klartext aussieht (Max und seine Werte; erfunden). Steht es im DOM außerhalb eines Ersatz-Elements, in einem Attribut, in einer URL oder in der Zwischenablage der Vorgabe, ist der Punkt rot. */
const KLARTEXT_JS = String.raw`/Mustermann|max(@|%40)example|030(%20| )?1234567|Berta Beispiel/i`;
const KLARTEXT = /Mustermann|max(@|%40)example|030(%20| )?1234567|Berta Beispiel/i;
/** Nur Max und seine Werte (Berta bleibt nach dem Vergessen von Max lesbar). */
const KLARTEXT_MAX = /Mustermann|max(@|%40)example|030(%20| )?1234567/i;
const MAX = FREMD_PLATZHALTER;

/** Die Wurzel der Notiz in ihrem Blatt (Marke am Blatt-Inhalt, gesetzt von `oeffneNotiz`). */
const WURZEL = (pfad: string): string => `document.querySelector('[data-pseu-smoke=${q(pfad)}]')`;

/** Öffnet eine vorhandene Fixture-Notiz in einem neuen Tab (nie `modify`) und wartet auf ihre Ersatz-Stellen. `modus` `preview` ist die Lesesicht. */
async function oeffneNotiz(cdp: Cdp, pfad: string, modus: "preview" | "source", ersatzStellen: number, quelltext?: boolean): Promise<boolean> {
  // `quelltext` true: Quelltext-Modus, false: Live Preview (nur bei `modus` `source`); ohne Angabe gilt die Einstellung des Vaults.
  await cdp.evaluate(`
    const f = app.vault.getAbstractFileByPath(${q(pfad)});
    if (!f) return false;
    const leaf = app.workspace.getLeaf("tab");
    await leaf.openFile(f, { state: { mode: ${q(modus)}${quelltext === undefined ? "" : `, source: ${String(quelltext)}`} } });
    leaf.view.containerEl.setAttribute("data-pseu-smoke", ${q(pfad)});
    app.workspace.setActiveLeaf(leaf, { focus: true });
    return true;
  `);
  if (ersatzStellen === 0) return true;
  return Boolean(await pollUntil<boolean>(cdp, `
    const c = ${WURZEL(pfad)};
    return c && c.querySelectorAll(".okit-swap").length >= ${ersatzStellen} ? true : null;
  `, 10_000, 250));
}

/** Schließt jedes Blatt, das der Treiber geöffnet hat (auch in Popout-Fenstern). */
const SCHLIESSE_NOTIZEN = `
  const alle = [];
  app.workspace.iterateAllLeaves((l) => { if (l.view && l.view.containerEl && l.view.containerEl.getAttribute("data-pseu-smoke")) alle.push(l); });
  for (const l of alle) l.detach();
  return alle.length;
`;

interface Stelle { text: string; shown: boolean; forgotten: boolean; unreadable: boolean; title: string; linie: string; raw: string }
interface Lesestand { stellen: Stelle[]; html: string; klartextAusserhalb: boolean; klartextInAttribut: number }

/** Das Blatt einer vom Treiber geöffneten Notiz (Ausdruck im Renderer). */
const BLATT = (pfad: string): string => `app.workspace.getLeavesOfType("markdown").find((l) => l.view.containerEl.getAttribute("data-pseu-smoke") === ${q(pfad)})`;

/** Was die Lesesicht einer Notiz gerade zeigt: jede Ersatz-Stelle mit Zustand, Tooltip und berechneter Linie, dazu, ob Klartext außerhalb von Ersatz-Stellen oder in einem Attribut steht. */
const LESESTAND = (pfad: string): string => `
  const wurzel = ${WURZEL(pfad)};
  if (!wurzel) return null;
  // Das Blatt hält auch den versteckten Editor (Widgets mit Klartext, andere Klasse): gelesen wird nur die Lesesicht.
  const c = wurzel.querySelector(".markdown-preview-view") || wurzel;
  const re = ${KLARTEXT_JS};
  const stellen = Array.from(c.querySelectorAll(".okit-swap")).map((e) => ({
    text: e.textContent, shown: e.classList.contains("is-shown"), forgotten: e.classList.contains("is-forgotten"), unreadable: e.classList.contains("is-unreadable"),
    title: e.getAttribute("title") || "", linie: getComputedStyle(e).borderBottomStyle, raw: e.getAttribute("data-okit-swap") || "",
  }));
  const klon = c.cloneNode(true);
  for (const e of Array.from(klon.querySelectorAll(".okit-swap"))) e.remove();
  let attr = 0;
  for (const e of Array.from(c.querySelectorAll("*"))) for (const a of Array.from(e.attributes)) if (re.test(a.value)) attr += 1;
  return { stellen, html: c.innerHTML, klartextAusserhalb: re.test(klon.textContent), klartextInAttribut: attr };
`;

/** Die Prüfsumme der Datei einer Notiz auf der Platte (Anti-Ziel 4: Umschalten ändert keine Datei). */
function pruefsumme(basePath: string, pfad: string): string | null {
  const f = join(basePath, pfad);
  return existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : null;
}

/** Ein synthetisches `copy` mit echter Auswahl; liefert, was der Handler in die Zwischenablage gäbe. `auswahl` ist ein Ausdruck, der einen Range im Dokument `doc` liefert. */
const KOPIERE = (doc: string, auswahl: string): string => `
  const doc = ${doc};
  const range = (() => { ${auswahl} })();
  const sel = doc.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  const dt = new DataTransfer();
  const ev = new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true });
  (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement).dispatchEvent(ev);
  return { text: dt.getData("text/plain"), html: dt.getData("text/html"), abgefangen: ev.defaultPrevented };
`;
/** Auswahl: der ganze Inhalt des n-ten Absatzes der Notiz. */
const ABSATZ = (pfad: string, n: number, doc = "document"): string => `
  const p = ${WURZEL(pfad)}.querySelectorAll("p")[${String(n)}];
  const r = ${doc}.createRange(); r.selectNodeContents(p); return r;
`;

/** Die Zwischenablage des Renderers abfangen (statt der echten): Schreibaufrufe landen in `window.__pseuClip`; der Deskriptor wird gemerkt und genau so zurückgestellt
 *  (in Obsidians Renderer kann `writeText` eine eigene Eigenschaft der Instanz sein, ein `delete` risse Obsidians Wrapper heraus). */
const ZWISCHENABLAGE_AN = `
  window.__pseuClip = [];
  window.__pseuClipDesc = Object.getOwnPropertyDescriptor(navigator.clipboard, "writeText") || null;
  Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, writable: true, value: (t) => { window.__pseuClip.push(String(t)); return Promise.resolve(); } });
  return true;
`;
const ZWISCHENABLAGE_AUS = `
  if (!window.__pseuClip) return 0;
  if (window.__pseuClipDesc) Object.defineProperty(navigator.clipboard, "writeText", window.__pseuClipDesc);
  else delete navigator.clipboard.writeText;
  const n = (window.__pseuClip || []).length;
  delete window.__pseuClip; delete window.__pseuClipDesc;
  return n;
`;

/** Stellt den Schalter und die Einstellung wieder auf den Vorgabewert (nur im Arbeitsspeicher, nichts wird gespeichert). */
const SCHALTER_ZURUECK = `
  const p = ${P};
  if (!p) return false;
  p.device.setShowPlaintext(true);
  p.settings.copyMode = "placeholder";
  p.emitChange();
  return true;
`;

/** Der Zug markierten Texts aus der Lesesicht: ein `dragstart` mit einem `DataTransfer`, den der Treiber wie Chrome vorher mit der gezeigten Auswahl füllt (Klartext, text/plain und text/html); das Plugin
 *  ersetzt die Daten wie beim Kopieren. Liefert die Daten, die der Zug danach trägt. Warum nicht der echte Mauszug (`Input.setInterceptDrags`, Mausdruck, Bewegung): gemessen am 2026-11-19 (Obsidian 1.15.1,
 *  Zweitinstanz) beginnt über CDP kein Zug aus markiertem Text, weder in der Lesesicht noch in einem schlichten `div` außerhalb von Obsidian (ein `draggable`-Element löst `dragIntercepted` aus), die Maus
 *  beginnt stattdessen eine neue Auswahl. Der echte Zug bleibt Handprobe; gemessen wird hier der Handler des Plugins. */
async function messeZiehen(cdp: Cdp, pfad: string): Promise<{ items: { mimeType: string; data: string }[] } | null> {
  return cdp.evaluate<{ items: { mimeType: string; data: string }[] } | null>(`
    app.workspace.setActiveLeaf(${BLATT(pfad)}, { focus: true });
    const p = ${WURZEL(pfad)}.querySelector(".markdown-preview-view p");
    if (!p) return null;
    const ziel = p.querySelector(".okit-swap") || p;
    const r = document.createRange(); r.selectNodeContents(p);
    const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    const dt = new DataTransfer();
    // Wie Chrome vor dem Ereignis: die gezeigte Auswahl, mit eingeblendetem Klartext.
    const frag = r.cloneContents(); const div = document.createElement("div"); div.appendChild(frag);
    dt.setData("text/plain", sel.toString());
    dt.setData("text/html", div.innerHTML);
    const ev = new DragEvent("dragstart", { dataTransfer: dt, bubbles: true, cancelable: true });
    ziel.dispatchEvent(ev);
    return { items: Array.from(dt.types).map((t) => ({ mimeType: t, data: dt.getData(t) })) };
  `);
}

/** Obsidians PDF-Export einer geöffneten Notiz in eine Datei: der native Speicherdialog hält eine Zweitinstanz fest und lässt sich per CDP nicht bedienen, also ersetzt der Treiber
 *  `electron.remote.dialog.showSaveDialog` im Renderer (Etappe 0 (a), Bauplan). Wird die Ersetzung nicht wirksam, startet der Export nicht (sonst stünde der native Dialog). */
async function exportiereAlsPdf(cdp: Cdp, pfad: string, ziel: string): Promise<{ ok: boolean; grund: string }> {
  const ersetzt = await cdp.evaluate<{ ok: boolean; grund: string }>(`
    try {
      const d = window.require("electron").remote.dialog;
      if (!window.__pseuSaveOrig) window.__pseuSaveOrig = d.showSaveDialog;
      const mein = async () => ({ canceled: false, filePath: ${q(ziel)} });
      d.showSaveDialog = mein;
      return window.require("electron").remote.dialog.showSaveDialog === mein ? { ok: true, grund: "" } : { ok: false, grund: "showSaveDialog lässt sich nicht ersetzen" };
    } catch (e) { return { ok: false, grund: "electron.remote nicht erreichbar: " + String(e && e.message ? e.message : e).slice(0, 80) }; }
  `);
  if (!ersetzt.ok) return ersetzt;
  await cdp.evaluate(`
    app.workspace.setActiveLeaf(${BLATT(pfad)}, { focus: true });
    app.commands.executeCommandById("workspace:export-pdf");
    return true;
  `);
  const dialog = await pollUntil<boolean>(cdp, `return (${MODAL_BTN("Export to PDF")}) ? true : null;`, 8000, 250);
  if (!dialog) return { ok: false, grund: "der Export-Dialog kam nicht" };
  if (!(await klickeKnopf(cdp, "Export to PDF"))) return { ok: false, grund: "Export nicht anklickbar" };
  for (let i = 0; i < 120; i++) {
    if (existsSync(ziel) && statSync(ziel).size > 1000) return { ok: true, grund: "" };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, grund: "keine PDF-Datei nach 30 s" };
}

/** Der Text eines PDFs (poppler, `pdftotext`); `null`, wenn das Werkzeug fehlt. */
function pdfText(datei: string): string | null {
  try { return execFileSync("pdftotext", [datei, "-"], { encoding: "utf8" }); } catch { return null; }
}

// ---- Auswahl und Notiz pseudonymisieren (Aufgabe 15) ----

/** Erfundene Notizen, vom Treiber angelegt (Namen mit Präfix `Smoke-`) und am Ende gelöscht. Berta Beispiel steht aus der fremden Fassung in der Tabelle (bekannter Name), ihre Adresse nicht. */
const NA_AUSWAHL = "Hallo, Erika Musterfrau schrieb gestern.\n";
const NA_NOTIZ = ["---", "from: Berta Beispiel <berta@example.org>", 'up: "[[Berta Beispiel]]"', "cc:", "  - Berta Beispiel", "---", "Hallo Berta Beispiel, schreib an berta@example.org.", ""].join("\n");
const NA_MAIL = "---\nmail_id: smoke-na-1\nfrom: Berta Beispiel <berta@example.org>\n---\nHallo Berta Beispiel,\n";
const LEGE_NOTIZ_AN = (pfad: string, inhalt: string): string => `
  const alt = app.vault.getAbstractFileByPath(${q(pfad)});
  if (alt) await app.vault.delete(alt);
  await app.vault.create(${q(pfad)}, ${q(inhalt)});
  return true;
`;
const LOESCHE_SMOKE_NOTIZEN = `
  for (const f of app.vault.getMarkdownFiles().filter((x) => x.name.startsWith("Smoke-"))) await app.vault.delete(f);
  return true;
`;
/** Wählt `text` im Editor der vom Treiber geöffneten Notiz und macht das Blatt aktiv; liefert die Auswahl, wie der Editor sie kennt. */
const WAEHLE_TEXT = (pfad: string, text: string): string => `
  const leaf = ${BLATT(pfad)};
  if (!leaf) return "";
  const ed = leaf.view.editor;
  const i = ed.getValue().indexOf(${q(text)});
  if (i < 0) return "";
  app.workspace.setActiveLeaf(leaf, { focus: true });
  ed.setSelection(ed.offsetToPos(i), ed.offsetToPos(i + ${q(text)}.length));
  return ed.getSelection();
`;
const EDITOR_TEXT = (pfad: string): string => `const l = ${BLATT(pfad)}; return l ? l.view.editor.getValue() : null;`;
const PLATTE_TEXT = (pfad: string): string => `const f = app.vault.getAbstractFileByPath(${q(pfad)}); return f ? await app.vault.adapter.read(f.path) : null;`;
/** Die Platte trägt genau `erwartet` (sonst `null`, damit `pollUntil` weiterfragt). */
const PLATTE_GLEICH = (pfad: string, erwartet: string): string => `const f = app.vault.getAbstractFileByPath(${q(pfad)}); if (!f) return null; const t = await app.vault.adapter.read(f.path); return t === ${q(erwartet)} ? t : null;`;
/** Die Platte trägt den Text, in dem `altes` nicht mehr vorkommt (die Notiz wurde umgeschrieben). */
const PLATTE_GEAENDERT = (pfad: string, altes: string): string => `const f = app.vault.getAbstractFileByPath(${q(pfad)}); if (!f) return null; const t = await app.vault.adapter.read(f.path); return t.includes(${q(altes)}) ? null : t;`;
/** Der Text der ersten Notice, die `teil` enthält (sonst `null`). */
const NOTICE_MIT = (teil: string): string => `const n = Array.from(document.querySelectorAll(".notice")).map((e) => e.textContent).find((t) => t.includes(${q(teil)})); return n || null;`;
const LETZTER_KNOPF = `(Array.from(document.querySelectorAll(".modal.pseu-review-modal .modal-button-container button")).pop() || null)`;
/** Die erste Zeile des Vorschlagsdialogs (immer „neu“). */
const ERSTER_VORSCHLAG = `(document.querySelector(".prompt .suggestion-item") || null)`;

// ---- Prüffenster (Aufgabe 14) ----

/** Das Prüffenster mit allem, was die Punkte B1 bis B5 lesen. */
const PRUEF_DIALOG = `
  const m = document.querySelector(".modal.pseu-review-modal");
  if (!m) return null;
  const text = (e, s) => { const x = e.querySelector(s); return x ? x.textContent.trim() : ""; };
  const karten = Array.from(m.querySelectorAll(".okit-review-card")).map((c) => {
    const aktiv = c.querySelector(".okit-segmented-btn.is-active");
    const sel = c.querySelector(".okit-review-owner-select");
    return {
      found: text(c, ".okit-review-found"), stellen: text(c, ".okit-review-places"), treffer: text(c, "mark.okit-review-hit"),
      radiogruppe: Boolean(c.querySelector('.okit-segmented[role="radiogroup"]')),
      wege: Array.from(c.querySelectorAll(".okit-segmented-btn")).map((b) => b.textContent.trim()),
      weghoehen: Array.from(c.querySelectorAll(".okit-segmented-btn")).map((b) => Math.round(b.getBoundingClientRect().height)),
      aktiv: aktiv ? aktiv.getAttribute("data-value") : "", besitzer: sel ? sel.value : "", optionen: sel ? Array.from(sel.options).map((o) => o.value) : [],
    };
  });
  const knoepfe = Array.from(m.querySelectorAll(".modal-button-container button")).map((b) => ({ text: b.textContent.trim(), cta: b.classList.contains("mod-cta") }));
  const r = m.getBoundingClientRect();
  return { titel: text(m, ".modal-title"), kopf: text(m, ".pseu-review-summary"), karten, knoepfe, breite: Math.round(r.width), hoehe: Math.round(r.height), voll: m.classList.contains("pseu-review-full") };
`;
const PRUEF_KARTE = (wert: string): string => `(Array.from(document.querySelectorAll(".modal.pseu-review-modal .okit-review-card")).find((c) => c.querySelector(".okit-review-found").textContent.trim() === ${q(wert)}) || null)`;
const PRUEF_WEG = (wert: string, weg: string): string => `(${PRUEF_KARTE(wert)} ? ${PRUEF_KARTE(wert)}.querySelector('.okit-segmented-btn[data-value=${q(weg)}]') : null)`;
const PRUEF_ANFRAGE = (text: string, schluessel: string, interaktiv: boolean, titel?: string): string => q({
  caller: "gui-smoke", documentKey: schluessel, interactive: interaktiv, ...(titel !== undefined ? { title: titel } : {}), parts: [{ id: "a", kind: "text", value: text }],
});
/** Erfundene Texte; die Namen und Nummern sind keine echten. */
// Der Kit-Erkenner liest eine Anrede nur am Zeilenanfang: beide Stellen des Namens stehen deshalb am Zeilenanfang (gemessen im ersten Lauf: „Bis bald, Hallo …“ gab nur eine Stelle).
const PRUEF_TEXT = "Hallo Erika Musterfrau,\nTel 030 7654321.\nHallo Erika Musterfrau, bis bald.";
const PRUEF_NOTIZ = "Hallo Gustav Probe,\nDie Kollegin Schmidt schrieb. Schmidt ruft an, Schmidtke nicht.";

function dateiHash(basePath: string, eigeneId: string): string | null {
  const pfad = join(basePath, ORDNER, `${eigeneId}.pseudo`);
  return existsSync(pfad) ? createHash("sha256").update(readFileSync(pfad)).digest("hex") : null;
}

// ---- Live Preview (Aufgabe 17): Notizen, die der Treiber selbst anlegt (Präfix `Smoke-`) und in Live Preview öffnet ----

const NOTIZ_LP = "Smoke-LP.md";
const NOTIZ_LP_GROSS = "Smoke-LP-gross.md";
const NOTIZ_LP_LEER = "Smoke-LP-leer.md";
const MAX_MAIL_5 = `${MAX}_Mail_5`;
const LP_INHALT = [
  "# Live Preview",
  "",
  `Hallo ${MAX}, Mail ${MAX}_Mail und Telefon ${MAX}_Telefon.`,
  "",
  `Noch nicht lesbar: ${MAX_MAIL_5}. Unbekannt: Person_a2b3c4d5e6.`,
  "",
  `Inline: \`${MAX}\` und Berta Person_${FREMD2_ID}.`,
  "",
  "```",
  MAX,
  "```",
  "",
  "~~~",
  MAX,
  "",
  `${MAX}_Mail`,
  "~~~",
  "",
].join("\n");
/** Was die Zeile mit den drei Stellen in Live Preview zeigt, wenn alles eingeblendet ist. */
const LP_ZEILE_GEZEIGT = "Hallo Max Mustermann, Mail max@example.org und Telefon 030 1234567.";
const LP_ZEILE_DATEI = `Hallo ${MAX}, Mail ${MAX}_Mail und Telefon ${MAX}_Telefon.`;

/** Die große Notiz (10 000 Zeilen, 500 Platzhalter im Text, dazu Zäune mit weiteren) und ihre Vergleichsnotiz gleicher Größe ohne Platzhalter. Erfundene Werte. */
function grosseNotiz(mitPlatzhaltern: boolean): { text: string; stellen: number } {
  const zeilen: string[] = [];
  let stellen = 0;
  for (let i = 0; zeilen.length < 10_000; i++) {
    if (i % 500 === 100) { zeilen.push("```", mitPlatzhaltern ? `Code ${MAX}` : "Code ohne Besonderheit", "```"); continue; }
    if (i % 20 === 0) {
      zeilen.push(mitPlatzhaltern ? `Zeile ${String(i)} mit ${MAX}_Mail im Text` : `Zeile ${String(i)} mit Platzhalter-frei im Text`);
      stellen += 1;
    } else zeilen.push(`Zeile ${String(i)} ohne Besonderheit`);
  }
  return { text: `${zeilen.join("\n")}\n`, stellen };
}
const sha = (t: string): string => createHash("sha256").update(t).digest("hex");

interface LpWidget { text: string; raw: string; title: string; shown: boolean; forgotten: boolean; unreadable: boolean; linie: string }
interface LpStand { widgets: LpWidget[]; zeilen: { text: string; widgets: number }[]; klartextAttribut: number }
/** Was der Editor einer vom Treiber geöffneten Notiz gerade zeigt: jedes Widget mit Zustand, Tooltip und berechneter Linie, jede Zeile mit der Zahl ihrer Widgets, dazu die Zahl der Attribute mit Klartext. */
const LP_STAND = (pfad: string): string => `
  const c = ${WURZEL(pfad)};
  if (!c) return null;
  const re = ${KLARTEXT_JS};
  const ws = Array.from(c.querySelectorAll(".cm-content .okit-swap-inline"));
  let attr = 0;
  for (const e of Array.from(c.querySelectorAll(".cm-content *"))) for (const a of Array.from(e.attributes)) if (re.test(a.value)) attr += 1;
  return {
    widgets: ws.map((e) => ({ text: e.textContent, raw: e.getAttribute("data-okit-swap") || "", title: e.getAttribute("title") || "", shown: e.classList.contains("is-shown"),
      forgotten: e.classList.contains("is-forgotten"), unreadable: e.classList.contains("is-unreadable"), linie: getComputedStyle(e).borderBottomStyle })),
    zeilen: Array.from(c.querySelectorAll(".cm-content .cm-line")).map((l) => ({ text: l.textContent, widgets: l.querySelectorAll(".okit-swap-inline").length })),
    klartextAttribut: attr,
  };
`;
/** Ein echtes `copy`- oder `cut`-Ereignis mit eigener Zwischenablage am Inhalt des Editors (die des Systems bleibt unberührt); liefert den Text der Zwischenablage und den Dateitext danach. */
const KOPIERE_EDITOR = (pfad: string, art: "copy" | "cut"): string => `
  const leaf = ${BLATT(pfad)};
  const dt = new DataTransfer();
  const ev = new ClipboardEvent(${q(art)}, { clipboardData: dt, bubbles: true, cancelable: true });
  leaf.view.editor.cm.contentDOM.dispatchEvent(ev);
  return { text: dt.getData("text/plain"), abgefangen: ev.defaultPrevented, doc: leaf.view.editor.getValue() };
`;
/** Wählt die Zeilen `von` bis `bis` (0-basiert, ganze Zeilen) im Editor der Notiz. */
const WAEHLE_ZEILEN = (pfad: string, von: number, bis: number): string => `
  const leaf = ${BLATT(pfad)};
  const ed = leaf.view.editor;
  app.workspace.setActiveLeaf(leaf, { focus: true });
  ed.setSelection({ line: ${String(von)}, ch: 0 }, { line: ${String(bis)}, ch: ed.getLine(${String(bis)}).length });
  // CodeMirrors eigenes Kopieren verlangt eine Auswahl im DOM (nicht nur im Editor-Zustand); sie folgt erst nach dem Fokus und einem Bild (gemessen: der erste Versuch ohne Pause lieferte nichts).
  if (ed.cm && ed.cm.focus) ed.cm.focus();
  await new Promise((r) => setTimeout(r, 400));
  return ed.getSelection();
`;
/** Setzt den Cursor auf Zeile `zeile`, Spalte `spalte` (0-basiert). */
const SETZE_CURSOR = (pfad: string, zeile: number, spalte: number): string => `
  const leaf = ${BLATT(pfad)};
  app.workspace.setActiveLeaf(leaf, { focus: true });
  leaf.view.editor.setCursor({ line: ${String(zeile)}, ch: ${String(spalte)} });
  return true;
`;
/** Tippt `n` Zeichen ans Ende einer Zeile mitten im großen Dokument und misst je Änderung die Zeit bis zum Ende des synchronen Aufrufs und bis zum nächsten Bild. */
const MESSE_TIPPEN = (pfad: string, zeile: number, n: number): string => `
  const leaf = ${BLATT(pfad)};
  const cm = leaf.view.editor.cm;
  app.workspace.setActiveLeaf(leaf, { focus: true });
  leaf.view.editor.scrollIntoView({ from: { line: ${String(zeile)}, ch: 0 }, to: { line: ${String(zeile + 30)}, ch: 0 } }, true);
  await new Promise((r) => setTimeout(r, 800));
  const pos = cm.state.doc.line(${String(zeile + 1)}).to;
  const sync = [], bild = [];
  for (let i = 0; i < ${String(n)}; i++) {
    const t0 = performance.now();
    cm.dispatch({ changes: { from: pos + i, insert: "x" }, userEvent: "input.type" });
    const t1 = performance.now();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    sync.push(t1 - t0); bild.push(performance.now() - t0);
  }
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const p95 = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length * 0.95)]; };
  return { sync: med(sync), syncP95: p95(sync), bild: med(bild), widgets: leaf.view.containerEl.querySelectorAll(".okit-swap-inline").length, zeilen: leaf.view.containerEl.querySelectorAll(".cm-line").length };
`;

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
  stopNach = args.value("stop-nach") ?? null;

  console.log(`GUI-Smoke pseudonymizer — Obsidian auf Port ${port}${gegenprobe ? " (GEGENPROBE: Plugin aus)" : ""}`);
  const cdp = await attachTo("workspace", port, REPO_NAME);
  if (!cdp) throw new Error(`Kein Obsidian-Hauptfenster auf Port ${port} für Vault „${REPO_NAME}“.`);

  const warnungen: string[] = [];
  const zustandZurueck = async (): Promise<void> => {
    try {
      await cdp.evaluate(`for (const l of app.workspace.getLeavesOfType("pseudonymizer-view")) l.detach(); return true;`);
      // Aufgabe 16: Notizen und Popout-Fenster des Treibers zu, Schalter und Einstellung zurück, Zwischenablage und Speicherdialog wiederherstellen, Netzmitschnitt aus.
      await cdp.evaluate(SCHLIESSE_NOTIZEN);
      await cdp.evaluate(LOESCHE_SMOKE_NOTIZEN);
      await cdp.evaluate(SCHALTER_ZURUECK);
      await cdp.evaluate(ZWISCHENABLAGE_AUS);
      await cdp.evaluate(`if (window.__pseuSaveOrig) { window.require("electron").remote.dialog.showSaveDialog = window.__pseuSaveOrig; delete window.__pseuSaveOrig; } return true;`);
      await cdp.send("Network.disable");
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

    // --- W bis P: Lesesicht und Kopieren (Aufgabe 16) ---
    // Stand hier: bereit auf der neuen Kette, die Tabelle trägt Max (Name, Mail, Telefon) und Berta aus der fremden Fassung; die Notizen sind erfundene Fixtures (`fixtures/vault/notes/`).
    console.log("\nW · Lesesicht");
    const schluesselW = await leseSchluessel(cdp);
    await cdp.evaluate(SCHALTER_ZURUECK);
    // Netzmitschnitt für das Bild mit Platzhalter in der URL: jede Anfrage der Hauptseite, solange die Notiz offen ist (Positivkontrolle: die Anfrage nach dem Bild selbst).
    const netz: string[] = [];
    await cdp.send("Network.enable");
    cdp.on("Network.requestWillBeSent", (params) => {
      const u = (params as { request?: { url?: string } }).request?.url;
      if (u) netz.push(u);
    });
    const lesenOffen = await oeffneNotiz(cdp, NOTIZ_LESEN, "preview", 8);
    await new Promise((r) => setTimeout(r, 1500));
    const stand = lesenOffen ? await cdp.evaluate<Lesestand | null>(LESESTAND(NOTIZ_LESEN)) : null;
    const rest = lesenOffen ? await cdp.evaluate<{ code: string | null; pre: string | null; href: string | null; aTitle: string | null; src: string | null; alt: string | null; imgTitle: string | null; imCode: number; ohneErsatz: boolean } | null>(`
      const c = ${WURZEL(NOTIZ_LESEN)};
      if (!c) return null;
      // Der Container trägt auch den (versteckten) Editor mit leeren cm-widgetBuffer-Bildern; das Bild der Lesesicht steht in .markdown-preview-view und hat ein src.
      const pv = c.querySelector(".markdown-preview-view") || c;
      const a = pv.querySelector("a.external-link, a[href^='http']");
      const img = pv.querySelector("img[src]");
      const code = c.querySelector("p code");
      const pre = c.querySelector("pre");
      return {
        code: code ? code.textContent : null, pre: pre ? pre.textContent.trim() : null,
        href: a ? a.getAttribute("href") : null, aTitle: a ? a.getAttribute("title") : null,
        src: img ? img.getAttribute("src") : null, alt: img ? img.getAttribute("alt") : null, imgTitle: img ? img.getAttribute("title") : null,
        imCode: c.querySelectorAll("code .okit-swap, pre .okit-swap").length,
        ohneErsatz: c.textContent.includes("Person_a2b3c4d5e6") && !Array.from(c.querySelectorAll(".okit-swap")).some((e) => e.getAttribute("data-okit-swap") === "Person_a2b3c4d5e6"),
      };
    `) : null;
    const erwartetGezeigt = ["Max Mustermann", "030 1234567", "max@example.org", "Max Mustermann", "Max Mustermann", "Berta Beispiel", "Max Mustermann"];
    const gezeigtW = stand ? stand.stellen.filter((x) => x.shown) : [];
    const ersteStelle = stand?.stellen[0];
    const nichtLesbar = stand ? stand.stellen.filter((x) => x.unreadable) : [];
    const netzGesehen = netz.some((u) => u.includes("example.invalid"));
    const netzSauber = netz.every((u) => !KLARTEXT.test(u));
    record("W Lesesicht: Platzhalter im Fließtext zeigt Klartext mit gepunkteter Unterstreichung und dem Platzhalter im Tooltip; in Code, pre, Link-Ziel, Bild-URL, title und alt bleibt der Platzhalter, kein Attribut und kein Netzabruf trägt Klartext; ein noch nicht lesbarer Wert nennt den Grund, ein unbekannter bleibt Text",
      lesenOffen && stand !== null && rest !== null
        && q(gezeigtW.map((x) => x.text)) === q(erwartetGezeigt)
        && ersteStelle !== undefined && ersteStelle.title === MAX && ersteStelle.linie === "dotted"
        && nichtLesbar.length === 1 && nichtLesbar[0]!.raw === `${MAX}_Mail_5` && nichtLesbar[0]!.text === `${MAX}_Mail_5` && /may not have synced/.test(nichtLesbar[0]!.title) && nichtLesbar[0]!.linie === "dashed"
        && rest.ohneErsatz
        && rest.code === MAX && rest.pre === MAX && rest.imCode === 0
        && (rest.href ?? "").endsWith(`/${MAX}`) && (rest.aTitle === null || rest.aTitle === MAX)
        && (rest.src ?? "").endsWith(`/${MAX}.png`) && (rest.alt ?? "").includes(MAX) && (rest.imgTitle === null || rest.imgTitle === MAX)
        && !stand.klartextAusserhalb && stand.klartextInAttribut === 0
        && netzGesehen && netzSauber,
      `Notiz offen=${lesenOffen}, gezeigt=${q(gezeigtW.map((x) => x.text))}, erste Stelle=${q(ersteStelle ? { title: ersteStelle.title, linie: ersteStelle.linie } : null)}, nicht lesbar=${q(nichtLesbar.map((x) => ({ raw: x.raw, title: x.title, linie: x.linie })))}, Rest=${q(rest)}, Klartext außerhalb=${stand?.klartextAusserhalb ?? null}, in Attributen=${stand?.klartextInAttribut ?? null}, Netz: ${netz.length} Anfragen, Bild gesehen=${netzGesehen}, ohne Klartext=${netzSauber}`);

    // --- U ---
    console.log("\nU · Umschalter");
    const summeVor = pruefsumme(info.basePath, NOTIZ_LESEN);
    const sonden = lesenOffen ? await cdp.evaluate<number>(`const els = Array.from(${WURZEL(NOTIZ_LESEN)}.querySelectorAll(".okit-swap")); els.forEach((e, i) => e.setAttribute("data-pseu-probe", String(i))); return els.length;`) : 0;
    const DRUECKT = `const b = document.querySelector(".pseu-status-btn"); return b ? b.getAttribute("aria-pressed") : null;`;
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:toggle-plaintext`)}); return true;`);
    const aus = await pollUntil<{ n: number; sonden: number; klartext: boolean; gedrueckt: string | null }>(cdp, `
      const c = ${WURZEL(NOTIZ_LESEN)};
      if (!c) return null;
      const els = Array.from(c.querySelectorAll(".okit-swap"));
      if (els.length === 0 || !els.every((e) => e.textContent === e.getAttribute("data-okit-swap"))) return null;
      const b = document.querySelector(".pseu-status-btn");
      return { n: els.length, sonden: els.filter((e) => e.hasAttribute("data-pseu-probe")).length, klartext: ${KLARTEXT_JS}.test(c.innerHTML), gedrueckt: b ? b.getAttribute("aria-pressed") : null };
    `, 8000, 250);
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:toggle-plaintext`)}); return true;`);
    const an = await pollUntil<{ n: number; sonden: number; gezeigt: number; gedrueckt: string | null }>(cdp, `
      const c = ${WURZEL(NOTIZ_LESEN)};
      if (!c) return null;
      const els = Array.from(c.querySelectorAll(".okit-swap.is-shown"));
      if (els.length < 7) return null;
      const b = document.querySelector(".pseu-status-btn");
      return { n: c.querySelectorAll(".okit-swap").length, sonden: Array.from(c.querySelectorAll(".okit-swap")).filter((e) => e.hasAttribute("data-pseu-probe")).length, gezeigt: els.length, gedrueckt: b ? b.getAttribute("aria-pressed") : null };
    `, 8000, 250);
    const summeNach = pruefsumme(info.basePath, NOTIZ_LESEN);
    record("U Umschalter „Klartext zeigen“: wechselt alle sichtbaren Stellen ohne Neuaufbau (dieselben Knoten), im DOM steht bei „aus“ kein Klartext, die Datei der Notiz bleibt byte-gleich (Prüfsumme vorher und nachher)",
      sonden >= 8 && Boolean(aus) && aus!.n === sonden && aus!.sonden === sonden && !aus!.klartext && aus!.gedrueckt === "false"
        && Boolean(an) && an!.n === sonden && an!.sonden === sonden && an!.gezeigt >= 7 && an!.gedrueckt === "true"
        && summeVor !== null && summeVor === summeNach,
      `Stellen=${sonden}, aus=${q(aus)}, an=${q(an)}, Prüfsumme vorher=${summeVor?.slice(0, 12) ?? null} nachher=${summeNach?.slice(0, 12) ?? null}`);

    // --- Y ---
    console.log("\nY · Kopieren in der Lesesicht");
    type Kopie = { text: string; html: string; abgefangen: boolean };
    const ganzerAbsatz = lesenOffen ? await cdp.evaluate<Kopie>(KOPIERE("document", ABSATZ(NOTIZ_LESEN, 0))) : null;
    const teilweise = lesenOffen ? await cdp.evaluate<Kopie>(KOPIERE("document", `
      const t = ${WURZEL(NOTIZ_LESEN)}.querySelector(".okit-swap").firstChild;
      const r = document.createRange(); r.setStart(t, 3); r.setEnd(t, 8); return r;
    `)) : null;
    const zweiGleiche = lesenOffen ? await cdp.evaluate<Kopie>(KOPIERE("document", ABSATZ(NOTIZ_LESEN, 1))) : null;
    await cdp.evaluate(`const p = ${P}; if (!p) return false; p.settings.copyMode = "as-shown"; p.emitChange(); return true;`);
    const wieGesehen = lesenOffen ? await cdp.evaluate<Kopie>(KOPIERE("document", ABSATZ(NOTIZ_LESEN, 0))) : null;
    await cdp.evaluate(`const p = ${P}; if (!p) return false; p.device.setShowPlaintext(false); p.emitChange(); return true;`);
    const wieGesehenAus = lesenOffen ? await cdp.evaluate<Kopie>(KOPIERE("document", ABSATZ(NOTIZ_LESEN, 0))) : null;
    await cdp.evaluate(SCHALTER_ZURUECK);
    const ersterAbsatz = `Hallo ${MAX}, Rückruf unter ${MAX}_Telefon, Mail ${MAX}_Mail.`;
    record("Y Kopieren in der Lesesicht (echte Auswahl, copy-Ereignis mit DataTransfer): Vorgabe Platzhalter, auch bei nur teilweise erfasster Stelle und bei zwei gleichen Texten nebeneinander; „was ich sehe“ liefert Klartext, bei ausgeblendetem Klartext wieder Platzhalter",
      ganzerAbsatz !== null && teilweise !== null && zweiGleiche !== null && wieGesehen !== null && wieGesehenAus !== null
        && ganzerAbsatz.abgefangen && ganzerAbsatz.text.trim() === ersterAbsatz && !KLARTEXT.test(ganzerAbsatz.text) && !KLARTEXT.test(ganzerAbsatz.html)
        && teilweise.abgefangen && teilweise.text.trim() === MAX && !KLARTEXT.test(teilweise.html)
        && zweiGleiche.abgefangen && zweiGleiche.text.trim() === `Zwei gleiche nebeneinander: ${MAX} ${MAX}`
        && wieGesehen.abgefangen && wieGesehen.text.trim() === "Hallo Max Mustermann, Rückruf unter 030 1234567, Mail max@example.org."
        && wieGesehenAus.abgefangen && wieGesehenAus.text.trim() === ersterAbsatz && !KLARTEXT.test(wieGesehenAus.html),
      `Vorgabe=${q(ganzerAbsatz?.text.trim() ?? null)}, teilweise=${q(teilweise?.text.trim() ?? null)}, zwei gleiche=${q(zweiGleiche?.text.trim() ?? null)}, „was ich sehe“ an=${q(wieGesehen?.text.trim() ?? null)}, aus=${q(wieGesehenAus?.text.trim() ?? null)}`);

    // --- M ---
    console.log("\nM · Kopier-Befehle");
    await cdp.evaluate(ZWISCHENABLAGE_AN);
    const kopierenOffen = await oeffneNotiz(cdp, NOTIZ_KOPIEREN, "source", 0);
    const waehle = (von: string, bis: string): string => `
      const ed = ${BLATT(NOTIZ_KOPIEREN)}.view.editor;
      ed.setSelection(${von}, ${bis});
      return true;
    `;
    const warteClip = (n: number): Promise<string[] | null> => pollUntil<string[]>(cdp, `return window.__pseuClip && window.__pseuClip.length >= ${String(n)} ? window.__pseuClip.slice() : null;`, 5000, 150);
    await cdp.evaluate(waehle(`{ line: 2, ch: 0 }`, `{ line: 2, ch: ed.getLine(2).length }`));
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:copy-plaintext`)}); return true;`);
    const clip1 = kopierenOffen ? await warteClip(1) : null;
    await cdp.evaluate(waehle(`{ line: 0, ch: 0 }`, `{ line: 0, ch: 0 }`));
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:copy-plaintext`)}); return true;`);
    const clip2 = clip1 ? await warteClip(2) : null;
    await cdp.evaluate(`const p = ${P}; if (!p) return false; p.settings.copyMode = "as-shown"; p.emitChange(); return true;`);
    await cdp.evaluate(waehle(`{ line: 2, ch: 0 }`, `{ line: 2, ch: ed.getLine(2).length }`));
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:copy-placeholders`)}); return true;`);
    const clip3 = clip2 ? await warteClip(3) : null;
    // Ein unlesbarer Platzhalter in der Lesesicht-Notiz: nichts geht hinaus, die Notice nennt Platzhalter und nie Klartext.
    await cdp.evaluate(`app.workspace.setActiveLeaf(${BLATT(NOTIZ_LESEN)}, { focus: true }); return true;`);
    await clearNotices(cdp);
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:copy-plaintext`)}); return true;`);
    await new Promise((r) => setTimeout(r, 800));
    const hinweisM = await notices(cdp);
    const nachRefusal = await cdp.evaluate<number>(`return window.__pseuClip ? window.__pseuClip.length : -1;`);
    await cdp.evaluate(ZWISCHENABLAGE_AUS);
    await cdp.evaluate(SCHALTER_ZURUECK);
    await cdp.evaluate(`const l = ${BLATT(NOTIZ_KOPIEREN)}; if (l) l.detach(); return true;`);
    record("M Befehle „Mit Klartext kopieren“ und „Mit Platzhaltern kopieren“: Auswahl und ganze Notiz in der Zwischenablage, ein unlesbarer Platzhalter hält alles zurück und steht (ohne Klartext) in der Notice",
      Boolean(clip1) && clip1![0] === "Erste Zeile: Max Mustermann und Berta Beispiel."
        && Boolean(clip2) && clip2![1]!.startsWith("# Kopieren") && clip2![1]!.includes("Max Mustermann") && clip2![1]!.includes("max@example.org") && !clip2![1]!.includes("Person_")
        && Boolean(clip3) && clip3![2] === `Erste Zeile: ${MAX} und Person_${FREMD2_ID}.`
        && nachRefusal === 3 && hinweisM.includes("Person_a2b3c4d5e6") && !KLARTEXT.test(hinweisM),
      `Auswahl=${q(clip1?.[0] ?? null)}, ganze Notiz beginnt ${q(clip2?.[1]?.slice(0, 40) ?? null)}, Platzhalter=${q(clip3?.[2] ?? null)}, Schreibvorgänge nach Verweigerung=${nachRefusal} (erwartet 3), Notice=${q(hinweisM.slice(0, 200))}`);
    await clearNotices(cdp);

    // --- N ---
    console.log("\nN · Sperren und Entsperren");
    await cdp.evaluate(`app.workspace.setActiveLeaf(${BLATT(NOTIZ_LESEN)}, { focus: true }); return true;`);
    await cdp.evaluate(`const p = ${P}; if (!p) return false; p.keys.clear(); await p.refreshTables(); return true;`);
    const gesperrtN = await pollUntil<Lesestand>(cdp, `
      const st = (() => { ${LESESTAND(NOTIZ_LESEN)} })();
      return st && st.stellen.length >= 8 && st.stellen.every((x) => x.unreadable) ? st : null;
    `, 12_000, 250);
    await cdp.evaluate(`
      const p = ${P}; if (!p) return false;
      const k = ${q(schluesselW)};
      if (!k) return false;
      p.keys.write({ chainId: Uint8Array.from(k.chainId), stand: k.stand, key: Uint8Array.from(k.key) });
      await p.refreshTables();
      return true;
    `);
    const entsperrtN = await pollUntil<Lesestand>(cdp, `
      const st = (() => { ${LESESTAND(NOTIZ_LESEN)} })();
      return st && st.stellen.filter((x) => x.shown).length >= 7 ? st : null;
    `, 12_000, 250);
    record("N Sperren und Entsperren schalten gezeigte Stellen ohne Neuöffnen um: gesperrt nicht lesbar mit Grund und ohne Klartext im DOM, entsperrt wieder Klartext",
      schluesselW !== null && Boolean(gesperrtN) && gesperrtN!.stellen.every((x) => x.text === x.raw && /locked on this device/.test(x.title) && x.linie === "dashed") && !KLARTEXT.test(gesperrtN!.html)
        && Boolean(entsperrtN) && entsperrtN!.stellen.filter((x) => x.shown).length >= 7,
      `Schlüssel gemerkt=${schluesselW !== null}, gesperrt: ${q(gesperrtN ? { stellen: gesperrtN.stellen.length, titel: gesperrtN.stellen[0]?.title, linie: gesperrtN.stellen[0]?.linie, klartext: KLARTEXT.test(gesperrtN.html) } : null)}, entsperrt: ${q(entsperrtN ? { gezeigt: entsperrtN.stellen.filter((x) => x.shown).length } : null)}`);

    // --- O ---
    console.log("\nO · Popout-Fenster");
    const popout = await cdp.evaluate<{ anderes: boolean } | null>(`
      const f = app.vault.getAbstractFileByPath(${q(NOTIZ_LESEN)});
      if (!f) return null;
      const leaf = app.workspace.openPopoutLeaf();
      await leaf.openFile(f, { state: { mode: "preview" } });
      leaf.view.containerEl.setAttribute("data-pseu-smoke", "popout");
      window.__pseuPop = leaf;
      return { anderes: leaf.view.containerEl.ownerDocument !== document };
    `);
    const POP = `window.__pseuPop.view.containerEl`;
    const popStand = (bedingung: string): string => `
      const c = window.__pseuPop ? ${POP} : null;
      if (!c) return null;
      const els = Array.from(c.querySelectorAll(".okit-swap"));
      if (!(${bedingung})) return null;
      return { n: els.length, texte: els.map((e) => e.textContent) };
    `;
    const popAn = popout ? await pollUntil<{ n: number; texte: string[] }>(cdp, popStand(`els.length >= 8 && els.filter((e) => e.classList.contains("is-shown")).length >= 7`), 10_000, 250) : null;
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:toggle-plaintext`)}); return true;`);
    const popAus = popAn ? await pollUntil<{ n: number; texte: string[] }>(cdp, popStand(`els.length >= 8 && els.every((e) => e.textContent === e.getAttribute("data-okit-swap"))`), 8000, 250) : null;
    const popKopie = popAus ? await cdp.evaluate<Kopie>(KOPIERE(`window.__pseuPop.view.containerEl.ownerDocument`, `
      const doc = window.__pseuPop.view.containerEl.ownerDocument;
      const r = doc.createRange(); r.selectNodeContents(window.__pseuPop.view.containerEl.querySelectorAll("p")[0]); return r;
    `)) : null;
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:toggle-plaintext`)}); return true;`);
    const popWieder = popAus ? await pollUntil<{ n: number; texte: string[] }>(cdp, popStand(`els.filter((e) => e.classList.contains("is-shown")).length >= 7`), 8000, 250) : null;
    const popGeschlossen = await cdp.evaluate<boolean>(`if (window.__pseuPop) { window.__pseuPop.detach(); delete window.__pseuPop; } return true;`);
    record("O Popout-Fenster: Umschalter und Kopieren wirken auch im eigenen document des Popouts",
      popout !== null && popout.anderes && Boolean(popAn) && popAn!.texte.includes("Max Mustermann")
        && Boolean(popAus) && !popAus!.texte.some((x) => KLARTEXT.test(x))
        && popKopie !== null && popKopie.abgefangen && popKopie.text.trim() === ersterAbsatz && !KLARTEXT.test(popKopie.html)
        && Boolean(popWieder) && popGeschlossen,
      `eigenes document=${popout?.anderes ?? null}, an=${q(popAn ? popAn.texte.slice(0, 2) : null)}, aus ohne Klartext=${Boolean(popAus)}, Kopie=${q(popKopie ? { abgefangen: popKopie.abgefangen, text: popKopie.text.trim().slice(0, 60) } : null)}, wieder an=${Boolean(popWieder)}`);

    // --- Q ---
    console.log("\nQ · Ziehen mit der Maus");
    await cdp.evaluate(`app.workspace.setActiveLeaf(${BLATT(NOTIZ_LESEN)}, { focus: true }); return true;`);
    const zug = lesenOffen ? await messeZiehen(cdp, NOTIZ_LESEN) : null;
    const zugText = zug ? zug.items.find((i) => i.mimeType === "text/plain")?.data ?? null : null;
    record("Q Ziehen markierten Texts aus der Lesesicht (dragstart mit vorgefülltem DataTransfer; ein echter Mauszug beginnt über CDP keinen Zug aus Text): der Zug trägt in der Vorgabe den Platzhalter, nie den Klartext",
      zug !== null && zugText !== null && zugText.includes(MAX) && !zug.items.some((i) => KLARTEXT.test(i.data)),
      `Zug ausgelöst=${zug !== null}, Daten=${q(zug ? zug.items.map((i) => ({ art: i.mimeType, anfang: i.data.slice(0, 60) })) : null)}${zug !== null && zug.items.some((i) => KLARTEXT.test(i.data)) ? " — KLARTEXT IM ZUG: Grenze für die README" : ""}`);
    await cdp.evaluate(`app.workspace.setActiveLeaf(${BLATT(NOTIZ_LESEN)}, { focus: true }); return true;`);

    // --- P ---
    console.log("\nP · PDF-Export");
    const pdfOrdner = mkdtempSync(join(tmpdir(), "pseudonymizer-pdf-"));
    let pdfAn: { ok: boolean; grund: string } = { ok: false, grund: "nicht gelaufen" };
    let pdfAus: { ok: boolean; grund: string } = { ok: false, grund: "nicht gelaufen" };
    let textAn: string | null = null;
    let textAus: string | null = null;
    try {
      const kopierenPdf = await oeffneNotiz(cdp, NOTIZ_KOPIEREN, "preview", 3);
      if (kopierenPdf) {
        pdfAn = await exportiereAlsPdf(cdp, NOTIZ_KOPIEREN, join(pdfOrdner, "an.pdf"));
        textAn = pdfAn.ok ? (pdfText(join(pdfOrdner, "an.pdf")) ?? "") : null;
        await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:toggle-plaintext`)}); return true;`);
        await pollUntil<boolean>(cdp, `const c = ${WURZEL(NOTIZ_KOPIEREN)}; const els = c ? Array.from(c.querySelectorAll(".okit-swap")) : []; return els.length >= 3 && els.every((e) => e.textContent === e.getAttribute("data-okit-swap")) ? true : null;`, 8000, 250);
        pdfAus = await exportiereAlsPdf(cdp, NOTIZ_KOPIEREN, join(pdfOrdner, "aus.pdf"));
        textAus = pdfAus.ok ? (pdfText(join(pdfOrdner, "aus.pdf")) ?? "") : null;
      }
    } finally {
      await cdp.evaluate(`if (window.__pseuSaveOrig) { window.require("electron").remote.dialog.showSaveDialog = window.__pseuSaveOrig; delete window.__pseuSaveOrig; } return true;`);
      await cdp.evaluate(SCHALTER_ZURUECK);
      // Ein Export-Dialog, der offen blieb (Knopf nicht gefunden), würde die folgenden Punkte verdecken.
      await schliesseDialog(cdp);
      rmSync(pdfOrdner, { recursive: true, force: true });
    }
    const glatt = (t: string | null): string => (t ?? "").replace(/\s+/g, " ");
    record("P PDF-Export (Speicherdialog im Renderer ersetzt): mit „Klartext zeigen“ trägt das PDF den Klartext und nicht den Platzhalter, ohne den Platzhalter und nicht den Klartext",
      pdfAn.ok && pdfAus.ok && textAn !== null && textAus !== null && textAn !== "" && textAus !== ""
        && glatt(textAn).includes("Max Mustermann") && glatt(textAn).includes("Berta Beispiel") && glatt(textAn).includes("max@example.org") && !glatt(textAn).includes(MAX) && !glatt(textAn).includes(`Person_${FREMD2_ID}`)
        && glatt(textAus).includes(MAX) && glatt(textAus).includes(`Person_${FREMD2_ID}`) && !KLARTEXT.test(glatt(textAus)),
      `Export an=${pdfAn.ok ? "ja" : pdfAn.grund}, Export aus=${pdfAus.ok ? "ja" : pdfAus.grund}, pdftotext=${textAn === "" ? "fehlt oder leer" : "da"}, PDF an enthält Klartext=${glatt(textAn).includes("Max Mustermann")} und Platzhalter=${glatt(textAn).includes(MAX)}, PDF aus enthält Platzhalter=${glatt(textAus).includes(MAX)} und Klartext=${KLARTEXT.test(glatt(textAus))}`);
    await cdp.evaluate(`const l = ${BLATT(NOTIZ_KOPIEREN)}; if (l) l.detach(); return true;`);
    await clearNotices(cdp);

    // --- LP (Aufgabe 17): Live Preview ---
    // Geschrieben, noch nicht gelaufen (Rechner unter Last). Stand hier: bereit, Max und Berta bekannt, Klartext gezeigt, Vorgabe „Platzhalter“. Die Notizen legt der Treiber selbst an (Präfix `Smoke-`)
    // und räumt sie weg; die Notiz `Smoke-LP.md` bleibt bis LP8 offen (Vergessen in der offenen Live Preview).
    console.log("\nLP · Live Preview");
    await cdp.evaluate(`app.workspace.setActiveLeaf(${BLATT(NOTIZ_LESEN)}, { focus: true }); return true;`).catch(() => undefined);
    await cdp.evaluate(SCHALTER_ZURUECK);
    await cdp.evaluate(LEGE_NOTIZ_AN(NOTIZ_LP, LP_INHALT));
    const summeLpDatei = pruefsumme(info.basePath, NOTIZ_LP);
    const lpOffen = await oeffneNotiz(cdp, NOTIZ_LP, "source", 0, false);
    const lpBereit = (bedingung: string): string => `const s = (() => { ${LP_STAND(NOTIZ_LP)} })(); return s && (${bedingung}) ? s : null;`;
    const lp1 = lpOffen ? await pollUntil<LpStand>(cdp, lpBereit("s.widgets.length >= 5"), 12_000, 250) : null;
    const lpZeile1 = lp1?.zeilen.find((z) => z.text === LP_ZEILE_GEZEIGT);
    const lpErste = lp1?.widgets[0];
    const lpNichtLesbar = lp1?.widgets.filter((w) => w.unreadable) ?? [];
    record("LP1 Live Preview: Platzhalter mitten in der Zeile als Widget mit Klartext (gepunktete Linie, der Platzhalter im Tooltip und im Attribut), nicht lesbare gestrichelt, Unbekanntes bleibt Text, kein Attribut trägt Klartext",
      lp1 !== null && q(lp1.widgets.map((w) => w.text)) === q(["Max Mustermann", "max@example.org", "030 1234567", MAX_MAIL_5, "Berta Beispiel"])
        && lpZeile1 !== undefined && lpZeile1.widgets === 3
        && lpErste !== undefined && lpErste.raw === MAX && lpErste.title === MAX && lpErste.shown && lpErste.linie === "dotted"
        && lpNichtLesbar.length === 1 && lpNichtLesbar[0]!.raw === MAX_MAIL_5 && /may not have synced/.test(lpNichtLesbar[0]!.title) && lpNichtLesbar[0]!.linie === "dashed"
        && !lp1.widgets.some((w) => w.raw === "Person_a2b3c4d5e6") && lp1.klartextAttribut === 0,
      `offen=${lpOffen}, Widgets=${q(lp1 ? lp1.widgets.map((w) => w.text) : null)}, Zeile mit drei Stellen=${q(lpZeile1 ?? null)}, erstes=${q(lpErste ? { raw: lpErste.raw, title: lpErste.title, linie: lpErste.linie } : null)}, nicht lesbar=${q(lpNichtLesbar.map((w) => ({ raw: w.raw, linie: w.linie })))}, Attribute mit Klartext=${lp1?.klartextAttribut ?? null}`);

    // LP6: Zäune und Inline-Code
    const lpFlach = lp1?.zeilen.filter((z) => z.text === MAX) ?? [];
    const lpTilde = lp1?.zeilen.filter((z) => z.text === `${MAX}_Mail`) ?? [];
    const lpInline = lp1?.zeilen.find((z) => z.text.startsWith("Inline:"));
    record("LP6 Platzhalter in einem Zaun (flach und Tilde, auch hinter einer Leerzeile) und in Inline-Code bleibt Platzhalter: keine Zeile dort trägt ein Widget, die Berta-Stelle neben dem Inline-Code schon",
      lp1 !== null && lpFlach.length >= 1 && lpFlach.every((z) => z.widgets === 0) && lpTilde.length === 1 && lpTilde[0]!.widgets === 0
        && lpInline !== undefined && lpInline.widgets === 1 && lpInline.text.includes(MAX) && lpInline.text.includes("Berta Beispiel"),
      `flache Zaunzeilen=${q(lpFlach)}, Tilde-Zeile=${q(lpTilde)}, Inline-Zeile=${q(lpInline ?? null)}`);

    // LP2: Cursor und Auswahl auf dem Platzhalter
    const lpPos = (zusatz: number): string => `const ed = ${BLATT(NOTIZ_LP)}.view.editor; const i = ed.getValue().indexOf(${q(MAX)}); return ed.offsetToPos(i + ${String(zusatz)});`;
    const zeile2 = (s: LpStand): { text: string; widgets: number } | undefined => s.zeilen.find((z) => z.text.startsWith("Hallo "));
    await cdp.evaluate(`const leaf = ${BLATT(NOTIZ_LP)}; app.workspace.setActiveLeaf(leaf, { focus: true }); const p = (() => { ${lpPos(4)} })(); leaf.view.editor.setCursor(p); return true;`);
    const lp2Cursor = lpOffen ? await pollUntil<LpStand>(cdp, lpBereit(`s.zeilen.some((z) => z.text.startsWith("Hallo ") && z.widgets === 2 && z.text.includes(${q(MAX)}))`), 8000, 200) : null;
    await cdp.evaluate(`const leaf = ${BLATT(NOTIZ_LP)}; const a = (() => { ${lpPos(0)} })(); const b = (() => { ${lpPos(MAX.length)} })(); leaf.view.editor.setSelection(a, b); return true;`);
    const lp2Auswahl = lp2Cursor ? await pollUntil<LpStand>(cdp, lpBereit(`s.zeilen.some((z) => z.text.startsWith("Hallo ") && z.widgets === 2 && z.text.includes(${q(MAX)}))`), 8000, 200) : null;
    await cdp.evaluate(SETZE_CURSOR(NOTIZ_LP, 0, 2));
    const lp2Zurueck = lp2Auswahl ? await pollUntil<LpStand>(cdp, lpBereit(`s.zeilen.some((z) => z.text === ${q(LP_ZEILE_GEZEIGT)} && z.widgets === 3)`), 8000, 200) : null;
    record("LP2 Cursor oder Auswahl auf dem Platzhalter zeigt den Platzhalter (die beiden anderen Stellen der Zeile bleiben Widgets); weg vom Platzhalter kommt das Widget zurück",
      Boolean(lp2Cursor) && Boolean(lp2Auswahl) && Boolean(lp2Zurueck),
      `Cursor im Platzhalter=${q(lp2Cursor ? zeile2(lp2Cursor) : null)}, Auswahl=${q(lp2Auswahl ? zeile2(lp2Auswahl) : null)}, Cursor weg=${q(lp2Zurueck ? zeile2(lp2Zurueck) : null)}`);

    // LP3: Quelltextmodus und zurück (derselbe Befehl wie am Schalter von Obsidian)
    await cdp.evaluate(`app.workspace.setActiveLeaf(${BLATT(NOTIZ_LP)}, { focus: true }); app.commands.executeCommandById("editor:toggle-source"); return true;`);
    const lp3Quelltext = await pollUntil<LpStand>(cdp, lpBereit(`s.widgets.length === 0 && s.zeilen.some((z) => z.text === ${q(LP_ZEILE_DATEI)})`), 8000, 200);
    await cdp.evaluate(`app.workspace.setActiveLeaf(${BLATT(NOTIZ_LP)}, { focus: true }); app.commands.executeCommandById("editor:toggle-source"); return true;`);
    const lp3Zurueck = lp3Quelltext ? await pollUntil<LpStand>(cdp, lpBereit("s.widgets.length >= 5"), 8000, 200) : null;
    record("LP3 Quelltextmodus zeigt die Platzhalter (kein Widget); zurück in Live Preview erscheinen die Widgets wieder, ohne die Notiz neu zu öffnen",
      Boolean(lp3Quelltext) && Boolean(lp3Zurueck),
      `Quelltext: Widgets=${lp3Quelltext?.widgets.length ?? null}, Zeile=${q(lp3Quelltext?.zeilen.find((z) => z.text.startsWith("Hallo "))?.text ?? null)}; zurück: Widgets=${lp3Zurueck?.widgets.length ?? null}`);

    // LP4: Kopieren und Ausschneiden
    const zeileHallo = 2;
    const KOPIE = async (art: "copy" | "cut" = "copy"): Promise<{ text: string; abgefangen: boolean; doc: string }> => cdp.evaluate(KOPIERE_EDITOR(NOTIZ_LP, art));
    await cdp.evaluate(WAEHLE_ZEILEN(NOTIZ_LP, zeileHallo, zeileHallo));
    const kopVorgabe = await KOPIE();
    await cdp.evaluate(`const p = ${P}; if (!p) return false; p.settings.copyMode = "as-shown"; p.emitChange(); return true;`);
    const kopGesehen = await KOPIE();
    await cdp.evaluate(`const p = ${P}; if (!p) return false; p.device.setShowPlaintext(false); p.emitChange(); return true;`);
    const kopAus = await KOPIE();
    await cdp.evaluate(`const p = ${P}; if (!p) return false; p.device.setShowPlaintext(true); p.emitChange(); return true;`);
    await cdp.evaluate(WAEHLE_ZEILEN(NOTIZ_LP, 4, 4));
    const kopUnbekannt = await KOPIE();
    const auswahlCode = await cdp.evaluate<string>(WAEHLE_ZEILEN(NOTIZ_LP, 6, 16));
    const kopCode = await KOPIE();
    await cdp.evaluate(WAEHLE_ZEILEN(NOTIZ_LP, zeileHallo, zeileHallo));
    const vorCut = (await KOPIE()).doc;
    const kopCut = await KOPIE("cut");
    await cdp.evaluate(SCHALTER_ZURUECK);
    const dateiZeile = LP_ZEILE_DATEI;
    // Der Code-Bereich: das Widget-Ersatzpaar der Berta-Stelle ist das einzige, was in der Zwischenablage Klartext trägt; Inline-Code und Zäune bleiben, wie die Datei sie hält.
    const erwartetCode = auswahlCode.replace(`Person_${FREMD2_ID}`, "Berta Beispiel");
    record("LP4 Kopieren und Ausschneiden aus Live Preview (echtes copy- und cut-Ereignis am Editor, eigene Zwischenablage): Vorgabe liefert den Dateitext; „was ich sehe“ mit Klartext die eingeblendete Fassung, ausgeblendet oder bei Unbekanntem den Dateitext, Inline-Code und Zäune bleiben Platzhalter; Ausschneiden löscht die Auswahl wie ohne Plugin",
      kopVorgabe.text === dateiZeile && !KLARTEXT.test(kopVorgabe.text)
        && kopGesehen.abgefangen && kopGesehen.text === LP_ZEILE_GEZEIGT
        && kopAus.text === dateiZeile
        && !KLARTEXT.test(kopUnbekannt.text) && kopUnbekannt.text.includes("Person_a2b3c4d5e6")
        && kopCode.text === erwartetCode && kopCode.text.includes(`\`${MAX}\``) && kopCode.text.includes(`~~~\n${MAX}\n\n${MAX}_Mail\n~~~`)
        && kopCut.text === LP_ZEILE_GEZEIGT && kopCut.doc === vorCut.replace(dateiZeile, ""),
      `Vorgabe=${q(kopVorgabe.text)}, „was ich sehe“=${q(kopGesehen.text)}, ausgeblendet=${q(kopAus.text)}, Unbekanntes=${q(kopUnbekannt.text)}, Code-Bereich gleich der Erwartung=${kopCode.text === erwartetCode}, Ausschneiden: Zwischenablage=${q(kopCut.text)}, Datei danach ohne die Zeile=${kopCut.doc === vorCut.replace(dateiZeile, "")}`);
    // Die Ausschneidprobe hat die Zeile gelöscht: Notiz neu anlegen, damit LP5 bis LP8 den vollen Inhalt sehen.
    await cdp.evaluate(`const l = ${BLATT(NOTIZ_LP)}; if (l) l.detach(); return true;`);
    await cdp.evaluate(LEGE_NOTIZ_AN(NOTIZ_LP, LP_INHALT));
    const lpNeu = await oeffneNotiz(cdp, NOTIZ_LP, "source", 0, false);
    const lp5Start = lpNeu ? await pollUntil<LpStand>(cdp, lpBereit("s.widgets.length >= 5"), 12_000, 250) : null;
    const summeLpVor = pruefsumme(info.basePath, NOTIZ_LP);

    // LP5: Umschalter, Sperren, Entsperren, Cursor in der offenen Live Preview; die Datei bleibt, wie sie war
    await cdp.evaluate(`app.workspace.setActiveLeaf(${BLATT(NOTIZ_LP)}, { focus: true }); app.commands.executeCommandById(${q(`${PLUGIN_ID}:toggle-plaintext`)}); return true;`);
    const lp5Aus = lp5Start ? await pollUntil<LpStand>(cdp, lpBereit(`s.widgets.length >= 5 && s.widgets.filter((w) => w.raw !== ${q(MAX_MAIL_5)}).every((w) => w.text === w.raw && !w.shown) && !${KLARTEXT_JS}.test(s.zeilen.map((z) => z.text).join("\\n"))`), 8000, 200) : null;
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:toggle-plaintext`)}); return true;`);
    const lp5An = lp5Aus ? await pollUntil<LpStand>(cdp, lpBereit("s.widgets.filter((w) => w.shown).length >= 4"), 8000, 200) : null;
    for (const [zeile, spalte] of [[2, 3], [4, 10], [6, 4], [0, 0]]) await cdp.evaluate(SETZE_CURSOR(NOTIZ_LP, zeile!, spalte!));
    await cdp.evaluate(`const p = ${P}; if (!p) return false; p.keys.clear(); await p.refreshTables(); return true;`);
    const lp5Gesperrt = lp5An ? await pollUntil<LpStand>(cdp, lpBereit(`s.widgets.length >= 5 && s.widgets.every((w) => w.unreadable && w.text === w.raw) && !${KLARTEXT_JS}.test(s.zeilen.map((z) => z.text).join("\\n"))`), 12_000, 250) : null;
    await cdp.evaluate(`
      const p = ${P}; if (!p) return false;
      const k = ${q(schluesselW)};
      if (!k) return false;
      p.keys.write({ chainId: Uint8Array.from(k.chainId), stand: k.stand, key: Uint8Array.from(k.key) });
      await p.refreshTables();
      return true;
    `);
    const lp5Entsperrt = lp5Gesperrt ? await pollUntil<LpStand>(cdp, lpBereit("s.widgets.filter((w) => w.shown).length >= 4"), 12_000, 250) : null;
    const summeLpNach = pruefsumme(info.basePath, NOTIZ_LP);
    const lpEditorWert = await cdp.evaluate<string>(`const l = ${BLATT(NOTIZ_LP)}; return l ? l.view.editor.getValue() : "";`);
    record("LP5 Umschalter, Sperren, Entsperren und Cursor-Bewegung in der offenen Live Preview ohne Neuöffnen: aus zeigt die Platzhalter ohne Klartext im DOM, gesperrt alle Stellen nicht lesbar, entsperrt wieder Klartext; Datei und Editorinhalt bleiben byte-gleich (SHA-256)",
      Boolean(lp5Start) && Boolean(lp5Aus) && Boolean(lp5An) && Boolean(lp5Gesperrt) && Boolean(lp5Entsperrt) && schluesselW !== null
        && summeLpVor !== null && summeLpVor === summeLpNach && sha(lpEditorWert) === sha(LP_INHALT) && summeLpDatei === summeLpNach,
      `aus=${Boolean(lp5Aus)}, an=${Boolean(lp5An)}, gesperrt=${Boolean(lp5Gesperrt)}, entsperrt=${Boolean(lp5Entsperrt)}, Prüfsumme vorher=${summeLpVor?.slice(0, 12) ?? null} nachher=${summeLpNach?.slice(0, 12) ?? null}, Editorinhalt gleich Vorlage=${sha(lpEditorWert) === sha(LP_INHALT)}`);

    // LP7: Laufzeit in der großen Notiz, gegen die Vergleichsnotiz ohne Platzhalter und den Messwert des Bausteins
    const mit = grosseNotiz(true);
    const ohne = grosseNotiz(false);
    await cdp.evaluate(LEGE_NOTIZ_AN(NOTIZ_LP_GROSS, mit.text));
    await cdp.evaluate(LEGE_NOTIZ_AN(NOTIZ_LP_LEER, ohne.text));
    const summeGrossVor = pruefsumme(info.basePath, NOTIZ_LP_GROSS);
    type Tippen = { sync: number; syncP95: number; bild: number; widgets: number; zeilen: number };
    const grossOffen = await oeffneNotiz(cdp, NOTIZ_LP_GROSS, "source", 0, false);
    const grossBereit = grossOffen ? await pollUntil<number>(cdp, `const c = ${WURZEL(NOTIZ_LP_GROSS)}; return c && c.querySelectorAll(".cm-line").length > 5 ? 1 : null;`, 15_000, 300) : null;
    // Scrollen und Cursor: die Datei bleibt byte-gleich
    await cdp.evaluate(`
      const ed = ${BLATT(NOTIZ_LP_GROSS)}.view.editor;
      for (const z of [0, 2500, 5000, 9990, 4000]) { ed.scrollIntoView({ from: { line: z, ch: 0 }, to: { line: z + 20, ch: 0 } }, true); await new Promise((r) => setTimeout(r, 300)); ed.setCursor({ line: z, ch: 0 }); }
      return true;
    `);
    const summeGrossScroll = pruefsumme(info.basePath, NOTIZ_LP_GROSS);
    const tippenMit = grossBereit ? await cdp.evaluate<Tippen>(MESSE_TIPPEN(NOTIZ_LP_GROSS, 4000, 60)) : null;
    const leerOffen = await oeffneNotiz(cdp, NOTIZ_LP_LEER, "source", 0, false);
    const leerBereit = leerOffen ? await pollUntil<number>(cdp, `const c = ${WURZEL(NOTIZ_LP_LEER)}; return c && c.querySelectorAll(".cm-line").length > 5 ? 1 : null;`, 15_000, 300) : null;
    const tippenOhne = leerBereit ? await cdp.evaluate<Tippen>(MESSE_TIPPEN(NOTIZ_LP_LEER, 4000, 60)) : null;
    const aufschlag = tippenMit && tippenOhne ? tippenMit.sync - tippenOhne.sync : null;
    // Schwelle des Bausteins (obsidian-kit 0.104.0, gemessen in Obsidian 1.15.1: Aufschlag 0,3 ms, Median 3,2 ms synchron): Aufschlag unter 8 ms, Median unter 50 ms. Die Zaunliste je Dokumentstand ist der Teil, den das Plugin dazu legt.
    record("LP7 Notiz mit 10 000 Zeilen und 500 Platzhaltern (Zäune mit weiteren darin): die Zeit je Tastendruck liegt gegen die gleich große Notiz ohne Platzhalter unter dem Kit-Schwellenwert (Aufschlag unter 8 ms, Median unter 50 ms); im DOM stehen nur die Widgets des sichtbaren Bereichs; Scrollen und Cursor lassen die Datei byte-gleich",
      tippenMit !== null && tippenOhne !== null && aufschlag !== null && aufschlag < 8 && tippenMit.sync < 50 && tippenMit.widgets > 0 && tippenMit.widgets < 100
        && summeGrossVor !== null && summeGrossVor === summeGrossScroll && sha(mit.text) === summeGrossVor,
      `Stellen in der Notiz=${mit.stellen}, mit Platzhaltern: Median synchron ${tippenMit?.sync.toFixed(1) ?? "?"} ms (p95 ${tippenMit?.syncP95.toFixed(1) ?? "?"}), bis zum Bild ${tippenMit?.bild.toFixed(1) ?? "?"} ms, Widgets im DOM ${tippenMit?.widgets ?? "?"} von ${tippenMit?.zeilen ?? "?"} Zeilen; ohne: Median ${tippenOhne?.sync.toFixed(1) ?? "?"} ms, bis zum Bild ${tippenOhne?.bild.toFixed(1) ?? "?"} ms; Aufschlag ${aufschlag?.toFixed(1) ?? "?"} ms (Kit gemessen: 0,3 ms, Median 3,2 ms); Prüfsumme nach Scrollen gleich=${summeGrossVor !== null && summeGrossVor === summeGrossScroll}`);
    await cdp.evaluate(`
      for (const n of [${q(NOTIZ_LP_GROSS)}, ${q(NOTIZ_LP_LEER)}]) {
        const l = app.workspace.getLeavesOfType("markdown").find((x) => x.view.containerEl.getAttribute("data-pseu-smoke") === n);
        if (l) l.detach();
        const f = app.vault.getAbstractFileByPath(n);
        if (f) await app.vault.delete(f);
      }
      return true;
    `);
    await cdp.evaluate(`app.workspace.setActiveLeaf(${BLATT(NOTIZ_LP)}, { focus: true }); return true;`);
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

    // --- J ---
    console.log("\nJ · Vergessen in der offenen Lesesicht");
    // Ein Blatt im Hintergrund baut seine Lesesicht ab (gemessen im Lauf 2: kein einziger Platzhalter-Knoten im DOM des Blatts); es wird erst wieder gezeichnet, wenn es nach vorn kommt.
    await cdp.evaluate(`app.workspace.setActiveLeaf(${BLATT(NOTIZ_LESEN)}, { focus: true }); return true;`);
    const nachVergessen = lesenOffen ? await pollUntil<Lesestand>(cdp, `
      const st = (() => { ${LESESTAND(NOTIZ_LESEN)} })();
      if (!st) return null;
      const max = st.stellen.filter((x) => x.raw.toLowerCase().startsWith(${q(MAX.toLowerCase())}));
      return max.length >= 7 && max.every((x) => x.forgotten) ? st : null;
    `, 20_000, 300) : null;
    // Bei einem Zeitablauf den letzten Stand lesen, damit ein Rot sagt, was im DOM stand.
    const letzterStand = nachVergessen ?? (lesenOffen ? await cdp.evaluate<Lesestand | null>(LESESTAND(NOTIZ_LESEN)) : null);
    if (!nachVergessen && letzterStand) console.log(`  (J letzter Stand: ${q(letzterStand.stellen.map((x) => ({ raw: x.raw, text: x.text, vergessen: x.forgotten, unlesbar: x.unreadable })))})`);
    const maxStellen = nachVergessen ? nachVergessen.stellen.filter((x) => x.raw.toLowerCase().startsWith(MAX.toLowerCase())) : [];
    const bertaStelle = nachVergessen ? nachVergessen.stellen.filter((x) => x.raw === `Person_${FREMD2_ID}`) : [];
    record("J Vergessen in der offenen Lesesicht: die Stellen der vergessenen Person schalten ohne Neuöffnen auf „vergessen“ (Klasse, Tooltip, kein Klartext im DOM), die der anderen Person bleiben lesbar",
      Boolean(nachVergessen) && maxStellen.length >= 7 && maxStellen.every((x) => x.text === x.raw && /forgotten/.test(x.title) && x.linie === "double")
        && !KLARTEXT_MAX.test(nachVergessen!.html) && nachVergessen!.klartextInAttribut === 0
        && bertaStelle.length === 1 && bertaStelle[0]!.shown && bertaStelle[0]!.text === "Berta Beispiel",
      `Stellen der vergessenen Person=${maxStellen.length} (alle vergessen=${maxStellen.every((x) => x.forgotten)}), Klartext von Max im DOM=${nachVergessen ? KLARTEXT_MAX.test(nachVergessen.html) : null}, Berta=${q(bertaStelle.map((x) => x.text))}`);
    await cdp.evaluate(`const l = ${BLATT(NOTIZ_LESEN)}; if (l) l.detach(); return true;`);
    await cdp.send("Network.disable");

    // --- LP8: Vergessen in der offenen Live Preview ---
    console.log("\nLP8 · Vergessen in der offenen Live Preview");
    await cdp.evaluate(`app.workspace.setActiveLeaf(${BLATT(NOTIZ_LP)}, { focus: true }); return true;`);
    const lp8 = await pollUntil<LpStand>(cdp, `
      const s = (() => { ${LP_STAND(NOTIZ_LP)} })();
      if (!s) return null;
      const max = s.widgets.filter((w) => w.raw.toLowerCase().startsWith(${q(MAX.toLowerCase())}));
      return max.length >= 4 && max.every((w) => w.forgotten) ? s : null;
    `, 20_000, 300);
    const lp8Max = lp8 ? lp8.widgets.filter((w) => w.raw.toLowerCase().startsWith(MAX.toLowerCase())) : [];
    const lp8Berta = lp8 ? lp8.widgets.filter((w) => w.raw === `Person_${FREMD2_ID}`) : [];
    record("LP8 Vergessen in der offenen Live Preview: die Stellen der vergessenen Person schalten ohne Neuöffnen auf „vergessen“ (Klasse, doppelte Linie, Tooltip, Text der Platzhalter), kein Klartext von ihr bleibt im DOM, die Stelle der anderen Person bleibt lesbar, Unbekanntes bleibt Text",
      Boolean(lp8) && lp8Max.length >= 4 && lp8Max.every((w) => w.text === w.raw && /forgotten/.test(w.title) && w.linie === "double")
        && !KLARTEXT_MAX.test(lp8!.zeilen.map((z) => z.text).join("\n")) && lp8!.klartextAttribut === 0
        && lp8Berta.length === 1 && lp8Berta[0]!.shown && lp8Berta[0]!.text === "Berta Beispiel"
        && !lp8!.widgets.some((w) => w.raw === "Person_a2b3c4d5e6"),
      `Stellen der vergessenen Person=${lp8Max.length} (alle vergessen=${lp8Max.every((w) => w.forgotten)}), Berta=${q(lp8Berta.map((w) => w.text))}, Klartext von Max im Editor=${lp8 ? KLARTEXT_MAX.test(lp8.zeilen.map((z) => z.text).join("\n")) : null}`);
    await cdp.evaluate(`const l = ${BLATT(NOTIZ_LP)}; if (l) l.detach(); return true;`);

    // --- B ---
    console.log("\nB · Prüffenster");
    // Der transform läuft im Renderer und bleibt offen, bis das Fenster antwortet; der Treiber hält das Versprechen in `window` und holt es nach dem Klick.
    const starteB = (text: string, schluessel: string, titel?: string): Promise<boolean> =>
      cdp.evaluate<boolean>(`const p = ${P}; if (!p) return false; window.__pseuB = p.api.transform(${PRUEF_ANFRAGE(text, schluessel, true, titel)}); return true;`);
    const holeB = (): Promise<unknown> => cdp.evaluate<unknown>(`return await window.__pseuB;`);
    const unbeaufsichtigt = (text: string, schluessel: string): Promise<unknown> =>
      cdp.evaluate<unknown>(`const p = ${P}; return p ? await p.api.transform(${PRUEF_ANFRAGE(text, schluessel, false)}) : null;`);
    const bilderDir = mkdtempSync(join(tmpdir(), "pseu-pruef-"));
    const fensterVorher = await cdp.evaluate<number[]>(`return window.require("electron").remote.getCurrentWindow().getSize();`);
    await setWindowSize(cdp, 1200, 800);

    // B1: das Fenster öffnet, Aufbau lesen, Desktop-Bild aufnehmen
    await starteB(PRUEF_TEXT, "smoke-pruef-1", "Rückfrage zum Angebot");
    const b1 = await pollUntil<{ titel: string; kopf: string; karten: { found: string; stellen: string; treffer: string; radiogruppe: boolean; wege: string[]; aktiv: string; besitzer: string; optionen: string[] }[]; knoepfe: { text: string; cta: boolean }[]; breite: number }>(cdp, PRUEF_DIALOG, 10_000, 250);
    const kName = b1?.karten.find((k) => k.found === "Erika Musterfrau");
    const kTel = b1?.karten.find((k) => k.found === "030 7654321");
    const letzte = b1?.knoepfe.slice(-2) ?? [];
    record("B1 Prüffenster: ein transform mit interactive true öffnet es; eine Karte je Wert (Name mit zwei Stellen, eine Nummer), Kopfzeile mit Zahlen, die drei Wege als Radiogruppe mit Ersetzen als Vorgabe, „Gehört zu“ ohne Vorschlag auf „niemandem“, Abbrechen links, „übernehmen“ rechts als mod-cta",
      Boolean(b1) && b1!.titel === 'Pseudonymize: "Rückfrage zum Angebot"' && /^2 new findings · \d+ known values? (is|are) replaced$/.test(b1!.kopf) && b1!.karten.length === 2
        && kName?.stellen === "2 places" && kName.treffer === "Erika Musterfrau" && kTel?.stellen === "1 place"
        && b1!.karten.every((k) => k.radiogruppe && k.aktiv === "replace" && k.wege.join("|") === "Replace|Keep here|Always keep")
        && kTel!.besitzer === "nobody" && !kTel!.optionen.includes("suggested") && kName!.besitzer === "new-person"
        && letzte.length === 2 && letzte[0]!.text === "Cancel" && !letzte[0]!.cta && /^Replace 2, apply$/.test(letzte[1]!.text) && letzte[1]!.cta,
      `Titel=${q(b1?.titel)}, Kopf=${q(b1?.kopf)}, Karten=${q(b1?.karten.map((k) => [k.found, k.stellen, k.aktiv, k.besitzer]))}, Knöpfe=${q(letzte)}`);
    let desktopBild = "";
    if (b1) {
      const box = await boxOf(cdp, ".modal.pseu-review-modal", 8);
      desktopBild = join(bilderDir, "pruefen-desktop.png");
      writeFileSync(desktopBild, await capture(cdp, box ?? undefined, 1));
    }

    // B5 (Telefon): bildschirmfüllend nachgestellt. Das Plugin setzt `pseu-review-full` über `Platform.isPhone`, das der Treiber nicht umschalten kann; er setzt Klasse und Körperklassen selbst und die Fensterbreite auf 402 px. Eine Nachstellung, kein echtes Telefon.
    let telefonBild = "";
    let telefon: { breite: number; hoehe: number; weghoehen: number[] } | null = null;
    if (b1) {
      await cdp.evaluate(`document.body.classList.add("is-phone", "is-mobile"); document.querySelector(".modal.pseu-review-modal").classList.add("pseu-review-full"); return true;`);
      await setWindowSize(cdp, 402, 874);
      telefon = await pollUntil<{ breite: number; hoehe: number; weghoehen: number[] }>(cdp, `
        const d = (() => { ${PRUEF_DIALOG} })();
        return d ? { breite: d.breite, hoehe: d.hoehe, weghoehen: d.karten.flatMap((k) => k.weghoehen) } : null;
      `, 8000, 250);
      telefonBild = join(bilderDir, "pruefen-402.png");
      writeFileSync(telefonBild, await capture(cdp, undefined, 1));
      await cdp.evaluate(`document.body.classList.remove("is-phone", "is-mobile"); const m = document.querySelector(".modal.pseu-review-modal"); if (m) m.classList.remove("pseu-review-full"); return true;`);
      await setWindowSize(cdp, 1200, 800);
    }
    const bildGroesse = (pfad: string): number => (pfad !== "" && existsSync(pfad) ? statSync(pfad).size : 0);
    record("B5 Bilder des Prüffensters: Desktop und 402 px Breite (am Telefon bildschirmfüllend, Wege als Tippflächen von mindestens 44 px gemessen); die Bilder sind selbst anzusehen",
      bildGroesse(desktopBild) > 5000 && bildGroesse(telefonBild) > 5000 && telefon !== null && telefon.breite >= 380 && telefon.weghoehen.length > 0 && telefon.weghoehen.every((h) => h >= 44),
      `Desktop=${desktopBild} (${bildGroesse(desktopBild)} B), 402 px=${telefonBild} (${bildGroesse(telefonBild)} B), Fenster am Telefon=${q(telefon)} (nachgestellt über Klassen, kein echtes Telefon)`);

    // B2: Abbrechen schreibt nichts; erst der Knopf, dann Esc mit echter Taste
    const vorB2 = dateiHash(info.basePath, eigeneId);
    await klickeKnopf(cdp, "Cancel");
    const b2abbruch = b1 ? await holeB() : null;
    const nachCancel = dateiHash(info.basePath, eigeneId);
    await starteB(PRUEF_TEXT, "smoke-pruef-1");
    const b2offen = await pollUntil<unknown>(cdp, PRUEF_DIALOG, 10_000, 250);
    if (b2offen) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    }
    const geschlossen = b2offen ? await pollUntil<boolean>(cdp, `return document.querySelector(".modal.pseu-review-modal") ? null : true;`, 8000, 250) : null;
    const esc = b2offen ? await holeB() : null;
    const nachEsc = dateiHash(info.basePath, eigeneId);
    const weiterFragt = await unbeaufsichtigt(PRUEF_TEXT, "smoke-pruef-1");
    record("B2 Abbrechen und Esc (echte Taste): transform liefert cancelled, die Gerätedatei auf der Platte bleibt byte-gleich, ein unbeaufsichtigter transform fragt weiter (deferred)",
      Boolean(b1) && (b2abbruch as { error?: string } | null)?.error === "cancelled" && vorB2 !== null && nachCancel === vorB2
        && Boolean(b2offen) && Boolean(geschlossen) && (esc as { error?: string } | null)?.error === "cancelled" && nachEsc === vorB2
        && (weiterFragt as { error?: string } | null)?.error === "deferred",
      `Abbrechen=${q(b2abbruch)}, Datei gleich=${nachCancel === vorB2}, Esc: Fenster offen=${Boolean(b2offen)}, geschlossen=${Boolean(geschlossen)}, Antwort=${q(esc)}, Datei gleich=${nachEsc === vorB2}, unbeaufsichtigt=${q(weiterFragt)}`);
    await clearNotices(cdp);

    // B3: Hier lassen für den Namen, die Nummer wird ersetzt; erst „übernehmen“ schreibt
    await starteB(PRUEF_TEXT, "smoke-pruef-1");
    const b3offen = await pollUntil<unknown>(cdp, PRUEF_DIALOG, 10_000, 250);
    const b3weg = b3offen ? await clickReal(cdp, PRUEF_WEG("Erika Musterfrau", "keep-here")) : false;
    const b3zahl = b3weg ? await pollUntil<string>(cdp, `
      const b = Array.from(document.querySelectorAll(".modal.pseu-review-modal .modal-button-container button")).pop();
      return b && b.textContent.trim() === "Replace 1, apply" ? b.textContent.trim() : null;
    `, 5000, 200) : null;
    const vorApply = dateiHash(info.basePath, eigeneId);
    const b3apply = b3zahl ? await klickeKnopf(cdp, "Replace 1, apply") : false;
    const b3ergebnis = b3apply ? await holeB() as { parts?: { value: string }[] } | null : null;
    const b3wert = b3ergebnis?.parts?.[0]?.value ?? "";
    const nachApply = dateiHash(info.basePath, eigeneId);
    const schluesselB = await leseSchluessel(cdp);
    const dateiB = schluesselB && eigeneId ? await oeffneEigeneDatei(info.basePath, eigeneId, schluesselB) : null;
    const gleichesDokument = await unbeaufsichtigt("Hallo Erika Musterfrau,", "smoke-pruef-1") as { parts?: { value: string }[]; error?: string };
    const anderesDokument = await unbeaufsichtigt("Hallo Erika Musterfrau,", "smoke-pruef-2") as { error?: string };
    record("B3 Wege und übernehmen: „Hier lassen“ lässt den Namen stehen und gilt nur für denselben documentKey, die Nummer wird ersetzt und steht in der Gerätedatei auf der Platte (mit dem Schlüssel geöffnet), die Platte änderte sich erst mit „übernehmen“",
      Boolean(b3offen) && b3weg && Boolean(b3zahl) && vorApply === vorB2 && b3apply
        && /^Hallo Erika Musterfrau,\nTel Phone_[0-9a-z]{10}\.\nHallo Erika Musterfrau, bis bald\.$/.test(b3wert)
        && nachApply !== null && nachApply !== vorB2 && dateiB !== null && dateiB.tabelle.includes("030 7654321")
        && gleichesDokument.parts?.[0]?.value === "Hallo Erika Musterfrau," && anderesDokument.error === "deferred",
      `Weg gesetzt=${b3weg}, Knopf=${q(b3zahl)}, Platte vor „übernehmen“ unverändert=${vorApply === vorB2}, Ergebnis=${q(b3wert)}, Platte danach geändert=${nachApply !== vorB2}, Nummer in der Datei=${dateiB?.tabelle.includes("030 7654321") ?? null}, gleicher Schlüssel unbeaufsichtigt=${q(gleichesDokument)}, anderer=${q(anderesDokument)}`);
    await clearNotices(cdp);

    // B4: Text ansehen, Auswahl hinzufügen
    await starteB(PRUEF_NOTIZ, "smoke-pruef-3");
    const b4offen = await pollUntil<{ karten: { found: string }[] }>(cdp, PRUEF_DIALOG, 10_000, 250);
    const b4text = b4offen ? await clickReal(cdp, `(Array.from(document.querySelectorAll(".modal.pseu-review-modal button")).find((b) => b.textContent.trim() === "Look at the text and mark more places") || null)`) : false;
    const b4sichtbar = b4text ? await pollUntil<boolean>(cdp, `return document.querySelector(".modal.pseu-review-modal .pseu-review-text") ? true : null;`, 5000, 200) : null;
    // Eine echte Auswahl im Text; das Fenster merkt sie sich (`selectionchange`).
    const b4auswahl = b4sichtbar ? await cdp.evaluate<string>(`
      const wurzel = document.querySelector(".modal.pseu-review-modal .pseu-review-text");
      const w = document.createTreeWalker(wurzel, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const i = n.textContent.indexOf("Schmidt ruft");
        if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + "Schmidt".length); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); }
      }
      return "";
    `) : "";
    await new Promise((r) => setTimeout(r, 400));
    const b4art = b4auswahl === "Schmidt" ? await cdp.evaluate<boolean>(`
      const s = document.querySelector(".modal.pseu-review-modal .pseu-review-mark-kind");
      if (!s) return false;
      s.value = "person"; s.dispatchEvent(new Event("change"));
      return true;
    `) : false;
    const b4hinzu = b4art ? await clickReal(cdp, `(Array.from(document.querySelectorAll(".modal.pseu-review-modal button")).find((b) => b.textContent.trim() === "Add selection") || null)`) : false;
    const b4neu = b4hinzu ? await pollUntil<{ karten: { found: string; stellen: string }[]; knoepfe: { text: string }[] }>(cdp, `
      const d = (() => { ${PRUEF_DIALOG} })();
      return d && d.karten.some((k) => k.found === "Schmidt") ? d : null;
    `, 5000, 200) : null;
    const b4apply = b4neu ? await klickeKnopf(cdp, b4neu.knoepfe[b4neu.knoepfe.length - 1]?.text ?? "") : false;
    const b4ergebnis = b4apply ? await holeB() as { parts?: { value: string }[] } | null : null;
    const b4wert = b4ergebnis?.parts?.[0]?.value ?? "";
    const b4schmidt = /^Hallo (Gustav Probe|Person_[0-9a-z]{10}),\nDie Kollegin Person_([0-9a-z]{10}) schrieb\. Person_\2 ruft an, Schmidtke nicht\.$/.exec(b4wert);
    record("B4 Text ansehen und markieren: eine Auswahl im Text wird als Person hinzugefügt, jede freie Stelle wird eine Karte und nach „übernehmen“ mit einer Kennung ersetzt, ein längeres Wort bleibt",
      Boolean(b4offen) && b4text && Boolean(b4sichtbar) && b4auswahl === "Schmidt" && b4art && b4hinzu && Boolean(b4neu)
        && b4neu!.karten.find((k) => k.found === "Schmidt")?.stellen === "2 places" && b4apply && b4schmidt !== null,
      `Text gezeigt=${Boolean(b4sichtbar)}, Auswahl=${q(b4auswahl)}, Karten danach=${q(b4neu?.karten.map((k) => [k.found, k.stellen]))}, Ergebnis=${q(b4wert)}`);
    await clearNotices(cdp);
    await setWindowSize(cdp, fensterVorher[0] ?? 1200, fensterVorher[1] ?? 800);
    console.log(`  Bilder des Prüffensters: ${bilderDir}`);

    // --- NA: Auswahl und Notiz pseudonymisieren (Aufgabe 15) ---
    // Geschrieben, noch nicht gelaufen (Rechner unter Last). Stand hier: bereit, Berta Beispiel ist bekannt (Name), ihre Adresse nicht. Die Notizen legt der Treiber selbst an (Präfix `Smoke-`) und löscht sie am Ende und im Aufräumen.
    console.log("\nNA · Auswahl und Notiz pseudonymisieren");
    await cdp.evaluate(LOESCHE_SMOKE_NOTIZEN);
    const schluesselNA = await leseSchluessel(cdp);
    const erkennbar = (id: string): string => `Hallo, ${id} schrieb gestern.\n`;
    const restoreVon = (text: string): Promise<{ text?: string; error?: string } | null> =>
      cdp.evaluate(`const p = ${P}; return p ? p.api.restore(${q(text)}, { caller: "gui-smoke" }) : null;`);

    // NA1 und NA2: dieselbe Abfolge im Quelltext und in Live Preview
    const auswahlLauf = async (pfad: string, quelltext: boolean): Promise<{ ok: boolean; detail: string }> => {
      await cdp.evaluate(LEGE_NOTIZ_AN(pfad, NA_AUSWAHL));
      const offen = await oeffneNotiz(cdp, pfad, "source", 0, quelltext);
      const gewaehlt = offen ? await cdp.evaluate<string>(WAEHLE_TEXT(pfad, "Erika Musterfrau")) : "";
      if (gewaehlt !== "Erika Musterfrau") return { ok: false, detail: `Auswahl=${q(gewaehlt)}` };
      await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:pseudonymize-selection`)}); return true;`);
      const art = await pollUntil<boolean>(cdp, `return Array.from(document.querySelectorAll(".modal button")).some((b) => b.textContent.trim() === "Person") ? true : null;`, 8000, 200);
      const artGeklickt = art ? await klickeKnopf(cdp, "Person") : false;
      const vorschlag = artGeklickt ? await pollUntil<boolean>(cdp, `return ${ERSTER_VORSCHLAG} ? true : null;`, 8000, 200) : null;
      const gewaehltPerson = vorschlag ? await clickReal(cdp, ERSTER_VORSCHLAG) : false;
      const ersetzt = gewaehltPerson ? await pollUntil<string>(cdp, `
        const l = ${BLATT(pfad)};
        const v = l ? l.view.editor.getValue() : "";
        return /^Hallo, Person_[0-9a-z]{10} schrieb gestern\\.\\n$/.test(v) ? v : null;
      `, 10_000, 250) : null;
      // Die Platte folgt dem Editor (Obsidian speichert nach rund zwei Sekunden).
      const platte = ersetzt ? await pollUntil<string>(cdp, PLATTE_GLEICH(pfad, ersetzt), 8000, 250) : null;
      const zurueck = ersetzt ? await restoreVon(ersetzt) : null;
      const id = ersetzt ? /Person_[0-9a-z]{10}/.exec(ersetzt)?.[0] ?? "" : "";
      await cdp.evaluate(`const l = ${BLATT(pfad)}; if (l) l.view.editor.undo(); return true;`);
      const nachUndo = await cdp.evaluate<string | null>(EDITOR_TEXT(pfad));
      const ok = Boolean(art) && artGeklickt && Boolean(vorschlag) && gewaehltPerson && ersetzt !== null && platte === ersetzt
        && zurueck !== null && zurueck.text === erkennbar("Erika Musterfrau") && nachUndo === NA_AUSWAHL && id !== "";
      return { ok, detail: `Dialoge: Art=${Boolean(art)}, Person=${Boolean(vorschlag)}; Editor=${q(ersetzt)}, Platte folgt=${platte !== null}, restore=${q(zurueck?.text ?? zurueck)}, nach Rückgängig=${q(nachUndo)}` };
    };
    const na1 = schluesselNA ? await auswahlLauf("Smoke-Auswahl-Quelltext.md", true) : { ok: false, detail: "kein Schlüssel" };
    record("NA1 Auswahl pseudonymisieren im Quelltext: Art und Person gewählt, die Auswahl wird durch einen Platzhalter ersetzt, die Datei auf der Platte folgt, restore löst ihn auf, ein Rückgängig stellt den Text her", na1.ok, na1.detail);
    await cdp.evaluate(SCHLIESSE_NOTIZEN);
    await clearNotices(cdp);
    const na2 = schluesselNA ? await auswahlLauf("Smoke-Auswahl-LivePreview.md", false) : { ok: false, detail: "kein Schlüssel" };
    record("NA2 Auswahl pseudonymisieren in Live Preview: dasselbe Ergebnis wie im Quelltext", na2.ok, na2.detail);
    await cdp.evaluate(SCHLIESSE_NOTIZEN);
    await clearNotices(cdp);

    // NA3: Notiz mit Frontmatter, Prüffenster, übernehmen; die Notiz ist in der Lesesicht offen (Weg über `vault.process`), gezählt werden die modify-Ereignisse
    const NOTIZ = "Smoke-Notiz.md";
    await cdp.evaluate(LEGE_NOTIZ_AN(NOTIZ, NA_NOTIZ));
    const na3offen = await oeffneNotiz(cdp, NOTIZ, "preview", 0);
    await cdp.evaluate(`window.__pseuMod = 0; window.__pseuModRef = app.vault.on("modify", (f) => { if (f.path === ${q(NOTIZ)}) window.__pseuMod += 1; }); return true;`);
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:pseudonymize-note`)}); return true;`);
    const na3fenster = na3offen ? await pollUntil<boolean>(cdp, `return document.querySelector(".modal.pseu-review-modal") ? true : null;`, 10_000, 250) : null;
    const na3apply = na3fenster ? await clickReal(cdp, LETZTER_KNOPF) : false;
    const na3text = na3apply ? await pollUntil<string>(cdp, PLATTE_GEAENDERT(NOTIZ, "Berta Beispiel <"), 10_000, 250) : null;
    await new Promise((r) => setTimeout(r, 2500));
    const modifys = await cdp.evaluate<number>(`app.vault.offref(window.__pseuModRef); return window.__pseuMod;`);
    const na3 = na3text === null ? null : new RegExp(`^---\\nfrom: ${FREMD2_PLATZHALTER} <(Mail_[0-9a-z]{10})>\\nup: "\\[\\[Berta Beispiel\\]\\]"\\ncc:\\n {2}- ${FREMD2_PLATZHALTER}\\n---\\nHallo ${FREMD2_PLATZHALTER}, schreib an (Mail_[0-9a-z]{10})\\.\\n$`).exec(na3text);
    record("NA3 Diese Notiz pseudonymisieren mit Prüffenster und „übernehmen“: Frontmatter und Text in genau einem Schreibvorgang der Notiz, die Eigenschaft up mit dem Wikilink bleibt byte-gleich, from und cc ungequotet mit den Platzhaltern, kein Klartext mehr in der Notiz",
      Boolean(na3offen) && Boolean(na3fenster) && na3apply && na3 !== null && na3[1] === na3[2] && modifys === 1 && !/Berta Beispiel|berta@/i.test((na3text ?? "").replace('up: "[[Berta Beispiel]]"', "")),
      `Fenster=${Boolean(na3fenster)}, Notiz danach=${q(na3text)}, modify-Ereignisse=${modifys}`);
    await clearNotices(cdp);

    // NA4: der Eigenschaften-Bereich zeigt die Werte zeichengleich (Live Preview, Eigenschaften im Dokument sichtbar)
    await cdp.evaluate(SCHLIESSE_NOTIZEN);
    const na4offen = await oeffneNotiz(cdp, NOTIZ, "source", 0, false);
    const eigenschaften = na4offen ? await pollUntil<{ from: string; cc: string[] }>(cdp, `
      const c = ${WURZEL(NOTIZ)};
      const f = c ? c.querySelector('.metadata-property[data-property-key="from"]') : null;
      if (!f) return null;
      const feld = f.querySelector(".metadata-property-value .metadata-input-longtext, .metadata-property-value input, .metadata-property-value");
      const cc = Array.from(c.querySelectorAll('.metadata-property[data-property-key="cc"] .multi-select-pill-content')).map((e) => e.textContent.trim());
      return { from: feld ? (feld.value !== undefined && feld.value !== "" ? feld.value : feld.textContent.trim()) : "", cc };
    `, 10_000, 250) : null;
    const dateiFrom = /^from: (.*)$/m.exec(na3text ?? "")?.[1] ?? "<fehlt>";
    record("NA4 Der Eigenschaften-Bereich zeigt den Wert von from und den Listeneintrag von cc zeichengleich zur Datei",
      eigenschaften !== null && eigenschaften.from === dateiFrom && eigenschaften.cc.length === 1 && eigenschaften.cc[0] === FREMD2_PLATZHALTER,
      `Datei: from=${q(dateiFrom)}; Eigenschaften-Bereich: ${q(eigenschaften)}`);
    await cdp.evaluate(SCHLIESSE_NOTIZEN);

    // NA5: Abbruch im Prüffenster
    const ABBRUCH = "Smoke-Abbruch.md";
    // Nach NA3 kennt die Tabelle Berta und ihre Adresse; eine andere, noch unbekannte Adresse bringt das Prüffenster wieder.
    const NA5_NOTIZ = NA_NOTIZ.replaceAll("berta@example.org", "berta.neu@example.org");
    await cdp.evaluate(LEGE_NOTIZ_AN(ABBRUCH, NA5_NOTIZ));
    const na5offen = await oeffneNotiz(cdp, ABBRUCH, "preview", 0);
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:pseudonymize-note`)}); return true;`);
    const na5fenster = na5offen ? await pollUntil<boolean>(cdp, `return document.querySelector(".modal.pseu-review-modal") ? true : null;`, 10_000, 250) : null;
    const na5abbruch = na5fenster ? await klickeKnopf(cdp, "Cancel") : false;
    const na5notice = na5abbruch ? await pollUntil<string>(cdp, NOTICE_MIT("Cancelled"), 5000, 200) : null;
    const na5platte = await cdp.evaluate<string | null>(PLATTE_TEXT(ABBRUCH));
    record("NA5 Diese Notiz pseudonymisieren, im Prüffenster abgebrochen: die Notiz ist byte-gleich, die Notice nennt den Abbruch ohne Klartext",
      Boolean(na5fenster) && na5abbruch && na5platte === NA5_NOTIZ && na5notice !== null && !/Berta|berta@/i.test(na5notice),
      `Fenster=${Boolean(na5fenster)}, Notiz gleich=${na5platte === NA5_NOTIZ}, Notice=${q(na5notice)}`);
    await clearNotices(cdp);
    await cdp.evaluate(SCHLIESSE_NOTIZEN);

    // NA6: mailstone-Notiz
    const MAILNOTIZ = "Smoke-Mail.md";
    await cdp.evaluate(LEGE_NOTIZ_AN(MAILNOTIZ, NA_MAIL));
    const na6offen = await oeffneNotiz(cdp, MAILNOTIZ, "preview", 0);
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:pseudonymize-note`)}); return true;`);
    const na6notice = na6offen ? await pollUntil<string>(cdp, NOTICE_MIT("mailstone"), 8000, 200) : null;
    const na6fenster = await cdp.evaluate<boolean>(`return Boolean(document.querySelector(".modal.pseu-review-modal"));`);
    const na6platte = await cdp.evaluate<string | null>(PLATTE_TEXT(MAILNOTIZ));
    record("NA6 Eine Notiz mit mail_id bleibt unberührt, es öffnet kein Prüffenster, die Notice verweist auf mailstone",
      na6notice !== null && !na6fenster && na6platte === NA_MAIL,
      `Notice=${q(na6notice)}, Prüffenster offen=${na6fenster}, Notiz gleich=${na6platte === NA_MAIL}`);
    await clearNotices(cdp);
    await cdp.evaluate(SCHLIESSE_NOTIZEN);

    // NA7 (Sicherheits-Lesung Runde 1, B1; Quelle seit Runde 2, N3): Eigenschaften, deren Wert der Kit-Leser nicht ganz liest, bleiben unberührt. Im Lauf vom 2026-11-19 mit dem `metadataCache` gemessen; seit N3 liest das Plugin
    // `parseYaml` auf dem Block des gelesenen Texts, der Punkt misst jetzt dieselbe Quelle (Block aus der Datei, `require("obsidian").parseYaml` im Fenster). Umgestellt, noch nicht wieder gelaufen.
    // Gemessen wird die Annahme, auf der der Schutz ruht: `parseYaml` liefert für einen flachen Wert denselben Text wie der Kit-Leser, für die drei Formen etwas anderes.
    const NA7 = "Smoke-Eigenschaften.md";
    const NA7_NOTIZ = [
      "---", "from: Berta Beispiel <berta@example.org>", "title: Berta Beispiel", "  und Erika Musterfrau", "people:", "  - name: Berta Beispiel", "    role: Kassenwart", "  - Erika",
      "author: Berta Beispiel # Chefin", "---", "Hallo Berta Beispiel, schreib an berta@example.org.", "",
    ].join("\n");
    await cdp.evaluate(LEGE_NOTIZ_AN(NA7, NA7_NOTIZ));
    const na7offen = await oeffneNotiz(cdp, NA7, "preview", 0);
    const na7cache = na7offen ? await pollUntil<{ from: unknown; title: unknown; people: unknown; author: unknown }>(cdp, `
      const f = app.vault.getAbstractFileByPath(${q(NA7)}); if (!f) return null;
      const m = /^---\n([\s\S]*?)\n---\n/.exec(await app.vault.read(f)); if (!m) return null;
      const y = require("obsidian").parseYaml(m[1]);
      return y ? { from: y.from, title: y.title, people: y.people, author: y.author } : null;
    `, 8000, 200) : null;
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:pseudonymize-note`)}); return true;`);
    // Nach NA3 kennt die Tabelle Berta und ihre Adresse: gibt es nichts Neues zu fragen, schreibt der Befehl ohne Prüffenster; kommt eines, wird es bestätigt.
    const na7fenster = na7offen ? await pollUntil<boolean>(cdp, `return document.querySelector(".modal.pseu-review-modal") ? true : null;`, 4000, 250) : null;
    const na7apply = na7fenster ? await clickReal(cdp, LETZTER_KNOPF) : false;
    const na7text = na7offen ? await pollUntil<string>(cdp, PLATTE_GEAENDERT(NA7, "Hallo Berta Beispiel, schreib"), 10_000, 250) : null;
    const na7notice = na7text !== null ? await pollUntil<string>(cdp, NOTICE_MIT("left unchanged"), 5000, 200) : null;
    const na7zeilen = ["title: Berta Beispiel", "  und Erika Musterfrau", "people:", "  - name: Berta Beispiel", "    role: Kassenwart", "  - Erika", "author: Berta Beispiel # Chefin"];
    const na7behalten = na7text !== null && na7zeilen.every((z) => (na7text as string).split("\n").includes(z));
    record("NA7 Eigenschaften, die der Kit-Leser nicht ganz liest (Fortsetzungszeile, Liste von Abbildungen, Kommentar im Wert): parseYaml auf dem Block liefert für die flachen Werte genau den gelesenen Wert und für die anderen etwas anderes, der Befehl lässt diese byte-gleich und meldet ihre Namen, Frontmatter-Zeilen gehen nicht verloren, der Rest wird pseudonymisiert",
      Boolean(na7cache) && na7cache!.from === "Berta Beispiel <berta@example.org>" && na7cache!.title !== "Berta Beispiel" && JSON.stringify(na7cache!.people) !== JSON.stringify(["Berta Beispiel", "Erika"])
        && na7cache!.author !== "Berta Beispiel # Chefin" && na7text !== null && na7behalten && !/^from: Berta/m.test(na7text as string) && !/\nHallo Berta Beispiel/.test(na7text as string)
        && na7notice !== null && /title/.test(na7notice) && /people/.test(na7notice) && !/Berta|Erika/.test(na7notice),
      `Cache=${q(na7cache)}, Prüffenster=${Boolean(na7fenster)}, Notiz danach=${q(na7text)}, Notice=${q(na7notice)}`);
    await clearNotices(cdp);
    await cdp.evaluate(SCHLIESSE_NOTIZEN);
    await cdp.evaluate(LOESCHE_SMOKE_NOTIZEN);

    // --- AP ---
    // Geschrieben, noch nicht gelaufen (Rechner unter Last). Der Treiber legt eine zweite fremde Gerätedatei mit Anna und Anton Probe an (erfunden), arbeitet im Reiter und nimmt die Datei am Ende wieder weg,
    // damit der Punkt D die Geräteliste vorfindet wie bisher. Die Eingaben im Suchfeld und im Ausnahme-Dialog sind echte (`Input.insertText`), die Klicks echte Mausklicks.
    console.log("\nAP · Personen und Ausnahmen");
    await setWindowSize(cdp, 1200, 800);
    const PANEL = (n: number): string => `document.querySelectorAll(".pseu-root .pseu-panel")[${n}]`;
    // Der Befehl `open-view` stellt die Ansicht (asynchron) auf den ersten Reiter zurück; ein `showTab` davor geht verloren (gemessen im Lauf 3: Ausnahmen und Geräte blieben unsichtbar, `clickReal` fand die Fläche 0×0). Deshalb erst warten, dann wählen.
    const ZEIGE_REITER = (id: string): string => `app.commands.executeCommandById(${q(`${PLUGIN_ID}:open-view`)}); await new Promise((r) => setTimeout(r, 600)); const l = app.workspace.getLeavesOfType("pseudonymizer-view")[0]; if (l && l.view.showTab) l.view.showTab(${q(id)}); await new Promise((r) => setTimeout(r, 300)); return true;`;
    interface PersonenListe { items: { label: string; meta: string; expanded: string | null }[]; count: string; leer: string }
    const PERS_LISTE = `
      const p = ${PANEL(0)}; if (!p) return null;
      const items = Array.from(p.querySelectorAll(".pseu-person")).map((li) => ({ label: li.querySelector(".pseu-person-label").textContent.trim(), meta: li.querySelector(".pseu-person-meta").textContent.trim(), expanded: li.querySelector(".pseu-person-head").getAttribute("aria-expanded") }));
      const c = p.querySelector(".pseu-persons-count"); const e = p.querySelector(".pseu-empty");
      return { items, count: c ? c.textContent.trim() : "", leer: e ? e.textContent.trim() : "" };
    `;
    const KOPF = (label: string): string => `(Array.from(${PANEL(0)}.querySelectorAll(".pseu-person")).find((li) => li.querySelector(".pseu-person-label").textContent.trim() === ${q(label)})?.querySelector(".pseu-person-head") || null)`;
    const OFFEN = `(${PANEL(0)}.querySelector(".pseu-person.is-open") || null)`;
    const sucheNach = async (text: string): Promise<PersonenListe | null> => {
      await cdp.evaluate(`const i = ${PANEL(0)}.querySelector(".pseu-search"); i.focus(); i.select(); return true;`);
      if (text === "") await cdp.evaluate(`const i = ${PANEL(0)}.querySelector(".pseu-search"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return true;`);
      else await cdp.send("Input.insertText", { text });
      await new Promise((r) => setTimeout(r, 300));
      return cdp.evaluate<PersonenListe | null>(PERS_LISTE);
    };
    const labelsVon = (l: PersonenListe | null): string => (l ? l.items.map((x) => x.label).join("|") : "<keine Liste>");
    const ansichtDir = mkdtempSync(join(tmpdir(), "pseu-ansicht-"));

    const keyAP = await leseSchluessel(cdp);
    const fremd2 = keyAP ? await schreibeFremdeFassung(info.basePath, keyAP, PERSONEN2, { geraet: GERAET2, name: "iPad (Treiber)" }) : null;
    const gelesen2 = fremd2 ? await pollUntil<boolean>(cdp, `const p = ${P}; const r = p ? p.api.restore(${q(`Hallo ${ANNA_PLATZHALTER}`)}, { caller: "gui-smoke" }) : null; return r && r.text === "Hallo Anna Probe" ? true : null;`, 30_000, 500) : null;
    await cdp.evaluate(ZEIGE_REITER("persons"));
    const persListeBereit = gelesen2 ? await pollUntil<PersonenListe>(cdp, `const l = (() => { ${PERS_LISTE} })(); return l && l.items.some((x) => x.label === "Anna Probe") ? l : null;`, 15_000, 300) : null;

    // AP1: Suche über alle Formen mit echter Eingabe
    const sAlle = persListeBereit;
    const sMail = persListeBereit ? await sucheNach("ANNA@EXAMPLE.ORG") : null;
    const sTel = persListeBereit ? await sucheNach("+49 30 5550101") : null;
    const sTeil = persListeBereit ? await sucheNach("probe") : null;
    const sAnton = persListeBereit ? await sucheNach("Anton") : null;
    const sNichts = persListeBereit ? await sucheNach("gibt es nicht") : null;
    const sLeer = persListeBereit ? await sucheNach("") : null;
    record("AP1 Reiter Personen: die Suche (echte Eingabe) findet über Mail, Telefon in anderer Schreibweise, Namensteil und Großschreibung; ein Treffer ohne Ergebnis sagt es in Worten",
      Boolean(sAlle) && labelsVon(sMail) === "Anna Probe" && labelsVon(sTel) === "Anna Probe" && Boolean(sTeil) && sTeil!.items.some((x) => x.label === "Anna Probe") && sTeil!.items.some((x) => x.label === "Anton Probe")
        && labelsVon(sAnton) === "Anton Probe" && sNichts !== null && sNichts.items.length === 0 && sNichts.leer === "Nothing matches this search." && sLeer !== null && sLeer.items.length >= 2 && /^\d+ of \d+ entries$/.test(sLeer.count),
      `Mail=${labelsVon(sMail)}, Telefon=${labelsVon(sTel)}, „probe“=${labelsVon(sTeil)}, „Anton“=${labelsVon(sAnton)}, ohne Treffer=${q(sNichts ? sNichts.leer : null)}, leere Suche=${sLeer ? sLeer.items.length : null} Einträge (${q(sLeer?.count)})`);

    // AP2: Detail
    const kopfAnna = persListeBereit ? await clickReal(cdp, KOPF("Anna Probe")) : false;
    const detail = kopfAnna ? await pollUntil<{ forms: { feld: string; text: string; platzhalter: string; abhaengen: boolean }[]; knoepfe: { text: string; warnung: boolean }[]; expanded: string | null; labels: string[] }>(cdp, `
      const li = ${OFFEN}; if (!li) return null;
      const forms = Array.from(li.querySelectorAll(".pseu-form")).map((f) => ({ feld: f.querySelector(".pseu-form-field").textContent.trim(), text: f.querySelector(".pseu-form-text").textContent.trim(), platzhalter: f.querySelector(".pseu-form-placeholder").textContent.trim(), abhaengen: Boolean(f.querySelector(".pseu-form-detach")) }));
      const knoepfe = Array.from(li.querySelectorAll(".pseu-person-actions button")).map((b) => ({ text: b.textContent.trim(), warnung: b.classList.contains("mod-warning") }));
      const labels = Array.from(li.querySelectorAll("button")).map((b) => b.getAttribute("aria-label")).filter(Boolean);
      return { forms, knoepfe, expanded: li.querySelector(".pseu-person-head").getAttribute("aria-expanded"), labels };
    `, 8000, 250) : null;
    const form = (platzhalter: string) => detail?.forms.find((f) => f.platzhalter === platzhalter);
    record("AP2 Reiter Personen, Detail: ein Eintrag klappt auf (aria-expanded), zeigt jeden Wert mit Feld, Klartext und Platzhalter, je Wert „Wert abhängen“, darunter Zusammenführen und Vergessen (mod-warning); kein Klartext in einem aria-label",
      Boolean(detail) && detail!.expanded === "true" && detail!.forms.length === 3
        && form(ANNA_PLATZHALTER)?.text === "Anna Probe" && form(ANNA_PLATZHALTER)?.feld === "Name" && form(`${ANNA_PLATZHALTER}_Mail`)?.text === "anna@example.org" && form(`${ANNA_PLATZHALTER}_Mail`)?.feld === "Mail"
        && form(`${ANNA_PLATZHALTER}_Phone`)?.text === "030 5550101" && detail!.forms.every((f) => f.abhaengen)
        && detail!.knoepfe.map((b) => b.text).join("|") === "Merge with another entry|Forget" && detail!.knoepfe[1]!.warnung && !detail!.knoepfe[0]!.warnung
        && detail!.labels.length === 3 && detail!.labels.every((l) => l.includes("Person_") && !/Anna|anna@|5550101/.test(l)),
      `Detail=${q(detail ? { forms: detail.forms.map((f) => [f.feld, f.platzhalter]), knoepfe: detail.knoepfe, expanded: detail.expanded, labels: detail.labels } : null)}`);
    // Bild und Tippflächen (AP7) im Zustand „Anna aufgeklappt“
    let bildPersonen = "";
    let bildAusnahmen = "";
    let flaechen: number[] = [];
    if (detail) {
      const box = await boxOf(cdp, ".pseu-root", 8);
      bildPersonen = join(ansichtDir, "personen-desktop.png");
      writeFileSync(bildPersonen, await capture(cdp, box ?? undefined, 1));
      await cdp.evaluate(`document.body.classList.add("is-mobile"); return true;`);
      await setWindowSize(cdp, 402, 874);
      flaechen = await pollUntil<number[]>(cdp, `
        const li = ${OFFEN}; if (!li) return null;
        const hs = [li.querySelector(".pseu-person-head"), ...li.querySelectorAll(".pseu-person-actions button"), ...li.querySelectorAll(".pseu-form-detach")].filter(Boolean);
        const sf = ${PANEL(0)}.querySelector(".pseu-search");
        return [...hs, sf].map((e) => Math.round(e.getBoundingClientRect().height));
      `, 8000, 250) ?? [];
      await cdp.evaluate(`document.body.classList.remove("is-mobile"); return true;`);
      await setWindowSize(cdp, 1200, 800);
    }

    // AP3: zusammenführen
    const vorAP3 = await leseSchluessel(cdp);
    const mergeKlick = detail ? await clickReal(cdp, `(${OFFEN}.querySelector(".pseu-person-merge") || null)`) : false;
    const wahl = mergeKlick ? await pollUntil<boolean>(cdp, `return Array.from(document.querySelectorAll(".prompt .suggestion-item")).some((e) => e.textContent.includes("Anton Probe")) ? true : null;`, 8000, 200) : null;
    const antonWahl = wahl ? await clickReal(cdp, `(Array.from(document.querySelectorAll(".prompt .suggestion-item")).find((e) => e.textContent.includes("Anton Probe")) || null)`) : false;
    const mergeFrage = antonWahl ? await pollUntil<{ titel: string; text: string; cta: boolean; zerstoerend: boolean }>(cdp, `
      const m = document.querySelector(".modal"); if (!m) return null;
      const b = Array.from(m.querySelectorAll("button")).find((x) => x.textContent.trim() === "Merge");
      const t = m.querySelector(".modal-title");
      return b ? { titel: t ? t.textContent.trim() : "", text: m.textContent, cta: b.classList.contains("mod-cta"), zerstoerend: ${istZerstoerendJs("b")} } : null;
    `, 8000, 250) : null;
    const mergeOk = mergeFrage ? await klickeKnopf(cdp, "Merge") : false;
    const mergeNotice = mergeOk ? await pollUntil<string>(cdp, NOTICE_MIT("Merged"), 10_000, 200) : null;
    const nachMerge = mergeNotice ? await restoreVon(`${ANTON_PLATZHALTER} und ${ANNA_PLATZHALTER}_Mail`) : null;
    const mergeListe = mergeNotice ? await pollUntil<PersonenListe & { hinweis: string }>(cdp, `
      const l = (() => { ${PERS_LISTE} })(); const li = ${OFFEN}; const n = li ? li.querySelector(".pseu-person-detail > .pseu-note") : null;
      return l && l.items.filter((x) => /^(Anna|Anton) Probe$/.test(x.label)).length === 1 && n ? { ...l, hinweis: n.textContent.trim() } : null;
    `, 10_000, 300) : null;
    const dateiAP3 = vorAP3 && eigeneId ? await oeffneEigeneDatei(info.basePath, eigeneId, vorAP3) : null;
    record("AP3 Zusammenführen aus dem Reiter: Partnerwahl, Bestätigung (nicht zerstörend), danach lösen beide Platzhalter-IDs weiter auf, die Ansicht zeigt einen Eintrag mit dem Hinweis auf beide Kennungen, die Gerätedatei auf der Platte trägt beide Namen",
      Boolean(wahl) && antonWahl && Boolean(mergeFrage) && mergeFrage!.titel === "Merge two entries?" && mergeFrage!.cta && !mergeFrage!.zerstoerend && /Both identifiers keep resolving/.test(mergeFrage!.text)
        && mergeOk && mergeNotice !== null && !/Anna|Anton|example/.test(mergeNotice) && nachMerge !== null && nachMerge.text === "Anton Probe und anna@example.org"
        && Boolean(mergeListe) && /2 identifiers/.test(mergeListe!.hinweis) && dateiAP3 !== null && dateiAP3.tabelle.includes("Anton Probe") && dateiAP3.tabelle.includes("Anna Probe"),
      `Wahl=${Boolean(wahl)}, Dialog=${q(mergeFrage ? { titel: mergeFrage.titel, cta: mergeFrage.cta, zerstoerend: mergeFrage.zerstoerend } : null)}, Notice=${q(mergeNotice)}, restore=${q(nachMerge?.text ?? nachMerge)}, Ansicht=${q(mergeListe ? { eintraege: mergeListe.items.length, hinweis: mergeListe.hinweis } : null)}, Datei trägt beide Namen=${dateiAP3 !== null && dateiAP3.tabelle.includes("Anton Probe") && dateiAP3.tabelle.includes("Anna Probe")}`);
    await clearNotices(cdp);

    // AP4: Wert abhängen (die Mail von Anna)
    const mailKnopf = `(document.querySelector('.pseu-root button[aria-label=${q(`Detach the value of ${ANNA_PLATZHALTER}_Mail`)}]') || null)`;
    const abKlick = mergeListe ? await clickReal(cdp, mailKnopf) : false;
    const abFrage = abKlick ? await pollUntil<{ titel: string; text: string; zerstoerend: boolean }>(cdp, `
      const m = document.querySelector(".modal"); if (!m) return null;
      const b = Array.from(m.querySelectorAll("button")).find((x) => x.textContent.trim() === "Detach");
      const t = m.querySelector(".modal-title");
      return b ? { titel: t ? t.textContent.trim() : "", text: m.textContent, zerstoerend: ${istZerstoerendJs("b")} } : null;
    `, 8000, 250) : null;
    const abOk = abFrage ? await klickeKnopf(cdp, "Detach") : false;
    const abNotice = abOk ? await pollUntil<string>(cdp, NOTICE_MIT("Detached"), 10_000, 200) : null;
    const nachAb = abNotice ? await restoreVon(`${ANNA_PLATZHALTER}_Mail`) : null;
    const abListe = abNotice ? await pollUntil<{ liste: PersonenListe; formen: string[] }>(cdp, `
      const l = (() => { ${PERS_LISTE} })(); const li = ${OFFEN};
      if (!l || !li) return null;
      const formen = Array.from(li.querySelectorAll(".pseu-form-placeholder")).map((e) => e.textContent.trim());
      return formen.length === 3 && !formen.includes(${q(`${ANNA_PLATZHALTER}_Mail`)}) && l.items.some((x) => x.label === "anna@example.org") ? { liste: l, formen } : null;
    `, 10_000, 300) : null;
    record("AP4 Wert abhängen aus dem Reiter: Bestätigung, der alte Platzhalter löst weiter auf, der Wert ist ein eigener Eintrag ohne Träger und steht nicht mehr beim alten Eintrag",
      Boolean(abFrage) && abFrage!.titel === "Detach this value?" && !abFrage!.zerstoerend && abFrage!.text.includes(`${ANNA_PLATZHALTER}_Mail`) && /still carries the old identifier/.test(abFrage!.text)
        && abOk && abNotice !== null && !/anna@|Anna/.test(abNotice) && nachAb !== null && nachAb.text === "anna@example.org" && Boolean(abListe)
        && abListe!.liste.items.find((x) => x.label === "anna@example.org")!.meta.startsWith("No carrier"),
      `Dialog=${q(abFrage ? { titel: abFrage.titel, zerstoerend: abFrage.zerstoerend } : null)}, Notice=${q(abNotice)}, restore=${q(nachAb?.text ?? nachAb)}, Formen beim alten Eintrag=${q(abListe?.formen)}, neuer Eintrag=${q(abListe?.liste.items.find((x) => x.label === "anna@example.org")?.meta)}`);
    await clearNotices(cdp);

    // AP5: Vergessen aus dem Reiter
    const vorAP5 = await leseSchluessel(cdp);
    const vergKlick = abListe ? await clickReal(cdp, `(${OFFEN}.querySelector(".pseu-person-forget") || null)`) : false;
    const vergFrage = vergKlick ? await pollUntil<{ titel: string; text: string; zerstoerend: boolean; wahl: boolean }>(cdp, `
      const m = document.querySelector(".modal"); if (!m) return null;
      const b = Array.from(m.querySelectorAll("button")).find((x) => x.textContent.trim() === "Forget for good");
      const t = m.querySelector(".modal-title");
      return b ? { titel: t ? t.textContent.trim() : "", text: m.textContent, zerstoerend: ${istZerstoerendJs("b")}, wahl: Boolean(document.querySelector(".prompt")) } : null;
    `, 8000, 250) : null;
    const vergOk = vergFrage ? await klickeKnopf(cdp, "Forget for good") : false;
    const nachVerg = vergOk ? await pollUntil<{ text: string; forgotten: string[] }>(cdp, `
      const pl = ${P}; const r = pl ? pl.api.restore(${q(`${ANNA_PLATZHALTER} ${ANTON_PLATZHALTER} ${ANNA_PLATZHALTER}_Mail`)}, { caller: "gui-smoke" }) : null;
      return r && Array.isArray(r.forgotten) && r.forgotten.length > 0 ? { text: r.text, forgotten: r.forgotten } : null;
    `, 15_000, 250) : null;
    const nachAP5 = await leseSchluessel(cdp);
    const dateiAP5 = nachAP5 && eigeneId ? await oeffneEigeneDatei(info.basePath, eigeneId, nachAP5) : null;
    const dateiOhne = dateiAP5 !== null && dateiAP5.tabelle !== "" && dateiAP5.tabelle.includes("anna@example.org") && !/Anna Probe|Anton Probe|5550101/.test(dateiAP5.tabelle);
    record("AP5 Vergessen aus dem Reiter: derselbe Warndialog wie der Befehl, ohne Personenwahl; der abgehängte Wert fehlt in der Liste der Werte und bleibt nach dem Vergessen lesbar, die zusammengeführten IDs sind beide vergessen, die Gerätedatei trägt nur noch den abgehängten Wert",
      Boolean(vergFrage) && vergFrage!.titel === 'Forget "Anna Probe"?' && vergFrage!.zerstoerend && !vergFrage!.wahl && vergFrage!.text.includes("5550101") && vergFrage!.text.includes(`${ANNA_PLATZHALTER}_Phone`)
        && !vergFrage!.text.includes("anna@example.org") && /only when the version of every device carries the mark/.test(vergFrage!.text)
        && vergOk && Boolean(nachVerg) && nachVerg!.text === `${ANNA_PLATZHALTER} ${ANTON_PLATZHALTER} anna@example.org` && nachVerg!.forgotten.includes(ANNA_PLATZHALTER) && nachVerg!.forgotten.includes(ANTON_PLATZHALTER)
        && vorAP5 !== null && nachAP5 !== null && nachAP5.stand === vorAP5.stand + 1 && dateiOhne,
      `Dialog=${q(vergFrage ? { titel: vergFrage.titel, zerstoerend: vergFrage.zerstoerend, personenwahl: vergFrage.wahl, nenntMail: vergFrage.text.includes("anna@example.org") } : null)}, restore=${q(nachVerg)}, Stand ${vorAP5?.stand ?? null} -> ${nachAP5?.stand ?? null}, Datei ohne Namen und Telefon, mit der abgehängten Mail=${dateiOhne}`);
    await clearNotices(cdp);
    // Die zweite fremde Datei verschwindet wieder (sie ist nach dem Vergessen ohnehin unlesbar), damit D die Geräteliste vorfindet wie bisher.
    rmSync(join(info.basePath, ORDNER, `${GERAET2}.pseudo`), { force: true });

    // AP6: Ausnahmen
    await cdp.evaluate(ZEIGE_REITER("exceptions"));
    const ausLeer = await pollUntil<{ text: string; knopf: string; cta: boolean }>(cdp, `
      const p = ${PANEL(1)}; const e = p ? p.querySelector(".pseu-empty") : null; const b = e ? e.querySelector("button") : null;
      return b ? { text: e.textContent, knopf: b.textContent.trim(), cta: b.classList.contains("mod-cta") } : null;
    `, 8000, 250);
    const addKlick = ausLeer ? await clickReal(cdp, `(${PANEL(1)}.querySelector(".pseu-exception-add") || null)`) : false;
    const ausDialog = addKlick ? await pollUntil<string>(cdp, `const t = document.querySelector(".modal .modal-title"); return t && t.textContent.trim() === "Add an exception" && document.querySelector(".modal input") ? t.textContent.trim() : null;`, 8000, 200) : null;
    if (ausDialog) {
      await cdp.evaluate(`const i = document.querySelector(".modal input"); i.focus(); i.select(); return true;`);
      await cdp.send("Input.insertText", { text: "Beispiel GmbH" });
    }
    const addOk = ausDialog ? await klickeKnopf(cdp, "Add") : false;
    const addNotice = addOk ? await pollUntil<string>(cdp, NOTICE_MIT("Added to the exceptions"), 10_000, 200) : null;
    const ausListe = addNotice ? await pollUntil<string[]>(cdp, `const e = Array.from(${PANEL(1)}.querySelectorAll(".pseu-exception-text")).map((x) => x.textContent.trim()); return e.length ? e : null;`, 8000, 250) : null;
    const dataJson = join(info.basePath, info.configDir, "plugins", PLUGIN_ID, "data.json");
    const dataJsonOhne = (): boolean => !existsSync(dataJson) || !/Beispiel/.test(readFileSync(dataJson, "utf8"));
    const dateiAus = nachAP5 && eigeneId ? await oeffneEigeneDatei(info.basePath, eigeneId, nachAP5) : null;
    if (ausListe) {
      const box = await boxOf(cdp, ".pseu-root", 8);
      bildAusnahmen = join(ansichtDir, "ausnahmen-desktop.png");
      writeFileSync(bildAusnahmen, await capture(cdp, box ?? undefined, 1));
    }
    const entfKlick = ausListe ? await clickReal(cdp, `(${PANEL(1)}.querySelector(".pseu-exception-remove") || null)`) : false;
    const entfNotice = entfKlick ? await pollUntil<string>(cdp, NOTICE_MIT("Removed from the exceptions"), 10_000, 200) : null;
    const ausWieder = entfNotice ? await pollUntil<boolean>(cdp, `const p = ${PANEL(1)}; return p && p.querySelector(".pseu-empty") && !p.querySelector(".pseu-exception") ? true : null;`, 8000, 250) : null;
    record("AP6 Reiter Ausnahmen: Leerzustand mit „Ausnahme hinzufügen“, Eingabe im Dialog, die Liste zeigt den Text, die Gerätedatei trägt ihn und data.json nicht; Entfernen leert die Liste wieder",
      Boolean(ausLeer) && ausLeer!.knopf === "Add exception" && ausLeer!.cta && /No exceptions yet/.test(ausLeer!.text) && Boolean(ausDialog) && addOk && addNotice !== null && !/Beispiel/.test(addNotice)
        && ausListe !== null && ausListe.join("|") === "Beispiel GmbH" && dateiAus !== null && dateiAus.tabelle.includes("Beispiel GmbH") && dataJsonOhne()
        && entfKlick && entfNotice !== null && Boolean(ausWieder),
      `Leerzustand=${q(ausLeer ? { knopf: ausLeer.knopf, cta: ausLeer.cta } : null)}, Dialog=${q(ausDialog)}, Notice=${q(addNotice)}, Liste=${q(ausListe)}, Gerätedatei trägt es=${dateiAus !== null && dateiAus.tabelle.includes("Beispiel GmbH")}, data.json ohne Text=${dataJsonOhne()}, entfernt=${q(entfNotice)}, wieder leer=${Boolean(ausWieder)}`);
    await clearNotices(cdp);

    // AP7: Bilder und Tippflächen
    const groesse = (pfad: string): number => (pfad !== "" && existsSync(pfad) ? statSync(pfad).size : 0);
    record("AP7 Bilder der Reiter Personen und Ausnahmen (Desktop) und Tippflächen von mindestens 44 px am Telefon (nachgestellt über die Körperklasse is-mobile); die Bilder sind selbst anzusehen",
      groesse(bildPersonen) > 5000 && groesse(bildAusnahmen) > 5000 && flaechen.length >= 4 && flaechen.every((h) => h >= 44),
      `Personen=${bildPersonen} (${groesse(bildPersonen)} B), Ausnahmen=${bildAusnahmen} (${groesse(bildAusnahmen)} B), Höhen am Telefon (Kopf, Zusammenführen, Vergessen, Wert abhängen ×3, Suchfeld)=${q(flaechen)} (nachgestellt, kein echtes Telefon)`);
    await cdp.evaluate(ZEIGE_REITER("devices"));

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
