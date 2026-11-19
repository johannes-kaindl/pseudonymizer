/**
 * Aufnahme-Treiber für die README-Bilder: fährt den Vertrag aus `docs/images/README.md` gegen eine LAUFENDE Zweitinstanz
 * (eigenes Profil, eigener Port; `--port` ist Pflicht, die reguläre Instanz wird nie angefasst).
 *
 * Ablauf in einem Aufruf (Rezept und Lock: `tools/obsidian-cdp/messlauf.sh` im Dach, `RUNNER=shots SETUP_BEFEHL='npm run shots -- --setup'`):
 * Staging-Vault aus `fixtures/vault/` bauen, Einrichten über die echte Oberfläche, eine fremde Gerätedatei mit zwei erfundenen Personen
 * (so entsteht die Tabelle, wie es der Sync täte), dann je Bild den Zustand herstellen und aufnehmen. Alle Werte sind erfunden.
 * Ein Lauf nimmt alle Bilder auf (ein Prozess, ein Profil); `--bilder <Ordner>` ersetzt `docs/images`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

import { parseArgs, runDriver } from "../../tools/obsidian-cdp/bilanz.js";
import { Cdp, attachTo, bereiteInstanzVor, clearNotices, clickReal, pollUntil, requireVisible } from "../../tools/obsidian-cdp/cdp.js";
import { boxOf, capture, quetschen, scaleTo, setWindowSize } from "../../tools/obsidian-cdp/shot.js";
import { buildVault, requireEigenerBuild, stagingVaultDir } from "../../tools/obsidian-cdp/vault.js";
import { encodePayload } from "../src/core/payload.js";
import { sealEnvelope } from "../src/vendor/kit/key-envelope.js";
import { encryptionKey, type ChainState } from "../src/vendor/kit/key-ratchet.js";
import { emptyTable, serializeTable, tableAddEntry, tableAddValue, type PlaceholderTable } from "../src/vendor/kit/placeholder-table.js";

const REPO_NAME = "pseudonymizer";
const PLUGIN_ID = "pseudonymizer";
const REPO_ROOT = cwd();
const FIXTURE_DIR = join(REPO_ROOT, "fixtures/vault");
const ORDNER = "_pseudonymizer";
const CAPTURE_WIDTH = 1200;
const THUMB_WIDTH = 380;
const NOTIZ = "Call notes.md";

const q = (s: unknown): string => JSON.stringify(s);
const P = `app.plugins.plugins[${q(PLUGIN_ID)}]`;

interface Person { id: string; name: string; mail?: string; telefon?: string }
/** Erfundene Personen der fremden Fassung; die Kennungen stehen in `fixtures/vault/notes/Call notes.md`. */
const PERSONEN: Person[] = [
  { id: "m4t8c6r2vp", name: "Max Mustermann", mail: "max@example.org", telefon: "030 1234567" },
  { id: "h7n2p5r8st", name: "Anna Probe", mail: "anna@example.org", telefon: "030 5550101" },
];
/** Text des Prüffensters: Erika Musterfrau ist der Tabelle unbekannt, deshalb bekommt sie eine Karte. */
const PRUEF_TEXT = "Hello Erika Musterfrau,\nPhone 030 7654321.\nHello Erika Musterfrau, see you soon.";

interface Bild { name: string; klasse: "hero" | "feature" | "detail"; run(cdp: Cdp): Promise<{ clip: Awaited<ReturnType<typeof boxOf>>; scale: number } | null> }

