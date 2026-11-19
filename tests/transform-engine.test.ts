// `transform` in der Engine (Bauplan Aufgabe 13, Spec 8.7, Review-Fokus 5): echte Gerätedatei (Fake-Platte, echtes WebCrypto), das Prüffenster ist ein Stellvertreter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/core/api";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { candidateKey, type Answer, type Candidate } from "../src/core/transform";
import { PseudonymizerEngine, type EngineOptions, type ReviewFn } from "../src/obsidian/engine";
import { placeholderIdFromBytes } from "../src/vendor/kit/placeholder";
import { serializeTable, tableFindValue, tableIsPlain, type PlaceholderTable } from "../src/vendor/kit/placeholder-table";
import { isPseudonymizerApi, type ApiError, type TransformRequest, type TransformResult } from "../src/vendor/kit/pseudonymizer-source";
import { MemoryTable } from "../src/core/memory-table";
import { FakeFs } from "./helpers/fake-fs";
import { CHAIN, FOLDER, ID_A, contentAt, makeDevice, seedFile, type Device } from "./helpers/store-fixtures";
import { sampleTable } from "./helpers/table-fixtures";

const CONSOLE = ["log", "info", "warn", "error", "debug", "trace"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => { spies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined)); });
afterEach(() => {
  const printed = spies.reduce((n, s) => n + s.mock.calls.length, 0);
  spies.forEach((s) => s.mockRestore());
  expect(printed).toBe(0);
});

const P = `Person_${ID_A}`;
const ERIKA = "Erika Musterfrau";
const BERTA = "Berta Beispiel";

/** Zufallsbytes, die man zählen kann: die n-te Kennung kommt aus `[n,0,0,0,0,0,0]`. */
function seqRandom(): { random: (n: number) => Uint8Array; idOf: (n: number) => string } {
  let n = 0;
  const bytes = (k: number): Uint8Array => Uint8Array.from({ length: 7 }, (_, i) => (i === 0 ? k : 0));
  return { random: (len) => { expect(len).toBe(7); return bytes(++n); }, idOf: (k) => placeholderIdFromBytes(bytes(k)) ?? "" };
}

const req = (parts: TransformRequest["parts"], extra: Partial<TransformRequest> = {}): TransformRequest => ({ caller: "test", documentKey: "doc-1", interactive: false, parts, ...extra });
const text = (value: string, id = "a"): TransformRequest["parts"][number] => ({ id, kind: "text", value });
const isError = (r: TransformResult | ApiError): r is ApiError => "error" in r;
const okResult = (r: TransformResult | ApiError): TransformResult => { if (isError(r)) throw new Error(`Fehlerwert ${r.error}`); return r; };

interface Rig { fs: FakeFs; d: Device; engine: PseudonymizerEngine; ids: ReturnType<typeof seqRandom>; table(): PlaceholderTable }
async function ready(options: EngineOptions = {}, base: PlaceholderTable = sampleTable()): Promise<Rig> {
  const fs = new FakeFs(FOLDER);
  await seedFile(fs, { deviceId: "dev-a", stand: 0, table: base });
  const d = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
  await d.store.refresh();
  expect(d.memory.state()).toBe("ready");
  const ids = seqRandom();
  const engine = new PseudonymizerEngine(d.memory, () => d.store, { random: ids.random, ...options });
  return { fs, d, engine, ids, table: () => d.memory.table() as PlaceholderTable };
}
/** Ein frisches Gerät liest den Ordner: zeigt, was die Dateien tragen, nicht, was der Arbeitsspeicher weiß. */
async function reader(fs: FakeFs): Promise<PlaceholderTable> {
  const r = makeDevice(fs, { deviceId: "dev-reader", content: await contentAt(CHAIN, 0) });
  await r.store.refresh();
  return r.memory.table() as PlaceholderTable;
}
const accept: ReviewFn = () => Promise.resolve({ answers: new Map() });
const ERIKA_REQ = (extra: Partial<TransformRequest> = {}): TransformRequest => req([text(`Rufen Sie ${ERIKA} an.`)], { entities: [{ name: ERIKA }], interactive: true, ...extra });

