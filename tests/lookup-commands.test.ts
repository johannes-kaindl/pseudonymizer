import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, Editor } from "obsidian";
import { Modal, Notice, makeFakeEditor } from "./vendor/kit/obsidian-mock";
import "../src/i18n/strings";
import { STRINGS } from "../src/i18n/strings";
import { setLang } from "../src/vendor/kit/i18n";
import { MemoryTable } from "../src/core/memory-table";
import type { LookupOutcome } from "../src/core/lookup";
import {
  lookupPlaceholderCommand, placeholderTextAt, searchPlaintextCommand, type LookupUi,
} from "../src/obsidian/lookup-commands";
import { LookupModal } from "../src/obsidian/lookup-modal";
import { conflictTable, forgetPerson, linkedTable, PERSON, PERSON_B, sampleTable } from "./helpers/table-fixtures";

const app = {} as App;
const lastNotice = (): string => String(Notice.instances[Notice.instances.length - 1]?.message ?? "");

function memoryWith(table = sampleTable()): MemoryTable {
  const m = new MemoryTable();
  m.open(table);
  return m;
}

function ui(over: Partial<LookupUi> = {}): LookupUi & { shown: LookupOutcome[]; queries: string[]; prompts: unknown[] } {
  const shown: LookupOutcome[] = [];
  const queries: string[] = [];
  const prompts: unknown[] = [];
  return {
    shown, queries, prompts,
    editor: () => null,
    prompt: (_app, opts) => { prompts.push(opts); return Promise.resolve(null); },
    show: (_app, outcome) => { shown.push(outcome); },
    openSearch: (_app, q) => { queries.push(q); return true; },
    ...over,
  };
}

const CONSOLE = ["log", "info", "warn", "error", "debug"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  setLang("en");
  Notice.instances.length = 0;
  Modal.__last = null;
  spies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  const printed = spies.reduce((n, s) => n + s.mock.calls.length, 0);
  spies.forEach((s) => s.mockRestore());
  expect(printed).toBe(0);
});

function editorWith(text: string, from: { line: number; ch: number }, to = from): Editor {
  const e = makeFakeEditor(text);
  e.setSelection(from, to);
  return e as unknown as Editor;
}

describe("placeholderTextAt", () => {
  it("takes the first placeholder of the selection, as written", () => {
    const e = editorWith(`Hallo person_${PERSON.toUpperCase()}_PHONE_2 und Person_${PERSON}`, { line: 0, ch: 0 }, { line: 0, ch: 80 });
    expect(placeholderTextAt(e)).toBe(`person_${PERSON.toUpperCase()}_PHONE_2`);
  });
  it("takes the placeholder under the cursor, also at its first and last character edge", () => {
    const text = `Hallo Person_${PERSON}_Mail, bis bald`;
    const start = "Hallo ".length;
    const end = start + `Person_${PERSON}_Mail`.length;
    for (const ch of [start, start + 5, end]) expect(placeholderTextAt(editorWith(text, { line: 0, ch })), String(ch)).toBe(`Person_${PERSON}_Mail`);
    expect(placeholderTextAt(editorWith(text, { line: 0, ch: start - 1 }))).toBeNull();
    expect(placeholderTextAt(editorWith(text, { line: 0, ch: end + 1 }))).toBeNull();
  });
  it("reads the line of the cursor", () => {
    expect(placeholderTextAt(editorWith(`eins\nzwei Person_${PERSON}`, { line: 1, ch: 6 }))).toBe(`Person_${PERSON}`);
  });
  it("is null with no placeholder in the selection, even if there is one on the line", () => {
    expect(placeholderTextAt(editorWith(`Max Person_${PERSON}`, { line: 0, ch: 0 }, { line: 0, ch: 3 }))).toBeNull();
  });
  it("does not read Person_<id>_Mailbox", () => {
    expect(placeholderTextAt(editorWith(`Person_${PERSON}_Mailbox`, { line: 0, ch: 3 }))).toBeNull();
  });
});

