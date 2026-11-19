// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { App, Plugin } from "obsidian";
import { MarkdownView, Notice } from "./vendor/kit/obsidian-mock";
import { pruefeLinear } from "./vendor/kit/linear-probe";
import "../src/i18n/strings";
import { setLang } from "../src/vendor/kit/i18n";
import { MemoryTable } from "../src/core/memory-table";
import type { CopyMode } from "../src/core/settings";
import { textSwapEditorDecorations, textSwapEditorRefresh } from "../src/vendor/kit-obsidian/text-swap-editor";
import { editorCopyHandler, fenceSpans, inFence, livePreviewExtension, plainRangeText, refreshEditors, setUpLivePreview, type LivePreviewDeps } from "../src/obsidian/live-preview";
import { setUpReading, swapOptions } from "../src/obsidian/reading";
import { forgetPerson, PERSON, PERSON_B, sampleTable } from "./helpers/table-fixtures";
import { installDomGlobals } from "./helpers/dom";

beforeAll(() => { installDomGlobals(); });
beforeEach(() => { setLang("en"); Notice.instances.length = 0; });
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

const NAME = `Person_${PERSON}`;
const MAIL = `Person_${PERSON}_Mail`;
const NOT_YET = `Person_${PERSON}_Mail_5`;
const FOREIGN = `Person_${PERSON_B}`;
const CLEAR = "Max Mustermann";

function memoryWith(table = sampleTable()): MemoryTable {
  const m = new MemoryTable();
  m.open(table);
  return m;
}

// Der Modus (Live Preview oder Quelltext) als Feld des Zustands, wie `editorLivePreviewField` in Obsidian.
const setMode = StateEffect.define<boolean>();
const modeField = StateField.define<boolean>({
  create: () => true,
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setMode)) return e.value; return v; },
});
const active = (s: EditorState): boolean => s.field(modeField);

interface Rig {
  memory: MemoryTable;
  shown: { on: boolean };
  mode: { copy: CopyMode };
  deps: LivePreviewDeps;
  leaves: { view: unknown }[];
}

function rig(memory = memoryWith()): Rig {
  const shown = { on: true };
  const mode = { copy: "placeholder" as CopyMode };
  const leaves: { view: unknown }[] = [];
  const app = { workspace: { containerEl: { ownerDocument: document }, iterateAllLeaves: (cb: (l: unknown) => void) => { leaves.forEach(cb); } } } as unknown as Pick<App, "workspace">;
  return { memory, shown, mode, leaves, deps: { app, options: swapOptions(memory, () => shown.on), copyMode: () => mode.copy, active } };
}

function mount(r: Rig, doc: string, parent: HTMLElement = document.body, extra: Extension[] = []): EditorView {
  return new EditorView({ state: EditorState.create({ doc, extensions: [modeField, livePreviewExtension(r.deps), ...extra] }), parent });
}

const widgets = (v: EditorView): HTMLElement[] => Array.from(v.dom.querySelectorAll<HTMLElement>(".okit-swap-inline"));
const texts = (v: EditorView): (string | null)[] => widgets(v).map((w) => w.textContent);

