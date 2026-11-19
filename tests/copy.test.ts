// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, Plugin } from "obsidian";
import { Notice } from "./vendor/kit/obsidian-mock";
import "../src/i18n/strings";
import { setLang } from "../src/vendor/kit/i18n";
import { createApi } from "../src/core/api";
import { MemoryTable } from "../src/core/memory-table";
import type { CopyMode } from "../src/core/settings";
import { PseudonymizerEngine } from "../src/obsidian/engine";
import { copyCommand, copyFassung, registerCopyHandlers, type CopyUi } from "../src/obsidian/copy";
import { swapOptions } from "../src/obsidian/reading";
import { textSwapPostProcessor } from "../src/vendor/kit-obsidian/text-swap";
import { forgetPerson, PERSON, PERSON_B, sampleTable } from "./helpers/table-fixtures";
import { installDomGlobals, root, select } from "./helpers/dom";

beforeAll(() => { installDomGlobals(); });
beforeEach(() => { setLang("en"); Notice.instances.length = 0; });
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

const NAME = `Person_${PERSON}`;
const MAIL = `Person_${PERSON}_Mail`;
const FOREIGN = `Person_${PERSON_B}`;
const lastNotice = (): string => String(Notice.instances[Notice.instances.length - 1]?.message ?? "");

function memoryWith(table = sampleTable()): MemoryTable {
  const m = new MemoryTable();
  m.open(table);
  return m;
}

describe("copyFassung: Kopieren liefert, was ich sehe, gekoppelt an den Umschalter (B1)", () => {
  it("Platzhalter in der Vorgabe, gleich ob der Klartext gezeigt wird", () => {
    expect(copyFassung("placeholder", true)).toBe("placeholder");
    expect(copyFassung("placeholder", false)).toBe("placeholder");
  });
  it("„was ich sehe“ liefert Klartext nur, wenn der Klartext auch gezeigt wird", () => {
    expect(copyFassung("as-shown", true)).toBe("plain");
    expect(copyFassung("as-shown", false)).toBe("placeholder");
  });
});

/** Ein Plugin- und App-Double, das die Kopier-Handler je Fenster festhält. */
function windows(initial: Document[] = []) {
  const attached: { doc: Document; type: string; cb: (ev: ClipboardEvent) => void }[] = [];
  const events = new Map<string, (...a: never[]) => void>();
  let ready: (() => void) | null = null;
  const docs = [document, ...initial];
  const app = {
    workspace: {
      containerEl: { ownerDocument: document },
      iterateAllLeaves: (cb: (l: unknown) => void) => { docs.slice(1).forEach((d) => { cb({ view: { containerEl: { ownerDocument: d } } }); }); },
      on: (name: string, cb: (...a: never[]) => void) => { events.set(name, cb); return { name }; },
      onLayoutReady: (cb: () => void) => { ready = cb; },
    },
  } as unknown as Pick<App, "workspace">;
  const plugin = {
    registerDomEvent: (doc: Document, type: string, cb: (ev: ClipboardEvent) => void) => { attached.push({ doc, type, cb }); },
    registerEvent: () => undefined,
  } as unknown as Pick<Plugin, "registerDomEvent" | "registerEvent">;
  return { app, plugin, attached, events, docs, ready: () => { ready?.(); } };
}

describe("registerCopyHandlers: ein Handler je Fenster (B2)", () => {
  it("hängt einen Kopier-Handler an das Hauptfenster und an jedes schon offene Popout, je einmal", () => {
    const pop = document.implementation.createHTMLDocument("popout");
    const w = windows([pop]);
    const scan = registerCopyHandlers(w.plugin, w.app, { options: swapOptions(memoryWith(), () => true), copyMode: () => "placeholder" });
    expect(w.attached.filter((a) => a.type === "copy").map((a) => a.doc)).toEqual([document, pop]);
    expect(w.attached.filter((a) => a.type === "dragstart").map((a) => a.doc)).toEqual([document, pop]);
    scan();
    w.events.get("layout-change")?.();
    w.ready();
    expect(w.attached).toHaveLength(4);
  });

  it("ein Popout, das später aufgeht (window-open oder layout-change), bekommt seinen Handler", () => {
    const w = windows();
    registerCopyHandlers(w.plugin, w.app, { options: swapOptions(memoryWith(), () => true), copyMode: () => "placeholder" });
    const late = document.implementation.createHTMLDocument("late");
    (w.events.get("window-open") as unknown as (win: unknown, window: { document: Document }) => void)({}, { document: late });
    const copies = (): Document[] => w.attached.filter((a) => a.type === "copy").map((a) => a.doc);
    expect(copies()).toEqual([document, late]);
    const later = document.implementation.createHTMLDocument("later");
    w.docs.push(later);
    w.events.get("layout-change")?.();
    expect(copies()).toEqual([document, late, later]);
  });
});

