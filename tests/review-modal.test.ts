// Das Prüffenster (Bauplan Aufgabe 14, Spec 8.5): das echte Modal (Obsidian-Mock) an der echten Engine mit Fake-Platte und echtem WebCrypto.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { Modal, Notice, Platform } from "./vendor/kit/obsidian-mock";
import "../src/i18n/strings";
import { STRINGS } from "../src/i18n/strings";
import { setLang } from "../src/vendor/kit/i18n";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { PseudonymizerEngine } from "../src/obsidian/engine";
import { createReviewFn, type ReviewModalOptions } from "../src/obsidian/review-modal";
import { placeholderIdFromBytes } from "../src/vendor/kit/placeholder";
import { tableFindValue, tableIsException, tableIsPlain, type PlaceholderTable } from "../src/vendor/kit/placeholder-table";
import type { ApiError, TransformRequest, TransformResult } from "../src/vendor/kit/pseudonymizer-source";
import { FakeFs } from "./helpers/fake-fs";
import { CHAIN, FOLDER, ID_A, ID_C, contentAt, makeDevice, personTable, seedFile, type Device } from "./helpers/store-fixtures";
import { PERSON, sampleTable } from "./helpers/table-fixtures";

const CONSOLE = ["log", "info", "warn", "error", "debug", "trace"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  setLang("en");
  Modal.__last = null;
  Notice.instances.length = 0;
  Platform.isPhone = false;
  spies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  const printed = spies.reduce((n, s) => n + s.mock.calls.length, 0);
  spies.forEach((s) => s.mockRestore());
  expect(printed).toBe(0);
});

const en = STRINGS.en;
const app = {} as unknown as App;
const ERIKA = "Erika Musterfrau";
const TEXT = `Hallo ${ERIKA},\nTel 030 7654321.\nHallo ${ERIKA},`;
const P = `Person_${ID_A}`;

function seqRandom(): { random: (n: number) => Uint8Array; idOf: (n: number) => string } {
  let n = 0;
  const bytes = (k: number): Uint8Array => Uint8Array.from({ length: 7 }, (_, i) => (i === 0 ? k : 0));
  return { random: () => bytes(++n), idOf: (k) => placeholderIdFromBytes(bytes(k)) ?? "" };
}
const req = (value: string, extra: Partial<TransformRequest> = {}): TransformRequest => ({ caller: "test", documentKey: "doc-1", interactive: true, title: "Mail 7", parts: [{ id: "a", kind: "text", value }], ...extra });
const isError = (r: TransformResult | ApiError): r is ApiError => "error" in r;
const okResult = (r: TransformResult | ApiError): TransformResult => { if (isError(r)) throw new Error(`Fehlerwert ${r.error}`); return r; };

interface Rig { fs: FakeFs; d: Device; engine: PseudonymizerEngine; ids: ReturnType<typeof seqRandom> }
async function ready(options: ReviewModalOptions = {}): Promise<Rig> {
  const fs = new FakeFs(FOLDER);
  await seedFile(fs, { deviceId: "dev-a", stand: 0, table: sampleTable() });
  const d = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
  await d.store.refresh();
  const ids = seqRandom();
  const engine = new PseudonymizerEngine(d.memory, () => d.store, { random: ids.random, rules: () => DEFAULT_SETTINGS.rules, review: createReviewFn(app, options) });
  return { fs, d, engine, ids };
}
async function reader(fs: FakeFs): Promise<PlaceholderTable> {
  const r = makeDevice(fs, { deviceId: "dev-reader", content: await contentAt(CHAIN, 0) });
  await r.store.refresh();
  return r.memory.table() as PlaceholderTable;
}

// ---- Bedienung des Fensters ---------------------------------------------------------------------------------------------------------------------

