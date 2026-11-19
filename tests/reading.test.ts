// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, Plugin } from "obsidian";
import { Notice } from "./vendor/kit/obsidian-mock";
import "../src/i18n/strings";
import { setLang } from "../src/vendor/kit/i18n";
import { MemoryTable } from "../src/core/memory-table";
import { createSwapResolver, setUpReading, swapOptions, swapTitle } from "../src/obsidian/reading";
import { openDocuments } from "../src/obsidian/windows";
import { findPlaceholders } from "../src/vendor/kit/placeholder";
import { tableAddEntry } from "../src/vendor/kit/placeholder-table";
import { conflictTable, forgetPerson, must, PERSON, PERSON_B, sampleTable, withValue } from "./helpers/table-fixtures";
import { installDomGlobals, root } from "./helpers/dom";

beforeAll(() => { installDomGlobals(); });
beforeEach(() => { setLang("en"); Notice.instances.length = 0; });
afterEach(() => { document.body.innerHTML = ""; });

const NAME = `Person_${PERSON}`;
const MAIL = `Person_${PERSON}_Mail`;
const PHONE = `Person_${PERSON}_Telefon`;
const FOREIGN = `Person_${PERSON_B}`;
const NOT_YET = `Person_${PERSON}_Mail_5`;
const CONFLICT = `Person_${PERSON}_Mail_2`;
const CLEAR = ["Max Mustermann", "max@example.org", "030 1234567", "Max"];

const ph = (raw: string) => {
  const p = findPlaceholders(raw)[0];
  if (p === undefined) throw new Error(`not a placeholder: ${raw}`);
  return p;
};

function memoryWith(table = sampleTable()): MemoryTable {
  const m = new MemoryTable();
  m.open(table);
  return m;
}

describe("createSwapResolver: was die Lesesicht je Zustand einblendet", () => {
  it("bereit: bekannt gibt den Klartext, vergessen die Marke, Fremdes bleibt Text", () => {
    const m = memoryWith();
    const r = createSwapResolver(m);
    expect(r(ph(NAME))).toEqual({ status: "known", value: "Max Mustermann" });
    expect(r(ph(MAIL))).toEqual({ status: "known", value: "max@example.org" });
    expect(r(ph(FOREIGN))).toBeUndefined();
    m.open(forgetPerson(sampleTable()));
    expect(r(ph(NAME))).toEqual({ status: "forgotten" });
  });

  it("ein Wert, der auf diesem Gerät noch fehlt, ist nicht lesbar und nennt den Grund (Gerät hat noch nicht nachgezogen)", () => {
    const r = createSwapResolver(memoryWith());
    const res = r(ph(NOT_YET));
    expect(res?.status).toBe("unreadable");
    expect(res !== undefined && res.status === "unreadable" ? res.reason : "").toMatch(/may not have synced/);
  });

  it("ein Konflikt zeigt keinen der beiden Werte", () => {
    const r = createSwapResolver(memoryWith(conflictTable()));
    const res = r(ph(CONFLICT));
    expect(res?.status).toBe("unreadable");
    expect(JSON.stringify(res)).not.toMatch(/max\.[ab]@example/);
  });

  it("gesperrt: jeder Platzhalter ist nicht lesbar mit dem Grund „gesperrt“; nicht eingerichtet: nichts wird angefasst", () => {
    const m = memoryWith();
    const r = createSwapResolver(m);
    m.lock("table-missing");
    const res = r(ph(NAME));
    expect(res).toEqual({ status: "unreadable", reason: "locked on this device" });
    m.reset();
    expect(r(ph(NAME))).toBeUndefined();
  });

  it("kein Grund und kein Tooltip trägt je einen Klartext", () => {
    const m = memoryWith();
    const r = createSwapResolver(m);
    const out: string[] = [];
    for (const raw of [NAME, MAIL, PHONE, NOT_YET, FOREIGN]) out.push(JSON.stringify(r(ph(raw))?.status === "unreadable" ? r(ph(raw)) : null));
    m.lock("key-replaced");
    out.push(JSON.stringify(r(ph(NAME))));
    for (const s of out) for (const c of CLEAR) expect(s).not.toContain(c);
    expect(swapTitle({ raw: NAME, state: "forgotten" })).toBe(`${NAME} — forgotten`);
    expect(swapTitle({ raw: NAME, state: "shown" })).toBe(NAME);
    expect(swapTitle({ raw: NAME, state: "unreadable", reason: "locked on this device" })).toBe(`${NAME} — locked on this device`);
  });
});

