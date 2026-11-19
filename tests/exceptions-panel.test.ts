// Reiter „Ausnahmen“ (Bauplan Aufgabe 18, Spec 8.2, 8.9): die Liste liegt in der Tabelle, hinzufügen und entfernen gehen über `persist`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/i18n/strings";
import { setLang } from "../src/vendor/kit/i18n";
import { renderExceptions } from "../src/obsidian/exceptions-panel";
import { serializeTable, tableExceptions, tableIsException, tableSetException } from "../src/vendor/kit/placeholder-table";
import { all, buttonTexts, click, noticeKeys, one, personsRig, richTable, textOf, type El, type PersonsRig, type Script } from "./helpers/persons-rig";
import { must } from "./helpers/table-fixtures";

const CONSOLE = ["log", "info", "warn", "error", "debug", "trace"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  setLang("en");
  spies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  const printed = spies.reduce((n, s) => n + s.mock.calls.length, 0);
  spies.forEach((s) => s.mockRestore());
  expect(printed).toBe(0);
});

async function mounted(script: Script = {}, table = richTable()): Promise<{ r: PersonsRig; parent: El }> {
  const r = await personsRig({ table, script });
  const parent = r.mount((p) => { renderExceptions(p, r.api); });
  return { r, parent };
}
const items = (parent: El): string[] => all(parent, ".pseu-exception-text").map(textOf);
const add = (parent: El): void => { click(one(parent, ".pseu-exception-add")); };

describe("Reiter Ausnahmen", () => {
  it("ohne Ausnahmen steht der Leerzustand mit genau einem Knopf „Ausnahme hinzufügen“ (mod-cta)", async () => {
    const { parent } = await mounted();
    expect(all(parent, ".pseu-empty")).toHaveLength(1);
    expect(textOf(one(parent, ".pseu-empty"))).toContain("No exceptions yet");
    expect(buttonTexts(parent)).toEqual(["Add exception"]);
    expect(one(parent, ".pseu-exception-add").hasClass("mod-cta")).toBe(true);
  });

  it("hinzufügen: der Text landet in der Tabelle und in der Gerätedatei, die Liste zeigt ihn, die Meldung nennt ihn nicht", async () => {
    const { r, parent } = await mounted({ exception: "Beispiel GmbH" });
    add(parent);
    await r.idle();
    expect(noticeKeys(r)).toEqual(["notice.exceptions.added"]);
    expect(tableIsException(r.table(), "beispiel gmbh")).toBe(true);
    const file = await r.fileTable();
    expect(tableExceptions(file)).toEqual(["Beispiel GmbH"]);
    expect(items(parent)).toEqual(["Beispiel GmbH"]);
    expect(all(parent, ".pseu-empty")).toHaveLength(0);
    for (const n of r.notices) expect(JSON.stringify(n)).not.toContain("Beispiel");
  });

  it("Abbrechen im Dialog ändert nichts; derselbe Text in anderer Schreibweise ist nichts Neues und sagt es", async () => {
    const script: Script = { exception: null };
    const { r, parent } = await mounted(script);
    r.fs.clearLog();
    add(parent);
    await r.idle();
    expect(r.fs.mutations).toBe(0);
    expect(r.persistCalls.n).toBe(0);
    script.exception = "Beispiel GmbH";
    add(parent);
    await r.idle();
    script.exception = "  BEISPIEL   gmbh ";
    add(parent);
    await r.idle();
    expect(noticeKeys(r)).toEqual(["notice.exceptions.added", "notice.exceptions.already"]);
    expect(tableExceptions(r.table())).toHaveLength(1);
  });

  it("entfernen: der Text verschwindet aus Tabelle, Datei und Liste (das Entfernen ist selbst eine Änderung, die gegen ein älteres Gerät gewinnt)", async () => {
    const start = must(tableSetException(must(tableSetException(richTable(), "Beispiel GmbH", true)), "Zweite Firma", true));
    const { r, parent } = await mounted({}, start);
    expect(items(parent)).toEqual(["Beispiel GmbH", "Zweite Firma"]);
    click(all(parent, ".pseu-exception-remove")[0]);
    await r.idle();
    expect(noticeKeys(r)).toEqual(["notice.exceptions.removed"]);
    expect(items(parent)).toEqual(["Zweite Firma"]);
    expect(tableIsException(r.table(), "Beispiel GmbH")).toBe(false);
    expect(tableExceptions(await r.fileTable())).toEqual(["Zweite Firma"]);
  });

  it("die Knöpfe zum Entfernen tragen eine Nummer, nie den Text, im aria-label", async () => {
    const { parent } = await mounted({}, must(tableSetException(richTable(), "Geheime Firma", true)));
    const labels = all(parent, ".pseu-exception-remove").map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Remove exception 1"]);
  });

  it("scheitert das Schreiben, meldet eine Notice den Fehler und die Tabelle bleibt unverändert", async () => {
    const { r, parent } = await mounted({ exception: "Beispiel GmbH" });
    const before = serializeTable(r.table());
    r.fs.failWrites = true;
    add(parent);
    await r.idle();
    expect(noticeKeys(r)).toEqual(["notice.exceptions.storage"]);
    expect(serializeTable(r.table())).toBe(before);
    expect(items(parent)).toEqual([]);
    // Entfernen scheitert ebenso
    r.fs.failWrites = false;
    r.script.exception = "Zweite Firma";
    add(parent);
    await r.idle();
    r.notices.length = 0;
    r.fs.failWrites = true;
    click(one(parent, ".pseu-exception-remove"));
    await r.idle();
    expect(noticeKeys(r)).toEqual(["notice.exceptions.storage"]);
    expect(tableIsException(r.table(), "Zweite Firma")).toBe(true);
  });
});