describe("transform: ohne offene Kandidaten", () => {
  it("bekannte Werte werden ersetzt, und es wird nichts geschrieben", async () => {
    const { engine, fs } = await ready();
    fs.clearLog();
    const r = okResult(await engine.transform(req([text("Hallo Max, Tel 030 1234567")])));
    expect(r).toEqual({ parts: [{ id: "a", value: `Hallo ${P}_2, Tel ${P}_Telefon` }], entities: [], applied: 2 });
    expect(fs.mutations).toBe(0);
  });

  it("deterministisch: der zweite Aufruf liefert dieselbe Ausgabe wie der erste", async () => {
    const { engine } = await ready({ review: accept });
    const r = req([text(`Hallo Max, ${ERIKA} schrieb: Tel 030 7654321.`)], { interactive: true });
    const first = okResult(await engine.transform(r));
    const second = okResult(await engine.transform(r));
    expect(second).toEqual(first);
  });
});

describe("transform: offene Kandidaten", () => {
  it("unbeaufsichtigt: deferred, ohne jede Änderung an Tabelle und Datei", async () => {
    const { engine, fs, d } = await ready({ review: accept });
    const before = d.memory.table();
    const bytes = fs.get("dev-a.pseudo");
    fs.clearLog();
    const r = await engine.transform(req([text(`Rufen Sie ${ERIKA} an.`)], { entities: [{ name: ERIKA }] }));
    expect(r).toMatchObject({ error: "deferred" });
    expect(fs.mutations).toBe(0);
    expect(d.memory.table()).toBe(before);
    expect(fs.get("dev-a.pseudo")).toEqual(bytes);
    expect(JSON.stringify(r)).not.toContain("Erika");
  });

  it("interaktiv, aber ohne Prüffenster: deferred", async () => {
    const { engine, fs } = await ready();
    fs.clearLog();
    expect(await engine.transform(ERIKA_REQ())).toMatchObject({ error: "deferred" });
    expect(fs.mutations).toBe(0);
  });

  it("das Prüffenster bekommt eine Karte je Wert, den Titel und den documentKey; null heißt cancelled, ohne Schreiben", async () => {
    const calls: { c: Candidate[]; ctx: { documentKey: string; title?: string } }[] = [];
    const review: ReviewFn = (c, ctx) => { calls.push({ c, ctx }); return Promise.resolve(null); };
    const { engine, fs } = await ready({ review });
    fs.clearLog();
    const r = await engine.transform(req([text(`${ERIKA}, ${ERIKA}, Tel 030 7654321`)], { entities: [{ name: ERIKA }], interactive: true, title: "Mail 7" }));
    expect(r).toMatchObject({ error: "cancelled" });
    expect(fs.mutations).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.c.map((c) => c.value)).toEqual([ERIKA, "030 7654321"]);
    expect(calls[0]?.ctx).toMatchObject({ documentKey: "doc-1", title: "Mail 7" });
  });

  it("bestätigt: das Ergebnis kommt erst, wenn die Gerätedatei geschrieben ist", async () => {
    const { engine, fs, d, ids } = await ready({ review: accept });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fs.beforeWrite = () => gate;
    let settled = false;
    const pending = engine.transform(ERIKA_REQ()).then((r) => { settled = true; return r; });
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    expect(d.log).toContain("file:write");
    expect(d.log).not.toContain("file:done");
    release();
    const r = okResult(await pending);
    expect(d.log).toContain("file:done");
    expect(r.parts[0]?.value).toBe(`Rufen Sie Person_${ids.idOf(1)} an.`);
    expect(r.entities).toEqual([{ name: `Person_${ids.idOf(1)}` }]);
    // Die Datei trägt den Eintrag: ein frisches Gerät findet ihn.
    expect(tableFindValue(await reader(fs), null, ERIKA)?.id).toBe(ids.idOf(1));
  });

  it("ohne injizierte Bytes zieht die Engine die Kennung aus crypto.getRandomValues (sieben Bytes)", async () => {
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
    const { d } = await ready();
    const engine = new PseudonymizerEngine(d.memory, () => d.store, { review: accept });
    const r = okResult(await engine.transform(ERIKA_REQ()));
    expect(spy.mock.calls.some(([a]) => (a as Uint8Array).byteLength === 7)).toBe(true);
    expect(r.parts[0]?.value).toMatch(/^Rufen Sie Person_[0-9a-hjkmnp-tv-z]{10} an\.$/);
    spy.mockRestore();
  });

  it("Schreiben scheitert: storage-failed, und auch die Tabelle im Arbeitsspeicher trägt die neuen Einträge nicht (Review-Fokus 5)", async () => {
    const { engine, fs, d } = await ready({ review: accept });
    const bytes = fs.get("dev-a.pseudo");
    const before = d.memory.table();
    fs.failWrites = true;
    const r = await engine.transform(ERIKA_REQ());
    expect(r).toMatchObject({ error: "storage-failed" });
    expect(JSON.stringify(r)).not.toContain("Erika");
    expect(tableFindValue(d.memory.table() as PlaceholderTable, null, ERIKA)).toBeUndefined();
    expect(serializeTable(d.memory.table() as PlaceholderTable)).toBe(serializeTable(before as PlaceholderTable));
    fs.failWrites = false;
    expect(fs.get("dev-a.pseudo")).toEqual(bytes);
    expect(tableFindValue(await reader(fs), null, ERIKA)).toBeUndefined();
    // Nach dem Fehler geht es wieder: nichts blieb halb.
    expect(okResult(await engine.transform(ERIKA_REQ())).parts[0]?.value).toMatch(/^Rufen Sie Person_/);
  });

  it("zwei gleichzeitige transform mit je einer neuen Person: beide Einträge stehen in Tabelle und Datei", async () => {
    const { engine, fs, d } = await ready({ review: accept });
    const [a, b] = await Promise.all([
      engine.transform(req([text(`Rufen Sie ${ERIKA} an.`)], { entities: [{ name: ERIKA }], interactive: true })),
      engine.transform(req([text(`Rufen Sie ${BERTA} an.`)], { entities: [{ name: BERTA }], interactive: true, documentKey: "doc-2" })),
    ]);
        expect(okResult(a).parts[0]?.value).toMatch(/Person_/);
    expect(okResult(b).parts[0]?.value).toMatch(/Person_/);
    for (const table of [d.memory.table() as PlaceholderTable, await reader(fs)]) {
      expect(tableFindValue(table, null, ERIKA)).toBeDefined();
      expect(tableFindValue(table, null, BERTA)).toBeDefined();
      expect(tableFindValue(table, null, ERIKA)?.id).not.toBe(tableFindValue(table, null, BERTA)?.id);
    }
  });

  it("zwei gleichzeitige transform für dieselbe neue Person: ein Eintrag, dieselbe Kennung in beiden Ergebnissen", async () => {
    const { engine, d } = await ready({ review: accept });
    const [a, b] = await Promise.all([engine.transform(ERIKA_REQ()), engine.transform(ERIKA_REQ({ documentKey: "doc-2" }))]);
    expect(okResult(a).parts[0]?.value).toBe(okResult(b).parts[0]?.value);
    expect((d.memory.table() as PlaceholderTable).entries.filter((e) => tableFindValue(d.memory.table() as PlaceholderTable, null, ERIKA)?.id === e.id)).toHaveLength(1);
  });

  it("„hier lassen“ wird gespeichert: der nächste unbeaufsichtigte Aufruf für dasselbe Dokument fragt nicht mehr", async () => {
    const review: ReviewFn = (cs) => Promise.resolve({ answers: new Map<string, Answer>(cs.map((c) => [candidateKey(c), { action: "keep-here" }])) });
    const { engine, d, fs } = await ready({ review });
    const first = okResult(await engine.transform(ERIKA_REQ()));
    expect(first.parts[0]?.value).toBe(`Rufen Sie ${ERIKA} an.`);
    expect(tableIsPlain(d.memory.table() as PlaceholderTable, "doc-1", ERIKA)).toBe(true);
    expect(tableIsPlain(await reader(fs), "doc-1", ERIKA)).toBe(true);
    const again = await engine.transform(ERIKA_REQ({ interactive: false }));
    expect(okResult(again).parts[0]?.value).toBe(`Rufen Sie ${ERIKA} an.`);
  });

  it("die eingeschalteten Regelgruppen werden bei jedem Aufruf frisch gelesen", async () => {
    const rules = { ...DEFAULT_SETTINGS.rules };
    const { engine } = await ready({ rules: () => rules }, sampleTable());
    const r = req([text("Hallo Erika,\n\nbis bald.")]);
    expect(await engine.transform(r)).toMatchObject({ error: "deferred" });
    rules.salutation = false;
    expect(okResult(await engine.transform(r)).parts[0]?.value).toBe("Hallo Erika,\n\nbis bald.");
  });
});