/** Ein Plugin- und App-Double: der Postprozessor, die Abmelder und die Blätter in weiteren Fenstern. */
function harness(memory: MemoryTable, shown = { on: true }) {
  let post: ((el: HTMLElement) => void) | null = null;
    const listeners = new Set<() => void>();
  const leaves: { view: { containerEl: { ownerDocument: Document } } }[] = [];
  const app = {
    workspace: {
      containerEl: { ownerDocument: document },
      iterateAllLeaves: (cb: (l: unknown) => void) => { leaves.forEach(cb); },
    },
  } as unknown as Pick<App, "workspace">;
  const plugin = {
    registerMarkdownPostProcessor: (fn: (el: HTMLElement) => void) => { post = fn; return fn; },
  } as unknown as Pick<Plugin, "registerMarkdownPostProcessor">;
  const options = swapOptions(memory, () => shown.on);
  const reading = setUpReading(plugin, { app, options, onChange: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; } });
  return {
    reading, shown, app, leaves,
    render: (el: HTMLElement) => { post?.(el); },
    emit: () => { for (const l of [...listeners]) l(); },
    popout: (): Document => {
      const doc = document.implementation.createHTMLDocument("popout");
      leaves.push({ view: { containerEl: { ownerDocument: doc } } });
      return doc;
    },
  };
}

describe("Lesesicht: Postprozessor", () => {
  it("blendet im Fließtext den Klartext ein, mit dem Platzhalter im Tooltip; der Rest bleibt Text", () => {
    const h = harness(memoryWith());
    const el = root(`<p>Hallo ${NAME}, Rückruf unter ${PHONE}.</p>`);
    h.render(el);
    const spans = Array.from(el.querySelectorAll<HTMLElement>(".okit-swap"));
    expect(spans.map((s) => s.textContent)).toEqual(["Max Mustermann", "030 1234567"]);
    expect(spans[0]?.getAttribute("title")).toBe(NAME);
    expect(spans[0]?.classList.contains("is-shown")).toBe(true);
    expect(el.textContent).toBe("Hallo Max Mustermann, Rückruf unter 030 1234567.");
  });

  it("in href, src, title, alt, Code und pre bleibt der Platzhalter, und kein Attribut trägt Klartext (Review-Fokus 2)", () => {
    const h = harness(memoryWith());
    const el = root(
      `<p><a href="https://example.org/${MAIL}" title="${NAME}">Link ${NAME}</a> <img src="https://example.org/${NAME}.png" alt="${NAME}"> ` +
      `<code>${NAME}</code></p><pre>${NAME}</pre>`,
    );
    h.render(el);
    expect(el.querySelector("a")?.getAttribute("href")).toBe(`https://example.org/${MAIL}`);
    expect(el.querySelector("a")?.getAttribute("title")).toBe(NAME);
    expect(el.querySelector("img")?.getAttribute("src")).toBe(`https://example.org/${NAME}.png`);
    expect(el.querySelector("img")?.getAttribute("alt")).toBe(NAME);
    expect(el.querySelector("code")?.textContent).toBe(NAME);
    expect(el.querySelector("pre")?.textContent).toBe(NAME);
    expect(el.querySelector("a")?.textContent).toBe("Link Max Mustermann"); // Anzeigetext des Links ja, Ziel nein
    // Klartext steht nur als Text des Ersatz-Elements, nirgends in einem Attribut.
    for (const node of Array.from(el.querySelectorAll("*"))) {
      for (const a of Array.from(node.attributes)) for (const c of CLEAR) expect(a.value, `${node.tagName}@${a.name}`).not.toContain(c);
    }
  });

  it("ein vergessener Platzhalter ist als vergessen gekennzeichnet (Klasse und Tooltip), ein noch nicht lesbarer nennt den Grund", () => {
    const withB = withValue(must(tableAddEntry(sampleTable(), PERSON_B, "person")), PERSON_B, null, "Berta Beispiel");
    const h = harness(memoryWith(forgetPerson(withB, PERSON_B)));
    const el = root(`<p>${FOREIGN} und ${NOT_YET}</p>`);
    h.render(el);
    const [forgotten, pending] = Array.from(el.querySelectorAll<HTMLElement>(".okit-swap"));
    expect(forgotten?.classList.contains("is-forgotten")).toBe(true);
    expect(forgotten?.textContent).toBe(FOREIGN);
    expect(forgotten?.getAttribute("title")).toBe(`${FOREIGN} — forgotten`);
    expect(pending?.classList.contains("is-unreadable")).toBe(true);
    expect(pending?.getAttribute("title")).toMatch(/may not have synced/);
  });
});