function tabelleVon(personen: readonly Person[]): PlaceholderTable | null {
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

/** Gerätedatei eines fremden Geräts in den Ordner schreiben, wie es der Sync täte (Kette und Stand des eigenen Schlüssels). */
async function schreibeFremdeFassung(basePath: string, k: { chainId: number[]; stand: number; key: number[] }): Promise<boolean> {
  const stand: ChainState = { chainId: Uint8Array.from(k.chainId), stand: k.stand, chainKey: Uint8Array.from(k.key) };
  const key = await encryptionKey(stand);
  const tabelle = tabelleVon(PERSONEN);
  if (!key.ok || tabelle === null) return false;
  const klar = encodePayload({ format: "pseudonymizer-device", version: 1, device: { name: "iPhone", codeShownAtStand: null }, vault: { language: "en" }, table: serializeTable(tabelle) });
  const sealed = await sealEnvelope(key.value, { deviceId: "shots-fremd1", chainId: stand.chainId, stand: stand.stand }, klar);
  if (!sealed.ok) return false;
  const ordner = join(basePath, ORDNER);
  mkdirSync(ordner, { recursive: true });
  writeFileSync(join(ordner, "shots-fremd1.pseudo"), sealed.bytes);
  return true;
}

const MODAL_BTN = (text: string): string => `(Array.from(document.querySelectorAll(".modal button")).find((b) => b.textContent.trim() === ${q(text)}) || null)`;
const ZEIGE_REITER = (id: string): string => `
  app.commands.executeCommandById(${q(`${PLUGIN_ID}:open-view`)});
  await new Promise((r) => setTimeout(r, 600));
  const l = app.workspace.getLeavesOfType("pseudonymizer-view")[0];
  if (l && l.view.showTab) l.view.showTab(${q(id)});
  await new Promise((r) => setTimeout(r, 400));
  return true;`;
const SCHLIESSE_ANSICHT = `for (const l of app.workspace.getLeavesOfType("pseudonymizer-view")) l.detach(); return true;`;
const SEITENLEISTEN_ZU = `app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse(); return true;`;

/** Einrichten über die echte Oberfläche (Befehl, Sprachwahl, Kontrollkästchen, Weiter); liefert, ob der Zustand `ready` erreicht ist. */
async function richteEin(cdp: Cdp): Promise<boolean> {
  await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:set-up`)}); return true;`);
  if (!(await pollUntil<boolean>(cdp, `return Boolean(document.querySelector(".modal"));`, 6000, 250))) return false;
  if (!(await clickReal(cdp, MODAL_BTN("Set up")))) return false;
  if (!(await pollUntil<boolean>(cdp, `return Boolean(document.querySelector(".modal .pseu-code"));`, 6000, 250))) return false;
  if (!(await clickReal(cdp, `document.querySelector(".modal .pseu-code-confirm input")`))) return false;
  if (!(await clickReal(cdp, MODAL_BTN("Continue")))) return false;
  return Boolean(await pollUntil<boolean>(cdp, `const p = ${P}; return Boolean(p) && p.api.status().state === "ready";`, 10_000, 250));
}

/** Ausschnitt der Ansicht bis zum Ende des Inhalts des gezeigten Reiters (nicht bis zum Fensterrand, wo Statusleiste und leere Fläche liegen). */
async function inhaltsClip(cdp: Cdp): Promise<Awaited<ReturnType<typeof boxOf>>> {
  const box = await boxOf(cdp, ".pseu-root", 0);
  if (!box) return null;
  const unten = await cdp.evaluate<number>(`
    const root = document.querySelector(".pseu-root");
    let max = 0;
    for (const e of root.querySelectorAll(".pseu-panel:not(.is-hidden) *")) {
      const r = e.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) max = Math.max(max, r.bottom);
    }
    return max;`);
  return unten > box.y ? { ...box, height: Math.min(box.height, unten - box.y + 12) } : box;
}

