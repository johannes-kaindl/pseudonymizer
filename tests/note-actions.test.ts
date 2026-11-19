// „Auswahl pseudonymisieren“ und „Diese Notiz pseudonymisieren“ (Bauplan Aufgabe 15, Spec 8.9, 11.1, 11.2). Echte Engine und API mit einer Tabelle im Arbeitsspeicher, Notizen und Fenster sind Stellvertreter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/core/api";
import { MemoryTable } from "../src/core/memory-table";
import { splitNote } from "../src/core/note-parts";
import type { PersonOption } from "../src/core/forget-plan";
import type { CandidateKind } from "../src/core/transform";
import { PseudonymizerEngine, type ReviewFn } from "../src/obsidian/engine";
import { pseudonymizeNote, pseudonymizeSelection, type NoteHost, type OwnerPick, type SelectionInfo } from "../src/obsidian/note-actions";
import type { PersistResult, TableChange } from "../src/obsidian/table-store";
import type { WritePorts } from "../src/vendor/kit/block-writer";
import { placeholderIdFromBytes } from "../src/vendor/kit/placeholder";
import { tableAddEntry, tableFindValue, type PlaceholderTable } from "../src/vendor/kit/placeholder-table";
import { pruefeLinearFuzz } from "./vendor/kit/linear-probe";
import { PERSON, must, sampleTable, withValue } from "./helpers/table-fixtures";

const CONSOLE = ["log", "info", "warn", "error", "debug", "trace"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => { spies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined)); });
afterEach(() => {
  const printed = spies.reduce((n, s) => n + s.mock.calls.length, 0);
  spies.forEach((s) => s.mockRestore());
  expect(printed).toBe(0);
});

const P = `Person_${PERSON}`;
const PATH = "Notizen/Rückfrage.md";

interface Rig {
  host: NoteHost;
  files: Map<string, string>;
  /** Reihenfolge der Schreibvorgänge: `persist` (Tabelle) und `write` (Notiz). */
  log: string[];
  notices: { key: string; args: (string | number)[] }[];
  memory: MemoryTable;
  table(): PlaceholderTable;
  transformCalls(): number;
  state: { selection: SelectionInfo | null; failPersist: boolean; kind: CandidateKind | null; owner: OwnerPick | null; review: ReviewFn; ownerOptions: PersonOption[] | null; beforeOwner: () => void; beforeReview: () => void };
}

function rig(note: string, base: PlaceholderTable = sampleTable()): Rig {
  const memory = new MemoryTable();
  memory.open(base, { language: "de" });
  const files = new Map<string, string>([[PATH, note]]);
  const log: string[] = [];
  const notices: Rig["notices"] = [];
  const state: Rig["state"] = {
    selection: null, failPersist: false, kind: "person", owner: { kind: "new" }, ownerOptions: null,
    review: () => Promise.resolve({ answers: new Map() }), beforeOwner: () => undefined, beforeReview: () => undefined,
  };
  const ports: WritePorts = {
    editorFor: () => null,
    vault: {
      read: (p) => { const v = files.get(p); return v === undefined ? Promise.reject(new Error("nf")) : Promise.resolve(v); },
      process: (p, fn) => {
        const cur = files.get(p);
        if (cur === undefined) return Promise.reject(new Error("nf"));
        const next = fn(cur);
        if (next !== cur) { files.set(p, next); log.push("write"); }
        return Promise.resolve();
      },
    },
  };
  const store = {
    refresh: () => Promise.resolve(),
    persist: (change?: TableChange): Promise<PersistResult> => {
      log.push("persist");
      if (state.failPersist) return Promise.resolve({ error: "storage-failed" });
      const cur = memory.table() as PlaceholderTable;
      const next = typeof change === "function" ? change(cur) : (change ?? cur);
      memory.open(next, { language: "de" });
      return Promise.resolve();
    },
  };
  let n = 0;
  const bytes = (k: number): Uint8Array => Uint8Array.from({ length: 7 }, (_, i) => (i === 0 ? k : 0));
  const random = (): Uint8Array => bytes(++n);
  const engine = new PseudonymizerEngine(memory, () => store, { random, review: (c, ctx) => { state.beforeReview(); return state.review(c, ctx); } });
  const api = createApi(() => engine);
  let calls = 0;
  const host: NoteHost = {
    memory,
    api: { transform: (req) => { calls++; return api.transform(req); } },
    persist: (c) => store.persist(c),
    ports: () => ports,
    selection: () => state.selection,
    activeNote: () => ({ path: PATH, name: "Rückfrage" }),
    ui: {
      chooseKind: () => Promise.resolve(state.kind),
      chooseOwner: (_kind, options) => { state.ownerOptions = [...options]; state.beforeOwner(); return Promise.resolve(state.owner); },
      notify: (key, ...args) => { notices.push({ key, args }); },
    },
    changed: () => undefined,
    random,
  };
  return { host, files, log, notices, memory, table: () => memory.table() as PlaceholderTable, transformCalls: () => calls, state };
}