describe("Lesesicht: Auffrischen ohne Neuöffnen", () => {
  it("der Umschalter wechselt jede sichtbare Stelle, die Knoten bleiben (kein Neuaufbau)", () => {
    const h = harness(memoryWith());
    const el = root(`<p>${NAME} / ${MAIL}</p>`);
    h.render(el);
    const before = Array.from(el.querySelectorAll(".okit-swap"));
    h.shown.on = false;
    h.emit();
    const after = Array.from(el.querySelectorAll(".okit-swap"));
    expect(after).toEqual(before);
    expect(after.map((s) => s.textContent)).toEqual([NAME, MAIL]);
    h.shown.on = true;
    h.emit();
    expect(after.map((s) => s.textContent)).toEqual(["Max Mustermann", "max@example.org"]);
  });

  it("Sperren schaltet gezeigte Stellen auf „nicht lesbar“ und nimmt den Klartext weg; Entsperren bringt ihn zurück", () => {
    const m = memoryWith();
    const h = harness(m);
    const el = root(`<p>${NAME}</p>`);
    h.render(el);
    m.lock("key-replaced");
    h.emit();
    const span = el.querySelector<HTMLElement>(".okit-swap");
    expect(span?.textContent).toBe(NAME);
    expect(span?.classList.contains("is-unreadable")).toBe(true);
    expect(el.innerHTML).not.toContain("Mustermann");
    m.open(sampleTable());
    h.emit();
    expect(span?.textContent).toBe("Max Mustermann");
  });

  it("eine per Sync angekommene Vergessen-Marke lässt den Klartext einer vergessenen Person nicht stehen", () => {
    const m = memoryWith();
    const h = harness(m);
    const el = root(`<p>${NAME} ${MAIL}</p>`);
    h.render(el);
    expect(el.textContent).toContain("Max Mustermann");
    m.open(forgetPerson(sampleTable())); // die geänderte Tabelle nach dem Auffrischen
    h.emit();
    expect(el.textContent).toBe(`${NAME} ${MAIL}`);
    expect(el.innerHTML).not.toMatch(/Mustermann|max@example/);
    expect(Array.from(el.querySelectorAll(".okit-swap")).every((s) => s.classList.contains("is-forgotten"))).toBe(true);
  });

  it("frischt jedes offene Fenster auf, auch ein Popout (B2), und ruft danach den Haken für die Live Preview", () => {
    const m = memoryWith();
    const h = harness(m);
    const pop = h.popout();
    const mainEl = root(`<p>${NAME}</p>`);
    const popEl = root(`<p>${NAME}</p>`, pop);
    h.render(mainEl);
    h.render(popEl);
    expect(openDocuments(h.app)).toHaveLength(2);
    const hook = vi.fn();
    h.reading.onRefresh(hook);
    m.open(forgetPerson(sampleTable()));
    h.emit();
    expect(mainEl.querySelector(".okit-swap")?.classList.contains("is-forgotten")).toBe(true);
    expect(popEl.querySelector(".okit-swap")?.classList.contains("is-forgotten")).toBe(true);
    expect(popEl.innerHTML).not.toContain("Mustermann");
    expect(hook).toHaveBeenCalledTimes(1);
    expect(h.reading.refresh()).toBeGreaterThanOrEqual(2); // das Register des Kits zeichnet auch ausgehängte Stellen früherer Tests mit
  });

  it("beim Entladen des Plugins geht der Klartext aus jeder gezeigten Stelle", () => {
    const h = harness(memoryWith());
    const el = root(`<p>${NAME}</p>`);
    h.render(el);
    expect(el.textContent).toBe("Max Mustermann");
    h.reading.dispose();
    expect(el.textContent).toBe(NAME);
    expect(el.innerHTML).not.toContain("Mustermann");
    h.shown.on = true;
    h.emit(); // abgemeldet: kein Auffrischen mehr
    expect(el.textContent).toBe(NAME);
  });

  it("ein Wurf der Auflösung lässt die Stelle Text und meldet es einmal ohne Inhalt", () => {
    const m = memoryWith();
    vi.spyOn(m, "table").mockImplementation(() => { throw new Error("Max Mustermann kaputt"); });
    const h = harness(m);
    const el = root(`<p>${NAME} ${MAIL}</p>`);
    h.render(el);
    expect(el.textContent).toBe(`${NAME} ${MAIL}`);
    expect(Notice.instances).toHaveLength(1);
    expect(String(Notice.instances[0]?.message)).not.toContain("Mustermann");
  });
});