describe("lookupPlaceholderCommand", () => {
  it("shows the outcome for the placeholder in the selection without asking", async () => {
    const u = ui({ editor: () => editorWith(`Person_${PERSON}_Mail`, { line: 0, ch: 0 }, { line: 0, ch: 40 }) });
    await lookupPlaceholderCommand({ app, memory: memoryWith() }, u);
    expect(u.prompts).toHaveLength(0);
    expect(u.shown).toHaveLength(1);
    expect(u.shown[0]).toMatchObject({ status: "known", value: "max@example.org" });
  });

  it("asks for the placeholder when the editor offers none, then shows it", async () => {
    const u = ui({ prompt: (_a, o) => { u.prompts.push(o); return Promise.resolve(`Person_${PERSON}_2`); } });
    await lookupPlaceholderCommand({ app, memory: memoryWith() }, u);
    expect(u.prompts).toHaveLength(1);
    expect(u.shown[0]).toMatchObject({ status: "known", value: "Max" });
  });

  it("the question refuses text that is no placeholder (the dialog stays open with the reason)", async () => {
    const u = ui();
    await lookupPlaceholderCommand({ app, memory: memoryWith() }, u);
    const validate = (u.prompts[0] as { validate: (v: string) => string | null }).validate;
    expect(validate(`Person_${PERSON}`)).toBeNull();
    expect(validate("Max")).toBe(STRINGS.en["notice.lookup.invalid"]);
    expect(validate(`Person_${PERSON}_Mailbox`)).toBe(STRINGS.en["notice.lookup.invalid"]);
  });

  it("does nothing when the question is cancelled", async () => {
    const u = ui();
    await lookupPlaceholderCommand({ app, memory: memoryWith() }, u);
    expect(u.shown).toEqual([]);
    expect(Notice.instances).toHaveLength(0);
  });

  it("shows forgotten and conflict as outcomes, not as errors", async () => {
    const a = ui({ prompt: () => Promise.resolve(`Person_${PERSON}`) });
    await lookupPlaceholderCommand({ app, memory: memoryWith(forgetPerson(sampleTable())) }, a);
    expect(a.shown[0]).toMatchObject({ status: "forgotten" });
    const b = ui({ prompt: () => Promise.resolve(`Person_${PERSON}_Mail_2`) });
    await lookupPlaceholderCommand({ app, memory: memoryWith(conflictTable()) }, b);
    expect(b.shown[0]).toMatchObject({ status: "conflict", values: ["max.a@example.org", "max.b@example.org"] });
  });

  it("without a readable table it says why and shows nothing", async () => {
    const u = ui({ prompt: () => Promise.resolve(`Person_${PERSON}`) });
    await lookupPlaceholderCommand({ app, memory: new MemoryTable() }, u);
    expect(lastNotice()).toBe(STRINGS.en["notice.notSetUp"]);
    const locked = new MemoryTable();
    locked.lock("table-missing");
    await lookupPlaceholderCommand({ app, memory: locked }, u);
    expect(lastNotice()).toBe(STRINGS.en["notice.locked"]);
    expect(u.shown).toEqual([]);
  });

  it("a failure inside says so without the text of the error", async () => {
    const u = ui({ prompt: () => Promise.reject(new Error("Max Mustermann")) });
    await lookupPlaceholderCommand({ app, memory: memoryWith() }, u);
    expect(lastNotice()).toBe(STRINGS.en["notice.failed"]);
    expect(lastNotice()).not.toContain("Max");
  });
});