const keys = (r: Rig): string[] => r.notices.map((x) => x.key);
const select = (note: string, value: string): SelectionInfo => {
  const from = note.indexOf(value);
  return { path: PATH, from, to: from + value.length, text: value };
};

describe("Auswahl pseudonymisieren", () => {
  const NOTE = "Hallo, Erika Musterfrau schrieb gestern.\n";

  it("schreibt zuerst die Tabelle, ersetzt erst danach die Auswahl", async () => {
    const r = rig(NOTE);
    r.state.selection = select(NOTE, "Erika Musterfrau");
    await pseudonymizeSelection(r.host);
    expect(r.log).toEqual(["persist", "write"]);
    const found = tableFindValue(r.table(), null, "Erika Musterfrau");
    expect(found).toBeDefined();
    expect(r.files.get(PATH)).toBe(`Hallo, ${P.replace(PERSON, placeholderIdFromBytes(Uint8Array.from([1, 0, 0, 0, 0, 0, 0])) ?? "")} schrieb gestern.\n`);
    expect(keys(r)).toEqual(["notice.selection.done"]);
  });

  it("fragt nach Art und Person; ein Name ist nur zu Personen und Organisationen wählbar, ein Wert zu jedem Eintrag", async () => {
    const withNone = withValue(must(tableAddEntry(sampleTable(), "q7d2w8n4tz", null)), "q7d2w8n4tz", "mail", "info@example.org");
    const a = rig(NOTE, withNone);
    a.state.selection = select(NOTE, "Erika Musterfrau");
    await pseudonymizeSelection(a.host);
    expect(a.state.ownerOptions?.map((o) => o.kind)).toEqual(["person"]);
    const b = rig("Mail: erika@example.org\n", withNone);
    b.state.selection = select("Mail: erika@example.org\n", "erika@example.org");
    b.state.kind = "mail";
    await pseudonymizeSelection(b.host);
    expect(b.state.ownerOptions?.map((o) => o.kind).sort()).toEqual(["none", "person"]);
  });

  it("ein Wert kann einer vorhandenen Person gehören: sein Platzhalter hängt an ihr", async () => {
    const note = "Mail: erika@example.org\n";
    const r = rig(note);
    r.state.selection = select(note, "erika@example.org");
    r.state.kind = "mail";
    r.state.owner = { kind: "entry", id: PERSON };
    await pseudonymizeSelection(r.host);
    expect(r.files.get(PATH)).toBe(`Mail: ${P}_Mail_2\n`);
    expect(r.log).toEqual(["persist", "write"]);
  });

  it("ein weiterer Name einer vorhandenen Person bekommt deren Platzhalter", async () => {
    const note = "Hallo, M. Mustermann.\n";
    const r = rig(note);
    r.state.selection = select(note, "M. Mustermann");
    r.state.owner = { kind: "entry", id: PERSON };
    await pseudonymizeSelection(r.host);
    expect(r.files.get(PATH)).toBe(`Hallo, ${P}_3.\n`);
  });

  it("scheitert das Schreiben der Tabelle, bleibt die Notiz byte-gleich, und die Meldung nennt keinen Klartext", async () => {
    const r = rig(NOTE);
    r.state.selection = select(NOTE, "Erika Musterfrau");
    r.state.failPersist = true;
    await pseudonymizeSelection(r.host);
    expect(r.files.get(PATH)).toBe(NOTE);
    expect(r.log).toEqual(["persist"]);
    expect(keys(r)).toEqual(["notice.selection.storage"]);
    expect(JSON.stringify(r.notices)).not.toContain("Erika");
  });

  it("hat sich die Notiz inzwischen geändert, wird nichts geschrieben und eine Notice sagt es (der Tabelleneintrag bleibt)", async () => {
    const r = rig(NOTE);
    r.state.selection = select(NOTE, "Erika Musterfrau");
    r.state.beforeOwner = () => { r.files.set(PATH, `Neu: ${NOTE}`); };
    await pseudonymizeSelection(r.host);
    expect(r.files.get(PATH)).toBe(`Neu: ${NOTE}`);
    expect(r.log).toEqual(["persist"]);
    expect(keys(r)).toEqual(["notice.selection.moved"]);
    expect(tableFindValue(r.table(), null, "Erika Musterfrau")).toBeDefined();
  });

  it("Abbruch in der Art oder der Person ändert weder Tabelle noch Notiz", async () => {
    const a = rig(NOTE);
    a.state.selection = select(NOTE, "Erika Musterfrau");
    a.state.kind = null;
    await pseudonymizeSelection(a.host);
    const b = rig(NOTE);
    b.state.selection = select(NOTE, "Erika Musterfrau");
    b.state.owner = null;
    await pseudonymizeSelection(b.host);
    for (const r of [a, b]) {
      expect(r.log).toEqual([]);
      expect(r.files.get(PATH)).toBe(NOTE);
    }
  });

  it("verweigert eine leere Auswahl, einen Platzhalter und eine Auswahl mitten im Wort, ohne zu fragen", async () => {
    const r = rig("Maxim und Max.\nPerson_k3x9m2ab7q\n");
    const asked = vi.spyOn(r.host.ui, "chooseKind");
    r.state.selection = null;
    await pseudonymizeSelection(r.host);
    r.state.selection = select("Maxim und Max.\nPerson_k3x9m2ab7q\n", "Person_k3x9m2ab7q");
    await pseudonymizeSelection(r.host);
    r.state.selection = { path: PATH, from: 0, to: 3, text: "Max" };
    await pseudonymizeSelection(r.host);
    expect(keys(r)).toEqual(["notice.selection.empty", "notice.selection.placeholder", "notice.selection.boundary"]);
    expect(asked).not.toHaveBeenCalled();
    expect(r.log).toEqual([]);
  });

  it("ohne Tabelle sagt eine Notice den Grund", async () => {
    const r = rig(NOTE);
    r.memory.lock("table-missing");
    r.state.selection = select(NOTE, "Erika Musterfrau");
    await pseudonymizeSelection(r.host);
    expect(keys(r)).toEqual(["notice.locked"]);
    expect(r.log).toEqual([]);
  });
});