describe("Dekorationen in Live Preview", () => {
  it("ersetzt bekannte Platzhalter mitten in der Zeile durch ein Widget mit dem Klartext; der Platzhalter steht nur im Tooltip und im Attribut", () => {
    const v = mount(rig(), `Hallo ${NAME}, schreib an ${MAIL}.`);
    expect(texts(v)).toEqual([CLEAR, "max@example.org"]);
    const first = widgets(v)[0];
    expect(first?.getAttribute("data-okit-swap")).toBe(NAME);
    expect(first?.getAttribute("title")).toBe(NAME);
    expect(first?.classList.contains("is-shown")).toBe(true);
    expect(v.dom.querySelector(".cm-content")?.textContent).toContain("Hallo ");
    expect(v.dom.querySelector(".cm-content")?.textContent).not.toContain(NAME);
  });

  it("das Dokument bleibt, wie es war: nichts am Text ändert sich durch das Einblenden, Umschalten, Cursor oder Auswahl", () => {
    const r = rig();
    const doc = `Hallo ${NAME}.\nZweite Zeile ${MAIL}`;
    const v = mount(r, doc);
    v.dispatch({ selection: EditorSelection.single(3) });
    v.dispatch({ selection: EditorSelection.single(8, 12) });
    r.shown.on = false;
    refreshEditors({ workspace: { iterateAllLeaves: (cb: (l: unknown) => void) => { cb(viewLeaf(v)); } } } as unknown as Pick<App, "workspace">);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("ein unbekannter Platzhalter bleibt Text; ein vergessener und ein noch nicht lesbarer sind gekennzeichnet, ohne Klartext", () => {
    const forgotten = mount(rig(memoryWith(forgetPerson(sampleTable()))), `a ${NAME} b`);
    expect(widgets(forgotten)).toHaveLength(1);
    expect(widgets(forgotten)[0]?.classList.contains("is-forgotten")).toBe(true);
    expect(widgets(forgotten)[0]?.getAttribute("title")).toBe(`${NAME} — forgotten`);
    expect(forgotten.dom.textContent).not.toContain(CLEAR);

    const mixed = mount(rig(), `${FOREIGN} und ${NOT_YET}`);
    expect(widgets(mixed)).toHaveLength(1);
    expect(widgets(mixed)[0]?.classList.contains("is-unreadable")).toBe(true);
    expect(widgets(mixed)[0]?.getAttribute("title")).toMatch(/may not have synced/);
    expect(mixed.dom.querySelector(".cm-content")?.textContent).toContain(FOREIGN);
  });

  it("in Codeblöcken (flach, Tilde, im Zitat, unter einem Listenpunkt) und in Inline-Code bleibt der Platzhalter; davor und danach wird ersetzt", () => {
    const doc = [
      `Intro ${NAME}`,
      "",
      "```",
      `code ${NAME}`,
      "```",
      "",
      "~~~js",
      `tilde ${MAIL}`,
      "~~~",
      "",
      "> ```",
      `> quoted ${NAME}`,
      "> ```",
      "",
      "- Punkt",
      "",
      "    ```",
      `    listed ${NAME}`,
      "    ```",
      "",
      `Inline \`${NAME}\` und ${MAIL} draußen`,
    ].join("\n");
    const v = mount(rig(), doc);
    expect(texts(v)).toEqual([CLEAR, "max@example.org"]);
    const content = v.dom.querySelector(".cm-content")?.textContent ?? "";
    for (const kept of [`code ${NAME}`, `tilde ${MAIL}`, `quoted ${NAME}`, `listed ${NAME}`, `\`${NAME}\``]) expect(content).toContain(kept);
  });

  it("ein nicht geschlossener Zaun sperrt bis zum Ende", () => {
    const v = mount(rig(), `Vorn ${NAME}\n\`\`\`\nhinten ${MAIL}`);
    expect(texts(v)).toEqual([CLEAR]);
  });

  it("im Quelltextmodus (active false) gibt es keine Widgets; ein Wechsel in Live Preview und zurück rechnet von selbst neu", async () => {
    const v = mount(rig(), `Hallo ${NAME}`);
    expect(widgets(v)).toHaveLength(1);
    v.dispatch({ effects: setMode.of(false) });
    await Promise.resolve();
    expect(widgets(v)).toHaveLength(0);
    expect(v.dom.querySelector(".cm-content")?.textContent).toContain(NAME);
    v.dispatch({ effects: setMode.of(true) });
    await Promise.resolve();
    expect(widgets(v)).toHaveLength(1);
  });

  it("berühren Cursor oder Auswahl die Stelle (auch am Rand), zeigt sie den Platzhalter; daneben bleibt das Widget", () => {
    const v = mount(rig(), `Hallo ${NAME} und ${MAIL}`, document.body, [EditorState.allowMultipleSelections.of(true)]);
    v.dispatch({ selection: EditorSelection.single(2) });
    expect(widgets(v)).toHaveLength(2);
    v.dispatch({ selection: EditorSelection.single(11) });
    expect(texts(v)).toEqual(["max@example.org"]);
    v.dispatch({ selection: EditorSelection.single(6) });
    expect(texts(v)).toEqual(["max@example.org"]);
    v.dispatch({ selection: EditorSelection.single(6 + NAME.length) });
    expect(texts(v)).toEqual(["max@example.org"]);
    v.dispatch({ selection: EditorSelection.single(6 + NAME.length + 1) });
    expect(widgets(v)).toHaveLength(2);
  });

  it("jeder Tooltip und jedes Attribut ist frei von Klartext", () => {
    const v = mount(rig(), `${NAME} ${MAIL} ${NOT_YET}`);
    for (const w of widgets(v)) {
      for (const a of Array.from(w.attributes)) for (const c of [CLEAR, "max@example.org"]) expect(a.value).not.toContain(c);
    }
  });
});

function viewLeaf(v: EditorView): { view: unknown } {
  const view = new MarkdownView();
  Object.assign(view, { editor: { cm: v }, containerEl: { ownerDocument: v.dom.ownerDocument } });
  return { view };
}

describe("Auffrischen: jeder offene Editor in jedem Fenster", () => {
  it("refreshEditors schickt den Effekt an den Editor jedes Markdown-Blatts, auch in einem Popout, und lässt andere Blätter aus", () => {
    const r = rig();
    const pop = document.implementation.createHTMLDocument("popout");
    const a = mount(r, `x ${NAME}`);
    const b = mount(r, `y ${NAME}`, pop.body);
    const spyA = vi.spyOn(a, "dispatch");
    const spyB = vi.spyOn(b, "dispatch");
    r.leaves.push(viewLeaf(a), viewLeaf(b), { view: { containerEl: {} } }, { view: Object.assign(new MarkdownView(), { editor: {} }) });
    expect(refreshEditors(r.deps.app)).toBe(2);
    for (const spy of [spyA, spyB]) {
      const spec = spy.mock.calls[0]?.[0] as { effects: StateEffect<unknown> };
      expect(spec.effects.is(textSwapEditorRefresh)).toBe(true);
    }
  });

  it("Umschalter, Sperren und Vergessen über das Auffrischen der Lesesicht zeichnen Live Preview ohne Neuöffnen um; Klartext einer vergessenen Person bleibt nicht stehen", () => {
    const r = rig();
    const listeners = new Set<() => void>();
    const plugin = { registerMarkdownPostProcessor: () => undefined, registerEditorExtension: () => undefined } as unknown as Pick<Plugin, "registerMarkdownPostProcessor" | "registerEditorExtension">;
    const reading = setUpReading(plugin, { app: r.deps.app, options: r.deps.options, onChange: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; } });
    setUpLivePreview(plugin, reading, r.deps);
    const v = mount(r, `Hallo ${NAME}`);
    r.leaves.push(viewLeaf(v));
    expect(texts(v)).toEqual([CLEAR]);

    r.shown.on = false;
    for (const l of listeners) l();
    expect(texts(v)).toEqual([NAME]);
    expect(widgets(v)[0]?.classList.contains("is-shown")).toBe(false);

    r.shown.on = true;
    for (const l of listeners) l();
    expect(texts(v)).toEqual([CLEAR]);

    r.memory.lock("key-replaced");
    for (const l of listeners) l();
    expect(widgets(v)[0]?.classList.contains("is-unreadable")).toBe(true);
    expect(v.dom.textContent).not.toContain(CLEAR);

    r.memory.open(forgetPerson(sampleTable()));
    for (const l of listeners) l();
    expect(widgets(v)[0]?.classList.contains("is-forgotten")).toBe(true);
    expect(v.dom.textContent).not.toContain(CLEAR);
  });

  it("setUpLivePreview registriert genau eine Erweiterung und hängt sich an den Haken der Lesesicht", () => {
    const r = rig();
    const register = vi.fn();
    const onRefresh = vi.fn(() => () => undefined);
    setUpLivePreview({ registerEditorExtension: register } as unknown as Pick<Plugin, "registerEditorExtension">, { onRefresh }, r.deps);
    expect(register).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

/** Ein Kopier-Ereignis mit Zwischenablage zum Auslesen. */
function clip(type: "copy" | "cut" = "copy") {
  const set: Record<string, string> = {};
  const ev = {
    type,
    clipboardData: { clearData: vi.fn(), setData: (k: string, v: string) => { set[k] = v; } },
    preventDefault: vi.fn(),
  } as unknown as ClipboardEvent;
  return { ev, set, prevented: ev.preventDefault as unknown as ReturnType<typeof vi.fn> };
}

function copyView(doc: string, selection: EditorSelection | "all" = "all") {
  const state = EditorState.create({ doc, extensions: [modeField, EditorState.allowMultipleSelections.of(true)], ...(selection === "all" ? { selection: EditorSelection.single(0, doc.length) } : { selection }) });
  return { state, dispatch: vi.fn() };
}

describe("Kopieren aus Live Preview", () => {
  const DOC = `Hallo ${NAME}, Mail ${MAIL}.`;

  it("in der Vorgabe (Platzhalter) tut der Handler nichts: CodeMirror kopiert den Dateitext", () => {
    const r = rig();
    const c = clip();
    expect(editorCopyHandler(r.deps)(c.ev, copyView(DOC))).toBe(false);
    expect(c.set).toEqual({});
    expect(c.prevented).not.toHaveBeenCalled();
  });

  it("„Kopieren liefert, was ich sehe“ mit eingeblendetem Klartext: die Zwischenablage trägt die eingeblendete Fassung", () => {
    const r = rig();
    r.mode.copy = "as-shown";
    const c = clip();
    expect(editorCopyHandler(r.deps)(c.ev, copyView(DOC))).toBe(true);
    expect(c.set["text/plain"]).toBe(`Hallo ${CLEAR}, Mail max@example.org.`);
    expect(c.prevented).toHaveBeenCalled();
  });

  it("bei ausgeblendetem Klartext oder im Quelltextmodus bleibt es der Dateitext, auch mit „was ich sehe“", () => {
    const r = rig();
    r.mode.copy = "as-shown";
    r.shown.on = false;
    const c1 = clip();
    expect(editorCopyHandler(r.deps)(c1.ev, copyView(DOC))).toBe(false);
    r.shown.on = true;
    const c2 = clip();
    const src = copyView(DOC);
    src.state = src.state.update({ effects: setMode.of(false) }).state;
    expect(editorCopyHandler(r.deps)(c2.ev, src)).toBe(false);
    expect(c1.set).toEqual({});
    expect(c2.set).toEqual({});
  });

  it("ein unbekannter, ein vergessener und ein noch nicht lesbarer Platzhalter bleiben Platzhalter, ohne Notice; die bekannten daneben werden Klartext", () => {
    const r = rig();
    r.mode.copy = "as-shown";
    const c = clip();
    const doc = `${FOREIGN} | ${NOT_YET} | ${NAME}`;
    expect(editorCopyHandler(r.deps)(c.ev, copyView(doc))).toBe(true);
    expect(c.set["text/plain"]).toBe(`${FOREIGN} | ${NOT_YET} | ${CLEAR}`);
    const f = rig(memoryWith(forgetPerson(sampleTable())));
    f.mode.copy = "as-shown";
    const c2 = clip();
    expect(editorCopyHandler(f.deps)(c2.ev, copyView(`a ${NAME}`))).toBe(false);
    expect(c2.set).toEqual({});
    expect(Notice.instances).toHaveLength(0);
  });

  it("nur unbekannte Platzhalter: nichts wird ersetzt, der Handler lässt CodeMirror kopieren", () => {
    const r = rig();
    r.mode.copy = "as-shown";
    const c = clip();
    expect(editorCopyHandler(r.deps)(c.ev, copyView(`${FOREIGN} ${NOT_YET}`))).toBe(false);
    expect(c.set).toEqual({});
  });

  it("in Inline-Code und im Codeblock der Auswahl bleibt der Platzhalter, wie im Bild", () => {
    const r = rig();
    r.mode.copy = "as-shown";
    const c = clip();
    // Der Zaun mit Tilde und Leerzeile entgeht der Absatz-Heuristik für Inline-Code: ihn sperrt allein die Zaunliste.
    const doc = [`Text \`${NAME}\` und ${NAME}`, "", "~~~", `code ${NAME}`, "", `mehr ${NAME}`, "~~~"].join("\n");
    editorCopyHandler(r.deps)(c.ev, copyView(doc));
    expect(c.set["text/plain"]).toBe([`Text \`${NAME}\` und ${CLEAR}`, "", "~~~", `code ${NAME}`, "", `mehr ${NAME}`, "~~~"].join("\n"));
  });

  it("Link-Ziel, Bild-URL, HTML-Attribut, nackte URL, Kommentar und Wikilink bleiben Platzhalter; Fließtext und mailto: werden Klartext (W1)", () => {
    const r = rig();
    r.mode.copy = "as-shown";
    const c = clip();
    const doc = [
      `Text ${NAME}`,
      `![x](https://evil.example/p?n=${NAME})`,
      `[l](https://evil.example/${NAME})`,
      `<img src="https://evil.example/${NAME}.png">`,
      `https://evil.example/u/${NAME}`,
      `<!-- ${NAME} -->`,
      `[[${NAME}]]`,
      `[m](mailto:${MAIL})`,
    ].join("\n");
    editorCopyHandler(r.deps)(c.ev, copyView(doc));
    expect(c.set["text/plain"]).toBe(doc.replace(`Text ${NAME}`, `Text ${CLEAR}`).replace(`mailto:${MAIL}`, "mailto:max@example.org"));
  });

  it("ein Code-Stück, das vor der Auswahl beginnt, schützt die Auswahl (Bereich über das ganze Dokument, W1)", () => {
    const r = rig();
    r.mode.copy = "as-shown";
    const c = clip();
    const doc = `\`vorn\nmitte ${NAME} hinten\` danach ${NAME}`;
    const from = doc.indexOf("mitte");
    const view = copyView(doc, EditorSelection.single(from, doc.length));
    editorCopyHandler(r.deps)(c.ev, view);
    expect(c.set["text/plain"]).toBe(`mitte ${NAME} hinten\` danach ${CLEAR}`);
  });

  it("ein Codeblock, der vor der Auswahl beginnt, schützt die Auswahlzeilen darin", () => {
    const r = rig();
    r.mode.copy = "as-shown";
    const c = clip();
    const doc = `\`\`\`\nerste\nzweite ${NAME}\n\`\`\`\n${NAME}`;
    const from = doc.indexOf("zweite");
    editorCopyHandler(r.deps)(c.ev, copyView(doc, EditorSelection.single(from, doc.length)));
    expect(c.set["text/plain"]).toBe(`zweite ${NAME}\n\`\`\`\n${CLEAR}`);
  });

  it("eine Auswahl, die einen Platzhalter nur teilweise umfasst, trägt nie einen Klartext-Rest", () => {
    const r = rig();
    r.mode.copy = "as-shown";
    const c = clip();
    const doc = `vorn ${NAME} hinten`;
    const from = doc.indexOf(NAME) + 4;
    const view = copyView(doc, EditorSelection.single(from, doc.length));
    expect(editorCopyHandler(r.deps)(c.ev, view)).toBe(false);
    expect(c.set).toEqual({});
    const state = EditorState.create({ doc, extensions: [modeField], selection: EditorSelection.single(0, doc.indexOf(NAME) + 4) });
    const p = plainRangeText(state, { from: 0, to: doc.indexOf(NAME) + 4 }, r.deps.options);
    expect(p).toEqual({ text: doc.slice(0, doc.indexOf(NAME) + 4), count: 0 });
  });

  it("mehrere Auswahlbereiche werden mit dem Zeilenumbruch des Zustands verbunden", () => {
    const r = rig();
    r.mode.copy = "as-shown";
    const c = clip();
    const doc = `${NAME} mitte ${MAIL}`;
    const view = copyView(doc, EditorSelection.create([EditorSelection.range(0, NAME.length), EditorSelection.range(doc.length - MAIL.length, doc.length)]));
    editorCopyHandler(r.deps)(c.ev, view);
    expect(c.set["text/plain"]).toBe(`${CLEAR}\nmax@example.org`);
  });

  it("ohne Auswahl (CodeMirror kopiert die Zeile) greift der Handler nicht", () => {
    const r = rig();
    r.mode.copy = "as-shown";
    const c = clip();
    expect(editorCopyHandler(r.deps)(c.ev, copyView(DOC, EditorSelection.single(2)))).toBe(false);
    expect(c.set).toEqual({});
  });

  it("Ausschneiden liefert dieselbe Fassung und löscht die Auswahl wie CodeMirror (delete.cut); Kopieren löscht nie", () => {
    const r = rig();
    r.mode.copy = "as-shown";
    const cut = clip("cut");
    const view = copyView(DOC);
    expect(editorCopyHandler(r.deps)(cut.ev, view)).toBe(true);
    expect(cut.set["text/plain"]).toBe(`Hallo ${CLEAR}, Mail max@example.org.`);
    expect(view.dispatch).toHaveBeenCalledWith({ changes: [{ from: 0, to: DOC.length }], scrollIntoView: true, userEvent: "delete.cut" });
    const copy = clip("copy");
    const view2 = copyView(DOC);
    editorCopyHandler(r.deps)(copy.ev, view2);
    expect(view2.dispatch).not.toHaveBeenCalled();
  });

  it("eine Auflösung, die wirft, bricht das Kopieren nicht: die Stelle bleibt Platzhalter", () => {
    const r = rig();
    r.mode.copy = "as-shown";
    const onError = vi.fn();
    r.deps = { ...r.deps, options: { ...r.deps.options, resolve: () => { throw new Error("boom"); }, onError } };
    const c = clip();
    expect(editorCopyHandler(r.deps)(c.ev, copyView(DOC))).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it("am echten Editor: ein copy-Ereignis auf dem Inhalt setzt die eingeblendete Fassung, in der Vorgabe nicht", () => {
    const r = rig();
    r.mode.copy = "as-shown";
    const v = mount(r, DOC);
    v.dispatch({ selection: EditorSelection.single(0, DOC.length) });
    const data = new DataTransfer();
    const ev = new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true });
    v.contentDOM.dispatchEvent(ev);
    expect(data.getData("text/plain")).toBe(`Hallo ${CLEAR}, Mail max@example.org.`);
    r.mode.copy = "placeholder";
    const data2 = new DataTransfer();
    v.contentDOM.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data2, bubbles: true, cancelable: true }));
    expect(data2.getData("text/plain")).not.toContain(CLEAR);
  });
});

describe("Codeblöcke: die Liste wird je Dokumentstand einmal gerechnet", () => {
  it("fenceSpans gibt für denselben Dokumentstand dieselbe Liste zurück (Cursor und Scrollen rechnen nicht neu), für einen geänderten eine neue", () => {
    const state = EditorState.create({ doc: "a\n```\nb\n```\nc", extensions: [modeField] });
    const first = fenceSpans(state);
    expect(first).toEqual([{ from: 2, to: 11 }]);
    const moved = state.update({ selection: EditorSelection.single(4) }).state;
    expect(fenceSpans(moved)).toBe(first);
    const edited = state.update({ changes: { from: 0, insert: "x" } }).state;
    expect(fenceSpans(edited)).not.toBe(first);
    expect(fenceSpans(edited)).toEqual([{ from: 3, to: 12 }]);
  });

  it("inFence trifft jede Stelle, die den Zaun berührt, und keine davor oder dahinter", () => {
    const state = EditorState.create({ doc: "a\n```\nb\n```\nc", extensions: [modeField] });
    expect(inFence(state, 0, 1)).toBe(false);
    expect(inFence(state, 6, 7)).toBe(true);
    expect(inFence(state, 1, 3)).toBe(true);
    expect(inFence(state, 11, 12)).toBe(false);
    expect(inFence(state, 12, 13)).toBe(false);
  });
});

/** Eine Notiz mit `lines` Zeilen und `placeholders` Platzhaltern im Text, dazu Zäune, in denen weitere stehen. */
function bigDoc(lines: number, placeholders: number): { doc: string; fenced: number } {
  const every = Math.floor(lines / placeholders);
  const out: string[] = [];
  let fenced = 0;
  for (let i = 0; i < lines; i++) {
    if (i % 500 === 100) { out.push("```", `code ${NAME}`, "```"); fenced += 1; i += 2; continue; }
    out.push(i % every === 0 && out.length > 0 ? `Zeile ${String(i)} mit ${NAME} im Text` : `Zeile ${String(i)} ohne Besonderheit`);
  }
  return { doc: out.join("\n"), fenced };
}

describe("Laufzeit", () => {
  it("die Berechnung der Zaun-Bereiche wächst linear mit dem Dokument", () => {
    const text = (n: number): string => "Absatz\n```\ncode\n```\n".repeat(Math.ceil(n / 20));
    const r = pruefeLinear((s: string) => fenceSpans(EditorState.create({ doc: s })), text);
    expect(r.linear, r.message).toBe(true);
  });

  it("10 000 Zeilen mit 500 Platzhaltern: ein Durchgang über das ganze Dokument liefert genau die Stellen außerhalb der Zäune, Zeit wird festgehalten", () => {
    const r = rig();
    const { doc, fenced } = bigDoc(10_000, 500);
    expect(fenced).toBeGreaterThan(5);
    const state = EditorState.create({ doc, extensions: [modeField] });
    const opts = { resolve: r.deps.options.resolve, shown: () => true, active, skip: inFence };
    const t0 = performance.now();
    const deco = textSwapEditorDecorations(state, opts);
    const ms = performance.now() - t0;
    const outside = doc.split("\n").filter((l) => l.includes(NAME) && !l.startsWith("code ")).length;
    expect(deco).toHaveLength(outside);
    expect(outside).toBeGreaterThanOrEqual(450);
    // Ein Tastendruck rechnet nur den sichtbaren Bereich (plus die Zaunliste des neuen Dokumentstands); hier die Zeit je Tippen am echten Editor, festgehalten und nicht eingefordert (Rechner unter Last).
    // Die Zaunliste je neuem Dokumentstand ist der Aufschlag des Plugins gegenüber dem Kit-Messwert (Tastendruck ändert das Dokument): Median über frische Zustände.
    const fenceMs: number[] = [];
    for (let i = 0; i < 15; i++) {
      const fresh = state.update({ changes: { from: 0, insert: "x".repeat(i + 1) } }).state;
      const f0 = performance.now();
      fenceSpans(fresh);
      fenceMs.push(performance.now() - f0);
    }
    fenceMs.sort((a, b) => a - b);
    const v = mount(r, doc);
    const t1 = performance.now();
    for (let i = 0; i < 20; i++) v.dispatch({ changes: { from: 0, insert: "x" } });
    const perKey = (performance.now() - t1) / 20;
    console.info(`live-preview Laufzeit: ganzes Dokument ${ms.toFixed(1)} ms (${String(deco.length)} Stellen), je Tastendruck ${perKey.toFixed(1)} ms (happy-dom), Zaunliste je neuem Dokumentstand Median ${(fenceMs[7] ?? 0).toFixed(2)} ms`);
    expect(doc.length).toBeGreaterThan(200_000);
  });
});