describe("searchPlaintextCommand", () => {
  it("opens the search with the IDs of every merged entry and never with the name", async () => {
    const u = ui({ prompt: () => Promise.resolve("max mustermann") });
    await searchPlaintextCommand({ app, memory: memoryWith(linkedTable()) }, u);
    expect(u.queries).toEqual([`"${PERSON}" OR "${PERSON_B}"`]);
    expect(JSON.stringify(u.queries)).not.toMatch(/mustermann/i);
  });

  it("asks with a dialog titled like the command", async () => {
    const u = ui();
    await searchPlaintextCommand({ app, memory: memoryWith() }, u);
    expect(u.prompts[0]).toMatchObject({ title: STRINGS.en["modal.search.title"], okLabel: STRINGS.en["modal.search.ok"], cancelLabel: STRINGS.en["modal.cancel"] });
    expect(u.queries).toEqual([]);
  });

  it("says so when no entry has the value, and does not repeat the value", async () => {
    const u = ui({ prompt: () => Promise.resolve("Erika Musterfrau") });
    await searchPlaintextCommand({ app, memory: memoryWith() }, u);
    expect(lastNotice()).toBe(STRINGS.en["notice.search.noMatch"]);
    expect(u.queries).toEqual([]);
  });

  it("a forgotten person is not found", async () => {
    const u = ui({ prompt: () => Promise.resolve("Max Mustermann") });
    await searchPlaintextCommand({ app, memory: memoryWith(forgetPerson(sampleTable())) }, u);
    expect(lastNotice()).toBe(STRINGS.en["notice.search.noMatch"]);
  });

  it("when Obsidian's search cannot be opened it says so and names the IDs to search for", async () => {
    const u = ui({ prompt: () => Promise.resolve("Max Mustermann"), openSearch: () => false });
    await searchPlaintextCommand({ app, memory: memoryWith() }, u);
    expect(lastNotice()).toBe(STRINGS.en["notice.search.unavailable"].replace("{0}", `"${PERSON}"`));
    expect(lastNotice()).not.toMatch(/mustermann/i);
  });

  it("does nothing when the question is cancelled; without a table it says why", async () => {
    const u = ui();
    await searchPlaintextCommand({ app, memory: memoryWith() }, u);
    expect(Notice.instances).toHaveLength(0);
    await searchPlaintextCommand({ app, memory: new MemoryTable() }, u);
    expect(lastNotice()).toBe(STRINGS.en["notice.notSetUp"]);
  });
});

describe("LookupModal", () => {
  function render(outcome: LookupOutcome): string {
    const modal = new LookupModal(app, outcome);
    modal.open();
    return String((modal.contentEl as { textContent: string }).textContent);
  }

  it("known: shows value, kind and every form; conflict: both values; forgotten and unknown: the reason and no value", () => {
    const known = render({ status: "known", placeholder: `Person_${PERSON}_Mail`, value: "max@example.org", kind: "person", field: "mail", forms: [{ placeholder: `Person_${PERSON}`, field: null, value: "Max Mustermann", conflict: false }] });
    expect(known).toContain("max@example.org");
    expect(known).toContain("Max Mustermann");
    expect(known).toContain(STRINGS.en["modal.lookup.kind.person"]);
    const conflict = render({ status: "conflict", placeholder: `Person_${PERSON}_Mail_2`, values: ["max.a@example.org", "max.b@example.org"], kind: "person", field: "mail", forms: [] });
    expect(conflict).toContain("max.a@example.org");
    expect(conflict).toContain("max.b@example.org");
    expect(conflict).toContain(STRINGS.en["modal.lookup.conflictText"]);
    expect(render({ status: "forgotten", placeholder: `Person_${PERSON}` })).toContain(STRINGS.en["modal.lookup.forgottenText"]);
    expect(render({ status: "unknown", placeholder: `Person_${PERSON}`, reason: "no-entry" })).toContain(STRINGS.en["modal.lookup.unknown.no-entry"]);
  });

  it("state is never colour alone: the status line has a text", () => {
    expect(render({ status: "forgotten", placeholder: `Person_${PERSON}` })).toContain(STRINGS.en["modal.lookup.forgotten"]);
  });
});