describe("transform: die Tabelle ändert sich, während das Prüffenster offen ist (K3)", () => {
  it("kommt eine Vergessen-Marke an, wird nichts geschrieben: deferred mit der Meldung, ohne Klartext; kein neuer Eintrag, die vergessene Person wird nicht durch ihren Platzhalter ersetzt", async () => {
    let forgotten: unknown = null;
    const { engine, d, fs } = await ready({
      review: async () => { forgotten = await d.store.forget(ID_A); return { answers: new Map() }; },
    });
    const r = await engine.transform(req([text(`Max ruft an. Rufen Sie ${ERIKA} an.`)], { entities: [{ name: ERIKA }], interactive: true }));
    expect(forgotten).toMatchObject({ ok: true });
    expect(r).toEqual({ error: "deferred", message: "the table changed during the review" });
    expect(JSON.stringify(r)).not.toMatch(/Max|Muster|Erika/);
    expect(tableFindValue(await reader(fs), null, ERIKA)).toBeUndefined();
    expect(tableFindValue(d.memory.table() as PlaceholderTable, null, ERIKA)).toBeUndefined();
  });

  it("ändert sich nichts Verwendetes, läuft alles wie bisher", async () => {
    const { engine, d } = await ready({ review: accept });
    const r = okResult(await engine.transform(req([text(`Max ruft an. Rufen Sie ${ERIKA} an.`)], { entities: [{ name: ERIKA }], interactive: true })));
    expect(r.parts[0]?.value).toContain(`${P}_2`);
    expect(tableFindValue(d.memory.table() as PlaceholderTable, null, ERIKA)).toBeDefined();
  });
});