describe("Diese Notiz pseudonymisieren", () => {
  const NOTE = [
    "---",
    "from: Max Mustermann <max@example.org>",
    'up: "[[Max Mustermann]]"',
    "created: 2026-11-19",
    "cc:",
    "  - Max Mustermann",
    "tags: [rueckfrage, angebot]",
    "---",
    "Hallo Max Mustermann,",
    "",
    "Ihre Nummer 030 1234567 ist notiert.",
    "",
  ].join("\n");

  it("schreibt Frontmatter und Text in genau einem swapNote; Werte ungequotet, fremde Zeilen byte-gleich", async () => {
    const r = rig(NOTE);
    await pseudonymizeNote(r.host);
    expect(r.log).toEqual(["write"]);
    expect(r.files.get(PATH)).toBe([
      "---",
      `from: ${P} <${P}_Mail>`,
      'up: "[[Max Mustermann]]"',
      "created: 2026-11-19",
      "cc:",
      `  - ${P}`,
      "tags: [rueckfrage, angebot]",
      "---",
      `Hallo ${P},`,
      "",
      `Ihre Nummer ${P}_Telefon ist notiert.`,
      "",
    ].join("\n"));
    expect(r.files.get(PATH)).not.toContain('"Person_');
    expect(keys(r)).toEqual(["notice.note.done"]);
    expect(r.notices[0]?.args[0]).toBe(5);
  });

  it("eine Eigenschaft up: \"[[Max Mustermann]]\" bleibt, auch wenn sie die einzige Fundstelle trägt", async () => {
    const note = '---\nup: "[[Max Mustermann]]"\n---\nNichts zu tun.\n';
    const r = rig(note);
    await pseudonymizeNote(r.host);
    expect(r.files.get(PATH)).toBe(note);
    expect(r.log).toEqual([]);
    expect(keys(r)).toEqual(["notice.note.none"]);
  });

  it("eine Notiz mit mail_id wird nicht angefasst; die Notice verweist auf mailstone, transform wird nicht gerufen", async () => {
    const note = "---\nmail_id: abc123\nfrom: Max Mustermann <max@example.org>\n---\nHallo Max Mustermann\n";
    const r = rig(note);
    await pseudonymizeNote(r.host);
    expect(r.files.get(PATH)).toBe(note);
    expect(keys(r)).toEqual(["notice.note.mailstone"]);
    expect(r.transformCalls()).toBe(0);
    expect(r.log).toEqual([]);
  });

  it("neue Fundstellen gehen durchs Prüffenster; übernehmen ersetzt Eigenschaft und Text mit demselben Platzhalter, in einem Schreibvorgang der Notiz", async () => {
    const note = "---\ncontact: erika@example.org\n---\nBitte an erika@example.org schreiben.\n";
    const r = rig(note);
    let opened = 0;
    r.state.review = () => { opened++; return Promise.resolve({ answers: new Map() }); };
    await pseudonymizeNote(r.host);
    expect(opened).toBe(1);
    const text = r.files.get(PATH) ?? "";
    const id = /^contact: (Mail_\w+)$/m.exec(text)?.[1];
    expect(id).toBeDefined();
    expect(text).toBe(`---\ncontact: ${id}\n---\nBitte an ${id} schreiben.\n`);
    expect(r.log).toEqual(["persist", "write"]);
  });

  it("Abbruch im Prüffenster: Notiz byte-gleich, Tabelle unberührt, Notice ohne Klartext", async () => {
    const note = "---\ncontact: erika@example.org\n---\nBitte an erika@example.org schreiben.\n";
    const r = rig(note);
    const before = r.table();
    r.state.review = () => Promise.resolve(null);
    await pseudonymizeNote(r.host);
    expect(r.files.get(PATH)).toBe(note);
    expect(r.table()).toBe(before);
    expect(r.log).toEqual([]);
    expect(keys(r)).toEqual(["notice.note.cancelled"]);
    expect(JSON.stringify(r.notices)).not.toContain("erika");
  });

  it("hat sich die Notiz während des Prüffensters geändert, wird nichts in sie geschrieben (kein Teilerfolg)", async () => {
    const note = "---\ncontact: erika@example.org\n---\nBitte an erika@example.org schreiben.\n";
    const r = rig(note);
    r.state.beforeReview = () => { r.files.set(PATH, `${note}Nachtrag.\n`); };
    await pseudonymizeNote(r.host);
    expect(r.files.get(PATH)).toBe(`${note}Nachtrag.\n`);
    expect(r.log).toEqual(["persist"]);
    expect(keys(r)).toEqual(["notice.note.stale"]);
  });

  it("scheitert das Schreiben der Tabelle, bleibt die Notiz byte-gleich", async () => {
    const note = "---\ncontact: erika@example.org\n---\nBitte an erika@example.org schreiben.\n";
    const r = rig(note);
    r.state.failPersist = true;
    await pseudonymizeNote(r.host);
    expect(r.files.get(PATH)).toBe(note);
    expect(keys(r)).toEqual(["notice.note.storage"]);
  });

  it("ohne Frontmatter und mit CRLF bleiben die Zeilenenden der Notiz", async () => {
    const note = "Hallo Max Mustermann,\r\nbis bald.\r\n";
    const r = rig(note);
    await pseudonymizeNote(r.host);
    expect(r.files.get(PATH)).toBe(`Hallo ${P},\r\nbis bald.\r\n`);
  });

  it("eine leere Notiz und eine Notiz ohne Treffer bleiben unberührt", async () => {
    const a = rig("");
    await pseudonymizeNote(a.host);
    const b = rig("Nichts Persönliches hier.\n");
    await pseudonymizeNote(b.host);
    expect(keys(a)).toEqual(["notice.note.empty"]);
    expect(keys(b)).toEqual(["notice.note.none"]);
    expect(b.files.get(PATH)).toBe("Nichts Persönliches hier.\n");
  });

  it("gesperrt: Notice, nichts gelesen oder geschrieben", async () => {
    const r = rig(NOTE);
    r.memory.lock("table-missing");
    await pseudonymizeNote(r.host);
    expect(keys(r)).toEqual(["notice.locked"]);
    expect(r.files.get(PATH)).toBe(NOTE);
  });
});

describe("splitNote", () => {
  it("sendet Text-Eigenschaften und Listeneinträge als line, den Rest als text; Datum, Wahrheitswert und Leeres nicht", () => {
    const s = splitNote("---\na: Hallo\nd: 2026-11-19\nt: 10:30\nb: true\ne:\nl: [x, y]\n---\nText\n");
    expect(s.parts.map((p) => [p.kind, p.value])).toEqual([["line", "Hallo"], ["line", "x"], ["line", "y"], ["text", "Text\n"]]);
  });
  it("ein BOM vor dem Zaun heißt: kein Frontmatter, die ganze Notiz ist Text", () => {
    const s = splitNote("﻿---\na: Hallo\n---\nText\n");
    expect(s.hasFrontmatter).toBe(false);
    expect(s.parts).toHaveLength(1);
  });
  it("bleibt linear in der Länge eines Werts und eines Schlüssels", { timeout: 180_000 }, () => {
    const r = pruefeLinearFuzz((s) => splitNote(`---\n${s}: ${s}\n---\n${s}\n`), { alphabet: ["a", "2026-11-19", ":", "T"], maxLaenge: 2, verschachtelt: false });
    expect(r.verdaechtig, JSON.stringify(r.verdaechtig)).toEqual([]);
  });
});