const lastModal = (): any => { const m = Modal.__last; if (!m) throw new Error("kein Fenster offen"); return m; };
const opened = (): Promise<unknown> => vi.waitFor(() => { if (Modal.__last === null) throw new Error("noch kein Fenster"); });
const cardEls = (): any[] => lastModal().contentEl.querySelectorAll(".okit-review-card");
const found = (c: any): string => c.querySelector(".okit-review-found").textContent;
const card = (value: string): any => { const c = cardEls().find((x) => found(x) === value); if (!c) throw new Error(`keine Karte für ${value}`); return c; };
const chooseWay = (value: string, way: "replace" | "keep-here" | "keep-always"): void => { card(value).querySelectorAll(".okit-segmented-btn").find((b: any) => b.getAttribute("data-value") === way).click(); };
const activeWay = (c: any): string => c.querySelectorAll(".okit-segmented-btn").find((b: any) => b.hasClass("is-active")).getAttribute("data-value");
const ownerSelect = (value: string): any => card(value).querySelector(".okit-review-owner-select");
const ownerLabels = (value: string): string[] => ownerSelect(value).children.map((o: any) => o.textContent);
const ownerValues = (value: string): string[] => ownerSelect(value).children.map((o: any) => o.getAttribute("value"));
const chooseOwner = (value: string, id: string): void => { const s = ownerSelect(value); s.value = id; for (const cb of s._listeners.change ?? []) cb(); };
const buttons = (): any[] => lastModal().contentEl.querySelectorAll("button");
const comp = (b: any): any => b.__component;
const applyButton = (): any => buttons().map(comp).filter(Boolean).find((c) => c.ctaSet);
const cancelButton = (): any => buttons().map(comp).filter(Boolean).find((c) => c.textValue === en["modal.cancel"]);
const byText = (text: string): any => { const b = buttons().find((x: any) => x.textContent === text); if (!b) throw new Error(`kein Knopf ${text}`); return b; };