/** Der Handler in echt: Notiz rendern, auswählen, kopieren; liefert, was in die Zwischenablage ginge. */
function copying(mode: CopyMode, shownOn: boolean, table = sampleTable()) {
  const memory = memoryWith(table);
  const shown = { on: shownOn };
  const options = swapOptions(memory, () => shown.on);
  const w = windows();
  const settings = { mode };
  registerCopyHandlers(w.plugin, w.app, { options, copyMode: () => settings.mode });
  const handler = w.attached.find((a) => a.type === "copy")?.cb;
  const dragHandler = w.attached.find((a) => a.type === "dragstart")?.cb;
  if (handler === undefined || dragHandler === undefined) throw new Error("no handler");
  const el = root("");
  const render = (html: string): HTMLElement => { el.innerHTML = html; textSwapPostProcessor(options)(el); return el; };
  const copy = (): { text: string; html: string; prevented: boolean } | null => {
    const data = new Map<string, string>();
    let prevented = false;
    handler({ clipboardData: { setData: (k: string, v: string) => { data.set(k, v); } }, target: el, preventDefault: () => { prevented = true; } } as unknown as ClipboardEvent);
    return prevented ? { text: data.get("text/plain") ?? "", html: data.get("text/html") ?? "", prevented } : null;
  };
  /** Der Zug mit der Maus: `dragstart` mit einem DataTransfer; liefert, was der Zug trägt. */
  const drag = (): { text: string; html: string } => {
    const data = new Map<string, string>();
    dragHandler({ dataTransfer: { setData: (k: string, v: string) => { data.set(k, v); } }, target: el } as unknown as ClipboardEvent);
    return { text: data.get("text/plain") ?? "", html: data.get("text/html") ?? "" };
  };
  return { render, copy, drag, shown, settings, memory };
}

describe("Kopieren in der Lesesicht", () => {
  it("die Vorgabe liefert Platzhalter, auch wenn der Klartext gezeigt wird", () => {
    const c = copying("placeholder", true);
    const el = c.render(`<p>Hallo ${NAME}, ${MAIL}</p>`);
    expect(el.textContent).toContain("Max Mustermann");
    const p = el.querySelector("p");
    select(p!, 0, p!, p!.childNodes.length);
    const out = c.copy();
    expect(out?.text).toBe(`Hallo ${NAME}, ${MAIL}`);
    expect(out?.html).not.toMatch(/Mustermann|max@example/);
  });

  it("eine nur teilweise erfasste eingeblendete Stelle liefert den ganzen Platzhalter, nie einen Klartext-Rest (Review-Fokus 4)", () => {
    const c = copying("placeholder", true);
    const el = c.render(`<p>${NAME}</p>`);
    const inner = el.querySelector(".okit-swap")!.firstChild!;
    expect(inner.textContent).toBe("Max Mustermann");
    select(inner, 4, inner, 9); // „Muste“
    const out = c.copy();
    expect(out?.text).toBe(NAME);
    expect(out?.text).not.toContain("Muste");
    expect(out?.html).not.toContain("Muste");
  });

  it("zwei gleiche Texte nebeneinander bleiben zwei Stellen mit je ihrem Platzhalter", () => {
    const c = copying("placeholder", true);
    const el = c.render(`<p>${NAME} ${NAME}</p>`);
    const p = el.querySelector("p")!;
    select(p, 0, p, p.childNodes.length);
    expect(c.copy()?.text).toBe(`${NAME} ${NAME}`);
  });

  it("„was ich sehe“ liefert den Klartext, solange der Klartext gezeigt wird", () => {
    const c = copying("as-shown", true);
    const el = c.render(`<p>${NAME} ${MAIL}</p>`);
    const p = el.querySelector("p")!;
    select(p, 0, p, p.childNodes.length);
    expect(c.copy()?.text).toBe("Max Mustermann max@example.org");
  });

  it("„was ich sehe“ koppelt an den Umschalter: bei ausgeblendetem Klartext liefert Kopieren Platzhalter, nie Klartext (B1)", () => {
    const c = copying("as-shown", false);
    const el = c.render(`<p>${NAME}</p>`);
    const p = el.querySelector("p")!;
    select(p, 0, p, p.childNodes.length);
    expect(c.copy()?.text).toBe(NAME);
    c.shown.on = true; // der Handler liest Einstellung und Umschalter bei jedem Kopieren frisch
    expect(c.copy()?.text).toBe("Max Mustermann");
    c.settings.mode = "placeholder";
    expect(c.copy()?.text).toBe(NAME);
  });

  it("ein vergessener Platzhalter geht auch bei „was ich sehe“ als Platzhalter hinaus", () => {
    const c = copying("as-shown", true, forgetPerson(sampleTable()));
    const el = c.render(`<p>${NAME}</p>`);
    const p = el.querySelector("p")!;
    select(p, 0, p, p.childNodes.length);
    expect(c.copy()?.text).toBe(NAME);
  });

  it("Ziehen markierten Texts trägt nie den Klartext mit, außer in der Fassung „was ich sehe“", () => {
    const c = copying("placeholder", true);
    const el = c.render(`<p>Hallo ${NAME}</p>`);
    const p = el.querySelector("p")!;
    select(p, 0, p, p.childNodes.length);
    const out = c.drag();
    expect(out.text).toBe(`Hallo ${NAME}`);
    expect(out.html).not.toContain("Mustermann");
    c.settings.mode = "as-shown";
    expect(c.drag().text).toBe("Hallo Max Mustermann");
    c.shown.on = false;
    expect(c.drag().text).toBe(`Hallo ${NAME}`);
  });

  it("Auswahl ohne eingeblendete Stelle: der Handler greift nicht, der Browser kopiert selbst", () => {
    const c = copying("as-shown", true);
    const el = c.render(`<p>nur Text</p>`);
    const p = el.querySelector("p")!;
    select(p, 0, p, 1);
    expect(c.copy()).toBeNull();
  });
});