const bilder: Bild[] = [
  {
    // Quelltext mit Platzhaltern links, dieselbe Notiz in der Lesesicht mit eingeblendetem Klartext rechts.
    name: "hero.png", klasse: "hero",
    async run(cdp) {
      await setWindowSize(cdp, 1200, 640);
      await cdp.evaluate(SEITENLEISTEN_ZU);
      await cdp.evaluate(`app.vault.setConfig("showInlineTitle", false); return true;`);
      await cdp.evaluate(`
        const f = app.vault.getAbstractFileByPath(${q(NOTIZ)});
        const links = app.workspace.getLeaf(false);
        await links.openFile(f, { state: { mode: "source", source: true } });
        const rechts = app.workspace.getLeaf("split", "vertical");
        await rechts.openFile(f, { state: { mode: "preview" } });
        app.workspace.setActiveLeaf(rechts, { focus: true });
        return true;`);
      const ok = await pollUntil<boolean>(cdp, `
        const gezeigt = [...document.querySelectorAll(".markdown-preview-view .okit-swap.is-shown")].filter((e) => e.getBoundingClientRect().width > 1);
        const roh = [...document.querySelectorAll(".cm-content")].some((e) => e.getBoundingClientRect().width > 1 && e.textContent.includes("Person_m4t8c6r2vp"));
        return gezeigt.length >= 4 && roh ? true : null;`, 15_000, 300);
      if (!ok) return null;
      await new Promise((r) => setTimeout(r, 800));
      // Bis unter den Text, nicht bis zum Fensterrand: dort sitzt die Statusleiste.
      const box = await boxOf(cdp, ".workspace-split.mod-vertical.mod-root", 0);
      return { clip: box ? { ...box, height: Math.min(box.height, 360) } : null, scale: 2 };
    },
  },
  {
    // Das Prüffenster eines interaktiven `transform` mit zwei neuen Werten.
    name: "review.png", klasse: "feature",
    async run(cdp) {
      await setWindowSize(cdp, 1200, 800);
      await cdp.evaluate(`window.__shotsPruef = ${P}.api.transform(${q({ caller: "shots", documentKey: "shots-pruef", interactive: true, title: "Reply to the offer", parts: [{ id: "a", kind: "text", value: PRUEF_TEXT }] })}); return true;`);
      const da = await pollUntil<boolean>(cdp, `const m = document.querySelector(".modal.pseu-review-modal"); return m && m.querySelectorAll(".okit-review-card").length >= 2 ? true : null;`, 10_000, 250);
      if (!da) return null;
      await new Promise((r) => setTimeout(r, 600));
      const clip = await boxOf(cdp, ".modal.pseu-review-modal", 0);
      return { clip, scale: 2 };
    },
  },
  {
    name: "persons.png", klasse: "feature",
    async run(cdp) {
      await setWindowSize(cdp, 1000, 760);
      await cdp.evaluate(SEITENLEISTEN_ZU);
      await cdp.evaluate(ZEIGE_REITER("persons"));
      const bereit = await pollUntil<boolean>(cdp, `const p = document.querySelector(".pseu-root .pseu-panel"); return p && p.querySelectorAll(".pseu-person").length >= 2 ? true : null;`, 10_000, 300);
      if (!bereit) return null;
      await clickReal(cdp, `(Array.from(document.querySelectorAll(".pseu-root .pseu-person")).find((li) => li.querySelector(".pseu-person-label").textContent.trim() === "Anna Probe")?.querySelector(".pseu-person-head") || null)`);
      await pollUntil<boolean>(cdp, `return document.querySelector(".pseu-root .pseu-person.is-open") ? true : null;`, 5000, 250);
      await new Promise((r) => setTimeout(r, 500));
      return { clip: await inhaltsClip(cdp), scale: 2 };
    },
  },
  {
    name: "devices.png", klasse: "feature",
    async run(cdp) {
      await setWindowSize(cdp, 1000, 760);
      await cdp.evaluate(ZEIGE_REITER("devices"));
      const bereit = await pollUntil<boolean>(cdp, `const d = document.querySelectorAll(".pseu-root .pseu-panel")[2]; return d && d.querySelectorAll(".pseu-device").length >= 2 ? true : null;`, 10_000, 300);
      if (!bereit) return null;
      // Gerätename ändern wie ein Nutzer: ins Feld schreiben, `change` auslösen.
      await cdp.evaluate(`const i = document.querySelector(".pseu-devices-panel .setting-item input[type=text]"); if (!i) return false; i.focus(); i.value = "Desktop"; i.dispatchEvent(new Event("change", { bubbles: true })); i.blur(); return true;`);
      await pollUntil<boolean>(cdp, `const o = ${P}.devicesModel().rows.find((r) => r.own); return o && o.name === "Desktop" ? true : null;`, 8000, 300);
      await new Promise((r) => setTimeout(r, 500));
      return { clip: await inhaltsClip(cdp), scale: 2 };
    },
  },
];