describe("Aufbau", () => {
  it("eine Karte je Wert, nicht je Stelle: der Name steht zweimal im Text und hat eine Karte mit zwei Stellen; der Kopf zählt Werte", async () => {
    const { engine } = await ready();
    void engine.transform(req(TEXT));
    await opened();
    expect(cardEls().map(found)).toEqual([ERIKA, "030 7654321"]);
    expect(card(ERIKA).querySelector(".okit-review-places").textContent).toBe("2 places");
    expect(card("030 7654321").querySelector(".okit-review-places").textContent).toBe("1 place");
    expect(lastModal().contentEl.querySelector(".pseu-review-summary").textContent).toBe("2 new findings · 0 known values are replaced");
    // die Kontextzeile zeigt den Treffer hervorgehoben (mark), nie die ganze Notiz
    expect(card(ERIKA).querySelector("mark").textContent).toBe(ERIKA);
    expect(card(ERIKA).querySelector(".okit-review-context").textContent).toBe(`„Hallo ${ERIKA},“`);
    // der Titel nennt die Überschrift der Anfrage
    expect(lastModal().titleEl.textContent).toBe("Pseudonymize: \"Mail 7\"");
  });

  it("bekannte Werte stehen nur als Zahl im Kopf und lassen sich aufklappen", async () => {
    const { engine } = await ready();
    void engine.transform(req(`Max Mustermann und Max. ${TEXT}`));
    await opened();
    expect(lastModal().contentEl.querySelector(".pseu-review-summary").textContent).toBe("2 new findings · 2 known values are replaced");
    const list = lastModal().contentEl.querySelector(".pseu-review-known-list");
    expect(list.style.display).toBe("none");
    expect(cardEls().map(found)).not.toContain("Max");
    byText(en["modal.review.known.show"]).click();
    expect(list.style.display).toBe("");
    expect(list.textContent).toContain(`Max Mustermann becomes ${P}`);
  });

  it("die drei Wege sind ein Segment-Schalter, Ersetzen ist die Vorgabe; der Zustand steht in Klasse und aria-checked, nicht nur in der Farbe", async () => {
    const { engine } = await ready();
    void engine.transform(req(TEXT));
    await opened();
    const c = card(ERIKA);
    expect(c.querySelectorAll(".okit-segmented-btn").map((b: any) => b.textContent)).toEqual([en["modal.review.way.replace"], en["modal.review.way.keepHere"], en["modal.review.way.keepAlways"]]);
    expect(activeWay(c)).toBe("replace");
    expect(c.querySelector(".okit-segmented").getAttribute("role")).toBe("radiogroup");
    expect(c.querySelectorAll(".okit-segmented-btn").map((b: any) => b.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    chooseWay(ERIKA, "keep-here");
    expect(activeWay(c)).toBe("keep-here");
  });

  it("Abbrechen links, „N ersetzen, übernehmen“ rechts als mod-cta; die Zahl folgt den Wegen", async () => {
    const { engine } = await ready();
    void engine.transform(req(TEXT));
    await opened();
    const labels = buttons().map((b: any) => comp(b)?.textValue).filter(Boolean);
    expect(labels.slice(-2)).toEqual([en["modal.cancel"], "Replace 2, apply"]);
    expect(applyButton().textValue).toBe("Replace 2, apply");
    chooseWay("030 7654321", "keep-always");
    expect(applyButton().textValue).toBe("Replace 1, apply");
    chooseWay(ERIKA, "keep-here");
    expect(applyButton().textValue).toBe(en["modal.review.apply"]);
  });

  it("deutsch: Titel, Kopf und Knopf in der Sprache der Oberfläche", async () => {
    setLang("de");
    const { engine } = await ready();
    void engine.transform(req(TEXT));
    await opened();
    expect(lastModal().titleEl.textContent).toBe("Pseudonymisieren: „Mail 7“");
    expect(lastModal().contentEl.querySelector(".pseu-review-summary").textContent).toBe("2 neue Fundstellen · 0 bekannte Werte werden ersetzt");
    expect(applyButton().textValue).toBe("2 ersetzen, übernehmen");
    expect(card(ERIKA).querySelector(".okit-review-owner-text").textContent).toBe("Gehört zu");
  });

  it("am Telefon füllt das Fenster den Bildschirm, die Regel steht in styles.css; Tippflächen der Wege sind mindestens 44 px", async () => {
    Platform.isPhone = true;
    const { engine } = await ready();
    void engine.transform(req(TEXT));
    await opened();
    expect(lastModal().modalEl.hasClass("pseu-review-full")).toBe(true);
    const css = readFileSync("styles.css", "utf8");
    expect(css).toMatch(/\.is-phone \.modal\.pseu-review-modal\.pseu-review-full \{[^}]*height: 100%/);
    expect(css).toMatch(/\.okit-review-ways \.okit-segmented-btn \{[^}]*min-height: calc\(var\(--size-4-10\) \+ var\(--size-4-1\)\)/);
    expect(css).toMatch(/\.pseu-review-mark-kind, \.pseu-review-mark-add \{[^}]*min-height: calc\(var\(--size-4-10\) \+ var\(--size-4-1\)\)/);
  });
});

describe("Wege und Zuordnung", () => {
  it("Vorgabe Ersetzen: übernehmen ohne Änderung ersetzt alles; ohne Strukturbeleg gehört die Nummer niemandem", async () => {
    const { engine, ids, fs } = await ready();
    const p = engine.transform(req(TEXT));
    await opened();
    applyButton().clickCB();
    const r = okResult(await p);
    expect(r.parts[0]?.value).toBe(`Hallo Person_${ids.idOf(1)},\nTel Telefon_${ids.idOf(2)}.\nHallo Person_${ids.idOf(1)},`);
    expect(tableFindValue(await reader(fs), null, ERIKA)?.id).toBe(ids.idOf(1));
  });

  it("„Hier lassen“ speichert für den documentKey: derselbe Wert im selben Dokument fragt nicht mehr, in einem anderen schon", async () => {
    const { engine, d, fs } = await ready();
    const p = engine.transform(req(TEXT));
    await opened();
    chooseWay(ERIKA, "keep-here");
    applyButton().clickCB();
    const r = okResult(await p);
    expect(r.parts[0]?.value).toContain(`Hallo ${ERIKA},`);
    expect(r.parts[0]?.value).toMatch(/Tel Telefon_/);
    expect(tableIsPlain(d.memory.table() as PlaceholderTable, "doc-1", ERIKA)).toBe(true);
    expect(tableIsPlain(await reader(fs), "doc-1", ERIKA)).toBe(true);
    expect(tableIsPlain(await reader(fs), "doc-2", ERIKA)).toBe(false);
    expect(await engine.transform(req(`Hallo ${ERIKA},`, { interactive: false }))).toMatchObject({ parts: [{ value: `Hallo ${ERIKA},` }] });
    Modal.__last = null;
    expect(await engine.transform(req(`Hallo ${ERIKA},`, { interactive: false, documentKey: "doc-2" }))).toMatchObject({ error: "deferred" });
  });

  it("„Immer lassen“ kommt in die Ausnahmeliste, in der Datei und für jedes Dokument", async () => {
    const { engine, d, fs } = await ready();
    const p = engine.transform(req(TEXT));
    await opened();
    chooseWay(ERIKA, "keep-always");
    applyButton().clickCB();
    const r = okResult(await p);
    expect(r.parts[0]?.value).toContain(`Hallo ${ERIKA},`);
    expect(tableIsException(d.memory.table() as PlaceholderTable, ERIKA)).toBe(true);
    expect(tableIsException(await reader(fs), ERIKA)).toBe(true);
    expect(await engine.transform(req(`Hallo ${ERIKA},`, { interactive: false, documentKey: "doc-9" }))).toMatchObject({ parts: [{ value: `Hallo ${ERIKA},` }] });
  });

  it("„Gehört zu“: ein Wert ohne Strukturbeleg bietet keinen Vorschlag und steht auf „niemandem“; der Name bietet neue Person und Organisation und vorhandene Einträge", async () => {
    const { engine } = await ready();
    void engine.transform(req(TEXT));
    await opened();
    expect(ownerValues("030 7654321")).toEqual(["nobody", `entry:${PERSON}`]);
    expect(ownerSelect("030 7654321").value).toBe("nobody");
    expect(ownerLabels("030 7654321")[0]).toBe("Nobody");
    expect(ownerValues(ERIKA)).toEqual(["new-person", "new-organisation", `entry:${PERSON}`]);
    expect(ownerSelect(ERIKA).value).toBe("new-person");
    expect(ownerLabels(ERIKA)).toEqual(["New person", "New organisation", "Max Mustermann (Person)"]);
  });

  it("Vorschlag nur aus der Struktur: der Signaturblock des Absenders schlägt seinen Namen vor, die Zentrale bleibt bei „niemandem“; bestätigt wird im Fenster", async () => {
    const { engine, ids } = await ready();
    const p = engine.transform(req("Viele Grüße\nErika Musterfrau\nTel. 030 7654321\n\nZentrale 030 5555555"));
    await opened();
    expect(ownerValues("030 7654321")).toEqual(["suggested", "nobody", `entry:${PERSON}`]);
    expect(ownerSelect("030 7654321").value).toBe("suggested");
    expect(ownerLabels("030 7654321")[0]).toBe("Erika Musterfrau (suggested by the structure)");
    expect(ownerSelect("030 5555555").value).toBe("nobody");
    expect(card(ERIKA).querySelector(".okit-review-also").textContent).toBe("also: 030 7654321");
    applyButton().clickCB();
    const r = okResult(await p);
    expect(r.parts[0]?.value).toBe(`Viele Grüße\nPerson_${ids.idOf(1)}\nTel. Person_${ids.idOf(1)}_Telefon\n\nZentrale Telefon_${ids.idOf(2)}`);
  });

  it("der Vorschlag lässt sich ablehnen: „niemandem“ gewählt, die Nummer bekommt keine Person", async () => {
    const { engine, ids } = await ready();
    const p = engine.transform(req("Viele Grüße\nErika Musterfrau\nTel. 030 7654321"));
    await opened();
    chooseOwner("030 7654321", "nobody");
    applyButton().clickCB();
    expect(okResult(await p).parts[0]?.value).toBe(`Viele Grüße\nPerson_${ids.idOf(1)}\nTel. Telefon_${ids.idOf(2)}`);
  });

  it("ein vorhandener Eintrag als Besitzer: die Nummer wird ein weiterer Wert dieser Person; der Name eine weitere Schreibweise", async () => {
    const { engine } = await ready();
    const p = engine.transform(req(TEXT));
    await opened();
    chooseOwner("030 7654321", `entry:${PERSON}`);
    chooseOwner(ERIKA, `entry:${PERSON}`);
    applyButton().clickCB();
    const r = okResult(await p);
    expect(r.parts[0]?.value).toBe(`Hallo ${P}_3,\nTel ${P}_Telefon_3.\nHallo ${P}_3,`);
  });

  it("der Mail-Kopf bindet Name und Adresse: eine Person, „auch: …“ nennt die Adresse", async () => {
    const { engine, ids } = await ready();
    const p = engine.transform(req("x", { entities: [{ name: ERIKA, email: "erika@example.org" }] }));
    await opened();
    expect(card(ERIKA).querySelector(".okit-review-also").textContent).toBe("also: erika@example.org");
    expect(ownerSelect("erika@example.org").value).toBe("suggested");
    applyButton().clickCB();
    const r = okResult(await p);
    expect(r.entities).toEqual([{ name: `Person_${ids.idOf(1)}`, email: `Person_${ids.idOf(1)}_Mail` }]);
  });
});

describe("Abbrechen und übernehmen", () => {
  it("Abbrechen: cancelled, weder Notiz noch Tabelle noch Datei verändert", async () => {
    const { engine, fs, d } = await ready();
    const before = d.memory.table();
    const bytes = fs.get("dev-a.pseudo");
    fs.clearLog();
    const p = engine.transform(req(TEXT));
    await opened();
    chooseWay(ERIKA, "keep-always");
    cancelButton().clickCB();
    expect(await p).toMatchObject({ error: "cancelled" });
    expect(fs.mutations).toBe(0);
    expect(d.memory.table()).toBe(before);
    expect(fs.get("dev-a.pseudo")).toEqual(bytes);
  });

  it("Esc (das Fenster wird geschlossen) ist Abbrechen: cancelled, nichts geschrieben; ein späterer Klick auf „übernehmen“ ändert nichts mehr", async () => {
    const { engine, fs } = await ready();
    fs.clearLog();
    const p = engine.transform(req(TEXT));
    await opened();
    const apply = applyButton();
    lastModal().close();
    expect(await p).toMatchObject({ error: "cancelled" });
    apply.clickCB();
    expect(fs.mutations).toBe(0);
  });

  it("übernehmen legt alle Entscheidungen in EINEM persist ab", async () => {
    const { engine } = await ready();
    const persist = vi.spyOn(engine, "persist");
    const p = engine.transform(req(TEXT));
    await opened();
    chooseWay("030 7654321", "keep-always");
    applyButton().clickCB();
    okResult(await p);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("Schreiben scheitert: storage-failed, die Tabelle im Arbeitsspeicher trägt nichts davon", async () => {
    const { engine, fs, d } = await ready();
    const p = engine.transform(req(TEXT));
    await opened();
    fs.failWrites = true;
    applyButton().clickCB();
    expect(await p).toMatchObject({ error: "storage-failed" });
    expect(tableFindValue(d.memory.table() as PlaceholderTable, null, ERIKA)).toBeUndefined();
  });
});

describe("während das Fenster offen ist", () => {
  it("ein anderer Weg legt einen Eintrag an, ein refresh bringt einen fremden: nach „übernehmen“ stehen alle drei in der Datei; ein unbeaufsichtigter transform stört das Fenster nicht", async () => {
    const { engine, fs, d, ids } = await ready();
    const p = engine.transform(req(TEXT));
    await opened();
    const win = lastModal();
    // ein anderer Weg legt einen Eintrag an
    const BERTA = "Berta Beispiel";
    await engine.persist((cur) => personTable("m4t8c6r2vp", BERTA, cur));
    // ein fremdes Gerät liefert eine Datei, ein refresh bringt sie
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable(ID_C, "Fremde Person") });
    await engine.refresh();
    // ein unbeaufsichtigter transform läuft und liefert sein Ergebnis, das Fenster bleibt
    expect(okResult(await engine.transform(req("Hallo Max", { interactive: false })))).toMatchObject({ applied: 1 });
    expect(Modal.__last).toBe(win);
    applyButton().clickCB();
    okResult(await p);
    for (const table of [d.memory.table() as PlaceholderTable, await reader(fs)]) {
      expect(tableFindValue(table, null, ERIKA)?.id).toBe(ids.idOf(1));
      expect(tableFindValue(table, null, BERTA)?.id).toBe("m4t8c6r2vp");
      expect(tableFindValue(table, null, "Fremde Person")?.id).toBe(ID_C);
    }
  });

  it("hat inzwischen ein anderer Weg denselben Wert angelegt, nimmt das Fenster dessen Kennung statt einer zweiten", async () => {
    const { engine, d, fs } = await ready();
    const p = engine.transform(req(TEXT));
    await opened();
    await engine.persist((cur) => personTable("m4t8c6r2vp", ERIKA, cur));
    applyButton().clickCB();
    const r = okResult(await p);
    expect(r.parts[0]?.value).toMatch(/^Hallo Person_m4t8c6r2vp,\nTel Telefon_/);
    const table = d.memory.table() as PlaceholderTable;
    expect(table.values.filter((v) => v.field === null && v.text === ERIKA)).toHaveLength(1);
    expect(tableFindValue(await reader(fs), null, ERIKA)?.id).toBe("m4t8c6r2vp");
  });
});

describe("Text ansehen und weitere Stellen markieren", () => {
  const NOTE = `Hallo ${ERIKA},\nDie Kollegin Schmidt schrieb. Schmidt ruft an, Schmidtke nicht.`;

  it("zeigt den Text mit markierten Fundstellen (Rahmen) und bekannten Werten (gepunktet), eingeklappt bis zum Knopf", async () => {
    const { engine } = await ready();
    void engine.transform(req(`Max ruft an.\n${NOTE}`));
    await opened();
    expect(lastModal().contentEl.querySelector(".pseu-review-text")).toBeNull();
    byText(en["modal.review.text.show"]).click();
    const text = lastModal().contentEl.querySelector(".pseu-review-text");
    expect(text.querySelectorAll(".pseu-review-open").map((e: any) => e.textContent)).toEqual([ERIKA]);
    expect(text.querySelectorAll(".pseu-review-known").map((e: any) => e.textContent)).toEqual(["Max"]);
    expect(text.textContent).toContain("Schmidtke");
  });

  it("eine Auswahl wird als Person hinzugefügt: jede freie Stelle des Wortlauts wird eine Karte (nicht „Schmidtke“), und übernehmen ersetzt alle mit einer Kennung", async () => {
    let selected = "";
    const { engine, ids } = await ready({ selection: () => selected });
    const p = engine.transform(req(NOTE));
    await opened();
    byText(en["modal.review.text.show"]).click();
    selected = "Schmidt";
    byText(en["modal.review.mark.add"]).click();
    expect(cardEls().map(found)).toEqual([ERIKA, "Schmidt"]);
    expect(card("Schmidt").querySelector(".okit-review-places").textContent).toBe("2 places");
    expect(lastModal().contentEl.querySelectorAll(".pseu-review-open").map((e: any) => e.textContent)).toEqual([ERIKA, "Schmidt", "Schmidt"]);
    expect(applyButton().textValue).toBe("Replace 2, apply");
    applyButton().clickCB();
    const r = okResult(await p);
    expect(r.parts[0]?.value).toBe(`Hallo Person_${ids.idOf(1)},\nDie Kollegin Person_${ids.idOf(2)} schrieb. Person_${ids.idOf(2)} ruft an, Schmidtke nicht.`);
  });

  it("Entscheidungen zu vorhandenen Karten bleiben, wenn eine Stelle hinzukommt", async () => {
    const { engine } = await ready({ selection: () => "Schmidt" });
    void engine.transform(req(NOTE));
    await opened();
    chooseWay(ERIKA, "keep-here");
    byText(en["modal.review.text.show"]).click();
    byText(en["modal.review.mark.add"]).click();
    expect(activeWay(card(ERIKA))).toBe("keep-here");
  });

  it("keine Auswahl oder keine freie Stelle: ein Hinweis, nichts wird hinzugefügt", async () => {
    let selected = "";
    const { engine } = await ready({ selection: () => selected });
    void engine.transform(req(NOTE));
    await opened();
    byText(en["modal.review.text.show"]).click();
    byText(en["modal.review.mark.add"]).click();
    selected = "Nirgends";
    byText(en["modal.review.mark.add"]).click();
    expect(Notice.instances.map((n) => n.message)).toEqual([en["modal.review.mark.none"], en["modal.review.mark.notFound"]]);
    expect(cardEls().map(found)).toEqual([ERIKA]);
  });

  it("die Art der Auswahl lässt sich wählen: als Telefonnummer hinzugefügt gehört der Wert vorgabegemäß niemandem", async () => {
    const { engine, ids } = await ready({ selection: () => "99 12 34" });
    const p = engine.transform(req(`Hallo ${ERIKA},\nSondernummer 99 12 34`));
    await opened();
    byText(en["modal.review.text.show"]).click();
    const select = lastModal().contentEl.querySelector(".pseu-review-mark-kind");
    expect(select.children.map((o: any) => o.getAttribute("value"))).toEqual(["person", "organisation", "mail", "phone", "address", "iban"]);
    select.value = "phone";
    for (const cb of select._listeners.change ?? []) cb();
    byText(en["modal.review.mark.add"]).click();
    expect(ownerSelect("99 12 34").value).toBe("nobody");
    applyButton().clickCB();
    expect(okResult(await p).parts[0]?.value).toBe(`Hallo Person_${ids.idOf(1)},\nSondernummer Telefon_${ids.idOf(2)}`);
  });
});

describe("Hülle", () => {
  it("createReviewFn liefert Ergebnis oder null, nie etwas Drittes", async () => {
    const fn = createReviewFn(app);
    const ctx = { documentKey: "d", table: sampleTable(), lang: "de" as const, places: [], parts: [], known: [], mark: () => [] };
    const p = fn([], ctx);
    lastModal().close();
    expect(await p).toBeNull();
    const q = fn([], ctx);
    applyButton().clickCB();
    expect(await q).toEqual({ answers: new Map(), marks: [] });
  });
});