function ui(text: string | null) {
  const written: { text: string; message: string }[] = [];
  const u: CopyUi = {
    source: () => text,
    write: (t, message) => { written.push({ text: t, message }); return Promise.resolve(true); },
  };
  return { u, written };
}

function hostFor(memory: MemoryTable) {
  return { app: {} as Pick<App, "workspace">, api: createApi(() => new PseudonymizerEngine(memory)) };
}

describe("Befehle „Mit Klartext kopieren“ und „Mit Platzhaltern kopieren“", () => {
  it("Klartext geht hinaus, wenn nichts unlesbar ist", async () => {
    const { u, written } = ui(`Hallo ${NAME}, Mail ${MAIL}`);
    await copyCommand(hostFor(memoryWith()), "plaintext", u);
    expect(written).toEqual([{ text: "Hallo Max Mustermann, Mail max@example.org", message: "Copied with plain text (2 replaced)." }]);
    expect(Notice.instances).toHaveLength(0);
  });

  it("ein unbekannter Platzhalter hält alles zurück: nichts wird kopiert, die Notice nennt Platzhalter und nie Klartext", async () => {
    const { u, written } = ui(`${NAME} und ${FOREIGN}`);
    await copyCommand(hostFor(memoryWith()), "plaintext", u);
    expect(written).toEqual([]);
    expect(lastNotice()).toContain(FOREIGN);
    expect(lastNotice()).not.toMatch(/Mustermann|max@example/);
  });

  it("die Notice kürzt eine lange Liste unlesbarer Platzhalter", async () => {
    const many = Array.from({ length: 6 }, (_, i) => `Person_m4t8c6r2v${String(i)}`).join(" ");
    const { u, written } = ui(many);
    await copyCommand(hostFor(memoryWith()), "plaintext", u);
    expect(written).toEqual([]);
    expect(lastNotice()).toContain("6 placeholder(s)");
    expect(lastNotice()).toContain("…");
  });

  it("vergessene gehen als Platzhalter hinaus, mit Hinweis", async () => {
    const { u, written } = ui(`Hallo ${NAME}`);
    await copyCommand(hostFor(memoryWith(forgetPerson(sampleTable()))), "plaintext", u);
    expect(written).toEqual([{ text: `Hallo ${NAME}`, message: "Copied with plain text (0 replaced). 1 forgotten stay as placeholders." }]);
  });

  it("Platzhalter in Adressen und Code bleiben beim Kopieren Platzhalter; Fließtext und mailto: werden aufgelöst; die Notice zählt die stehengebliebenen, ohne Klartext (W1)", async () => {
    const text = [
      `Hallo ${NAME}, [Mail](mailto:${MAIL}).`,
      `![x](https://evil.example/p?n=${NAME})`,
      `[l](https://evil.example/${NAME})`,
      `<img src="https://evil.example/${NAME}.png">`,
      `https://evil.example/u/${NAME}`,
      `\`${NAME}\``,
      "```",
      NAME,
      "```",
    ].join("\n");
    const { u, written } = ui(text);
    await copyCommand(hostFor(memoryWith()), "plaintext", u);
    expect(written).toHaveLength(1);
    const out = written[0]?.text ?? "";
    expect(out).toContain("Hallo Max Mustermann, [Mail](mailto:max@example.org).");
    expect(out.replace("Hallo Max Mustermann, [Mail](mailto:max@example.org).", "")).not.toMatch(/Mustermann/);
    expect(out.match(new RegExp(NAME, "g"))).toHaveLength(6);
    expect(lastNotice()).toBe("6 placeholder(s) in addresses or code stayed as placeholders.");
    expect(lastNotice()).not.toMatch(/Mustermann|max@example/);
  });

  it("gesperrt oder nicht eingerichtet: nichts wird kopiert, die Notice nennt den Grund", async () => {
    const locked = memoryWith();
    locked.lock("table-missing");
    const a = ui(NAME);
    await copyCommand(hostFor(locked), "plaintext", a.u);
    expect(a.written).toEqual([]);
    expect(lastNotice()).toMatch(/locked/);
    const b = ui(NAME);
    await copyCommand(hostFor(new MemoryTable()), "plaintext", b.u);
    expect(b.written).toEqual([]);
    expect(lastNotice()).toMatch(/No table yet/);
  });

  it("Mit Platzhaltern kopieren gibt den Text unverändert hinaus, ohne die Tabelle zu brauchen", async () => {
    const { u, written } = ui(`Hallo ${NAME}`);
    await copyCommand(hostFor(new MemoryTable()), "placeholders", u);
    expect(written).toEqual([{ text: `Hallo ${NAME}`, message: "Copied with placeholders." }]);
  });

  it("ohne Notiz und bei leerem Text sagt eine Notice es", async () => {
    const a = ui(null);
    await copyCommand(hostFor(memoryWith()), "plaintext", a.u);
    expect(lastNotice()).toBe("Open a note first.");
    const b = ui("");
    await copyCommand(hostFor(memoryWith()), "plaintext", b.u);
    expect(lastNotice()).toBe("There is nothing to copy.");
    expect(a.written.length + b.written.length).toBe(0);
  });

  it("ein Fehler im Ablauf heißt „hat nicht geklappt“ und nennt keinen Text der Ausnahme", async () => {
    const u: CopyUi = { source: () => { throw new Error("Max Mustermann"); }, write: () => Promise.resolve(true) };
    await copyCommand(hostFor(memoryWith()), "plaintext", u);
    expect(lastNotice()).toBe("That did not work.");
  });
});

