/**
 * GUI-Smoke — fährt die Prüfpunkte aus docs/SMOKE.md gegen ein LAUFENDES Obsidian (CORE-TEST-02 b).
 * Stand: Aufgabe 12 Teil b. Der Treiber misst, was das Plugin von außen zeigt (Befehle, API, Ansicht, Statusleiste) und, seit Aufgabe 11/12,
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
  "Q Ziehen markierten Texts aus der Lesesicht (echter Mauszug, Input.setInterceptDrags): der Zug trägt in der Vorgabe den Platzhalter, nie den Klartext",
  "P PDF-Export (Speicherdialog im Renderer ersetzt): mit „Klartext zeigen“ trägt das PDF den Klartext und nicht den Platzhalter, ohne den Platzhalter und nicht den Klartext",
  "Z Person vergessen: Wahl, Warndialog mit Werten und Grenzen, danach nennt restore den Platzhalter in forgotten, Stand n+1, die Gerätedatei auf der Platte trägt keinen Klartext der Person",
  "J Vergessen in der offenen Lesesicht: die Stellen der vergessenen Person schalten ohne Neuöffnen auf „vergessen“ (Klasse, Tooltip, kein Klartext im DOM), die der anderen Person bleiben lesbar",
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
async function oeffneNotiz(cdp: Cdp, pfad: string, modus: "preview" | "source", ersatzStellen: number): Promise<boolean> {
  await cdp.evaluate(`
    const f = app.vault.getAbstractFileByPath(${q(pfad)});
    if (!f) return false;
    const leaf = app.workspace.getLeaf("tab");
    await leaf.openFile(f, { state: { mode: ${q(modus)} } });
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
  const c = ${WURZEL(pfad)};
  if (!c) return null;
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

/** Ein echter Mauszug über die Auswahl (Input.setInterceptDrags): liefert die Daten, die der Zug trägt, oder `null`, wenn kein Zug abgefangen wurde. */
async function messeZiehen(cdp: Cdp, pfad: string): Promise<{ items: { mimeType: string; data: string }[] } | null> {
  let items: { mimeType: string; data: string }[] | null = null;
  cdp.on("Input.dragIntercepted", (params) => {
    const d = (params as { data?: { items?: { mimeType: string; data: string }[] } }).data;
    items = d?.items ?? [];
  });
  const box = await cdp.evaluate<{ x: number; y: number } | null>(`
    app.workspace.setActiveLeaf(${BLATT(pfad)}, { focus: true });
    const p = ${WURZEL(pfad)}.querySelectorAll("p")[0];
    p.scrollIntoView({ block: "center" });
    const r = document.createRange(); r.selectNodeContents(p);
    const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    const b = p.querySelector(".okit-swap").getBoundingClientRect();
    return b.width === 0 ? null : { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  `);
  if (!box) return null;
  try {
    await cdp.send("Input.setInterceptDrags", { enabled: true });
    const c = { x: box.x, y: box.y, button: "left", clickCount: 1 };
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...c, buttons: 0 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...c, buttons: 1 });
    for (let i = 1; i <= 6 && items === null; i++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...c, x: box.x + i * 8, y: box.y + i * 3, buttons: 1 });
      await new Promise((r) => setTimeout(r, 120));
    }
    for (let i = 0; i < 20 && items === null; i++) await new Promise((r) => setTimeout(r, 150));
    // Der abgefangene Zug wird abgebrochen, nichts wird fallen gelassen.
    await cdp.send("Input.dispatchDragEvent", { type: "dragCancel", x: box.x, y: box.y, data: { items: [], dragOperationsMask: 1 } });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...c, x: box.x, y: box.y, buttons: 0 });
  } finally {
    await cdp.send("Input.setInterceptDrags", { enabled: false });
  }
  return items === null ? null : { items };
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
  const dialog = await pollUntil<boolean>(cdp, `return (${MODAL_BTN("Export")}) ? true : null;`, 8000, 250);
  if (!dialog) return { ok: false, grund: "der Export-Dialog kam nicht" };
  if (!(await klickeKnopf(cdp, "Export"))) return { ok: false, grund: "Export nicht anklickbar" };
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
      // Aufgabe 16: Notizen und Popout-Fenster des Treibers zu, Schalter und Einstellung zurück, Zwischenablage und Speicherdialog wiederherstellen, Netzmitschnitt aus.
      await cdp.evaluate(SCHLIESSE_NOTIZEN);
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
      const a = c.querySelector("a.external-link, a[href^='http']");
      const img = c.querySelector("img");
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
    record("Q Ziehen markierten Texts aus der Lesesicht (echter Mauszug, Input.setInterceptDrags): der Zug trägt in der Vorgabe den Platzhalter, nie den Klartext",
      zug !== null && zugText !== null && zugText.includes(MAX) && !zug.items.some((i) => KLARTEXT.test(i.data)),
      `Zug abgefangen=${zug !== null}, Daten=${q(zug ? zug.items.map((i) => ({ art: i.mimeType, anfang: i.data.slice(0, 60) })) : null)}${zug !== null && zug.items.some((i) => KLARTEXT.test(i.data)) ? " — KLARTEXT IM ZUG: Grenze für die README" : ""}`);
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
    const nachVergessen = lesenOffen ? await pollUntil<Lesestand>(cdp, `
      const st = (() => { ${LESESTAND(NOTIZ_LESEN)} })();
      if (!st) return null;
      const max = st.stellen.filter((x) => x.raw.toLowerCase().startsWith(${q(MAX.toLowerCase())}));
      return max.length >= 7 && max.every((x) => x.forgotten) ? st : null;
    `, 20_000, 300) : null;
    const maxStellen = nachVergessen ? nachVergessen.stellen.filter((x) => x.raw.toLowerCase().startsWith(MAX.toLowerCase())) : [];
    const bertaStelle = nachVergessen ? nachVergessen.stellen.filter((x) => x.raw === `Person_${FREMD2_ID}`) : [];
    record("J Vergessen in der offenen Lesesicht: die Stellen der vergessenen Person schalten ohne Neuöffnen auf „vergessen“ (Klasse, Tooltip, kein Klartext im DOM), die der anderen Person bleiben lesbar",
      Boolean(nachVergessen) && maxStellen.length >= 7 && maxStellen.every((x) => x.text === x.raw && /forgotten/.test(x.title) && x.linie === "double")
        && !KLARTEXT_MAX.test(nachVergessen!.html) && nachVergessen!.klartextInAttribut === 0
        && bertaStelle.length === 1 && bertaStelle[0]!.shown && bertaStelle[0]!.text === "Berta Beispiel",
      `Stellen der vergessenen Person=${maxStellen.length} (alle vergessen=${maxStellen.every((x) => x.forgotten)}), Klartext von Max im DOM=${nachVergessen ? KLARTEXT_MAX.test(nachVergessen.html) : null}, Berta=${q(bertaStelle.map((x) => x.text))}`);
    await cdp.evaluate(`const l = ${BLATT(NOTIZ_LESEN)}; if (l) l.detach(); return true;`);
    await cdp.send("Network.disable");

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