function setup(): void {
  const log = buildVault({ repoRoot: REPO_ROOT, vaultDir: stagingVaultDir(REPO_NAME), fixtureDir: FIXTURE_DIR, pluginId: PLUGIN_ID });
  console.log(`Staging-Vault gebaut: ${stagingVaultDir(REPO_NAME)}`);
  for (const l of log) console.log(`  · ${l}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.has("setup")) { setup(); return; }
  const portArg = args.value("port");
  if (!portArg || !Number.isInteger(Number(portArg))) throw new Error("--port <Port> ist Pflicht (Zweitinstanz).");
  const outDir = join(REPO_ROOT, args.value("bilder") ?? "docs/images");
  const nur = args.value("only");
  const cdp = await attachTo("workspace", Number(portArg), REPO_NAME);
  if (!cdp) throw new Error(`Kein Obsidian-Hauptfenster auf Port ${portArg} für Vault „${REPO_NAME}“.`);
  let fehler = 0;
  try {
    await requireVisible(cdp);
    const klar = await bereiteInstanzVor(cdp, { pluginIds: [PLUGIN_ID], nurVault: REPO_NAME, sprache: "en" });
    console.log(`(${klar.hinweis})`);
    const info = await cdp.evaluate<{ basePath: string; configDir: string }>(`return { basePath: app.vault.adapter.basePath, configDir: app.vault.configDir };`);
    requireEigenerBuild(join(info.basePath, info.configDir, "plugins", PLUGIN_ID, "main.js"), join(REPO_ROOT, "main.js"), (m) => console.log(`  ! ${m}`));
    // Die Anzeige der Oberfläche muss Englisch sein, sonst zeigt jedes Bild die falsche Sprache.
    const lang = await cdp.evaluate<string>(`return document.documentElement.lang;`);
    if (!/^en/.test(lang)) throw new Error(`Oberfläche nicht Englisch (lang=${lang}); Start ohne --lang=en-US`);

    if (!(await richteEin(cdp))) throw new Error("Einrichten bis ready ist nicht gelungen.");
    await clearNotices(cdp);
    const k = await cdp.evaluate<{ chainId: number[]; stand: number; key: number[] } | null>(`const k = ${P}.keys.read(); return k && !k.error ? { chainId: Array.from(k.chainId), stand: k.stand, key: Array.from(k.key) } : null;`);
    if (!k || !(await schreibeFremdeFassung(info.basePath, k))) throw new Error("Fremde Fassung nicht geschrieben.");
    const gelesen = await pollUntil<boolean>(cdp, `const r = ${P}.api.restore("Hallo Person_m4t8c6r2vp", { caller: "shots" }); return r && r.text === "Hallo Max Mustermann" ? true : null;`, 60_000, 1000);
    if (!gelesen) throw new Error("Die fremde Fassung wurde nicht gelesen.");
    await cdp.evaluate(`${P}.device.setShowPlaintext(true); return true;`);

    mkdirSync(join(outDir, "thumbs"), { recursive: true });
    for (const b of bilder) {
      if (nur && nur !== b.name) continue;
      try {
        const r = await b.run(cdp);
        if (!r || !r.clip) { console.log(`  ✗ ${b.name}: Zustand nicht erreicht`); fehler += 1; continue; }
        const png = quetschen(await scaleTo(cdp, await capture(cdp, r.clip, r.scale), CAPTURE_WIDTH));
        writeFileSync(join(outDir, b.name), png);
        if (b.klasse === "detail") writeFileSync(join(outDir, "thumbs", b.name), quetschen(await scaleTo(cdp, png, THUMB_WIDTH)));
        console.log(`  ✓ ${b.name} — ${Math.round(png.length / 1024)} KB`);
      } catch (e) {
        console.log(`  ✗ ${b.name}: ${(e as Error).message}`);
        fehler += 1;
      }
      // Aufräumen vor dem nächsten Motiv: Prüffenster abbrechen, Ansicht zu.
      await cdp.evaluate(`const b = ${MODAL_BTN("Cancel")}; if (b) b.click(); return true;`);
      await new Promise((r) => setTimeout(r, 400));
      await cdp.evaluate(SCHLIESSE_ANSICHT);
    }
    await cdp.evaluate(`${P}.keys.clear(); return true;`);
  } finally {
    cdp.close();
  }
  if (fehler > 0) process.exitCode = 1;
}

runDriver(main);