describe("Quelle der Befehle (Auswahl oder ganze Notiz) und Zwischenablage", () => {
  type FakeView = { getMode(): string; editor: { getSelection(): string; getValue(): string }; data: string };
  const hostWith = (view: FakeView | null, memory = memoryWith()) => ({
    app: { workspace: { getActiveViewOfType: () => view } } as unknown as Pick<App, "workspace">,
    api: createApi(() => new PseudonymizerEngine(memory)),
  });
  const view = (mode: string, selection: string): FakeView => ({ getMode: () => mode, editor: { getSelection: () => selection, getValue: () => `Editor ${MAIL}` }, data: `Datei ${NAME}` });
  let written: string[] = [];
  beforeEach(() => {
    written = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } } });
  });

  it("im Quelltext gilt die Auswahl, ohne Auswahl der ganze Editorinhalt", async () => {
    await copyCommand(hostWith(view("source", `Hallo ${NAME}`)), "plaintext");
    await copyCommand(hostWith(view("source", "")), "plaintext");
    expect(written).toEqual(["Hallo Max Mustermann", "Editor max@example.org"]);
  });

  it("in der Lesesicht gilt die ganze Notiz aus den geladenen Daten, nie eine alte Auswahl des Editors", async () => {
    await copyCommand(hostWith(view("preview", `Alte Auswahl ${NAME}`)), "plaintext");
    expect(written).toEqual(["Datei Max Mustermann"]);
  });

  it("Mit Platzhaltern kopieren liefert den Dateitext, ohne Notiz sagt eine Notice es", async () => {
    await copyCommand(hostWith(view("source", `Hallo ${NAME}`)), "placeholders");
    expect(written).toEqual([`Hallo ${NAME}`]);
    await copyCommand(hostWith(null), "placeholders");
    expect(lastNotice()).toBe("Open a note first.");
  });
});