describe("transform: Zustand und Eingabe", () => {
  it("nicht eingerichtet und gesperrt kommen als Wert zurück, ohne Ausnahme", async () => {
    const memory = new MemoryTable();
    const e = new PseudonymizerEngine(memory);
    expect(await e.transform(req([text("x")]))).toMatchObject({ error: "not-ready" });
    memory.lock("table-missing");
    expect(await e.transform(req([text("x")]))).toMatchObject({ error: "locked" });
  });

  it("über die API: doppelte Teil-IDs und fehlender caller oder documentKey sind invalid-input, ohne Schreiben", async () => {
    const { engine, fs } = await ready({ review: accept });
    const api = createApi(() => engine);
    expect(isPseudonymizerApi(api)).toBe(true);
    fs.clearLog();
    const bad: unknown[] = [
      req([text("x", "p"), text("y", "p")]),
      { ...req([text("x")]), caller: "" },
      { ...req([text("x")]), documentKey: "  " },
      { ...req([text("x")]), parts: undefined },
    ];
    for (const b of bad) expect(await api.transform(b as TransformRequest)).toMatchObject({ error: "invalid-input" });
    expect(fs.mutations).toBe(0);
    // und der gültige Aufruf läuft durch dieselbe Hülle
    expect(okResult(await api.transform(req([text("Hallo Max")]))).parts[0]?.value).toBe(`Hallo ${P}_2`);
  });
});
