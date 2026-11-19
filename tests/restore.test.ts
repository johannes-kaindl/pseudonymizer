import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/core/api";
import { MemoryTable } from "../src/core/memory-table";
import { PseudonymizerEngine } from "../src/obsidian/engine";
import { isPseudonymizerApi, type ApiError, type RestoreResult } from "../src/vendor/kit/pseudonymizer-source";
import { conflictTable, forgetPerson, ORG, PERSON, sampleTable, withValue } from "./helpers/table-fixtures";

function engineWith(table = sampleTable()): PseudonymizerEngine {
  const memory = new MemoryTable();
  memory.open(table);
  return new PseudonymizerEngine(memory);
}
const restore = (e: PseudonymizerEngine, text: string): RestoreResult => e.restore(text, "test") as RestoreResult;

describe("restore", () => {
  it("puts a further spelling back and keeps the punctuation around it", () => {
    expect(restore(engineWith(), `Hallo Person_${PERSON}_2,`)).toEqual({ text: "Hallo Max,", restored: 1, unknown: [], forgotten: [] });
  });

  it("restores the name and the mail address of a header line", () => {
    const r = restore(engineWith(), `Person_${PERSON} <Person_${PERSON}_Mail>`);
    expect(r).toEqual({ text: "Max Mustermann <max@example.org>", restored: 2, unknown: [], forgotten: [] });
  });

  it("reads spelling variants of a placeholder (review focus 3): case, English field word, second value", () => {
    const e = engineWith();
    expect(restore(e, "person_K3X9M2AB7Q_phone_2").text).toBe("0171 2345678");
    expect(restore(e, `Person_${PERSON}_Telefon_2`).text).toBe("0171 2345678");
    expect(restore(e, `PERSON_${PERSON.toUpperCase()}_MAIL`).text).toBe("max@example.org");
  });

  it("keeps the spelling of the value exactly as it was written, also with characters that mean something to a replacement", () => {
    const t = withValue(withValue(sampleTable(), PERSON, "address", "Hauptstr. 1, 12345 Musterstadt"), PERSON, null, "Dr. Max $& MUSTERMANN");
    const e = engineWith(t);
    expect(restore(e, `Person_${PERSON}_3`).text).toBe("Dr. Max $& MUSTERMANN");
    expect(restore(e, `Person_${PERSON}_Adresse`).text).toBe("Hauptstr. 1, 12345 Musterstadt");
  });

  it("replaces two equal placeholders next to each other, both", () => {
    expect(restore(engineWith(), `Person_${PERSON}_2 Person_${PERSON}_2`)).toMatchObject({ text: "Max Max", restored: 2 });
    expect(restore(engineWith(), `Person_${PERSON}_2,Person_${PERSON}_2`)).toMatchObject({ text: "Max,Max", restored: 2 });
  });

  it("leaves the longer word alone: Person_<id>_Mailbox is no placeholder and counts nowhere", () => {
    const text = `Person_${PERSON}_Mailbox`;
    expect(restore(engineWith(), text)).toEqual({ text, restored: 0, unknown: [], forgotten: [] });
  });

  it("does not read a placeholder glued to a longer word or to a second placeholder", () => {
    const e = engineWith();
    expect(restore(e, `xPerson_${PERSON}`)).toMatchObject({ restored: 0 });
    expect(restore(e, `Person_${PERSON}Person_${PERSON}`)).toMatchObject({ restored: 0 });
  });

  it("names a valid placeholder the table never issued as unknown and leaves it standing", () => {
    const text = `Hallo Organisation_${ORG} und Person_${PERSON}_2`;
    const r = restore(engineWith(), text);
    expect(r).toEqual({ text: `Hallo Organisation_${ORG} und Max`, restored: 1, unknown: [`Organisation_${ORG}`], forgotten: [] });
  });

  it("names the placeholders of a forgotten person as forgotten, not as unknown; they stay standing", () => {
    const e = engineWith(forgetPerson(sampleTable()));
    const text = `Person_${PERSON} schrieb an Person_${PERSON}_Mail`;
    expect(restore(e, text)).toEqual({ text, restored: 0, unknown: [], forgotten: [`Person_${PERSON}`, `Person_${PERSON}_Mail`] });
  });

  it("gives the raw text of the placeholders as written, in text order", () => {
    const r = restore(engineWith(forgetPerson(sampleTable())), `x person_${PERSON.toUpperCase()}_PHONE y Organisation_${ORG}`);
    expect(r.forgotten).toEqual([`person_${PERSON.toUpperCase()}_PHONE`]);
    expect(r.unknown).toEqual([`Organisation_${ORG}`]);
  });

  it("returns the empty result for the empty text", () => {
    expect(restore(engineWith(), "")).toEqual({ text: "", restored: 0, unknown: [], forgotten: [] });
  });

  it("treats a slot with two different values (a conflict) as unknown and puts neither into the text", () => {
    const e = engineWith(conflictTable());
    const text = `Person_${PERSON}_Mail_2`;
    const r = restore(e, text);
    expect(r).toEqual({ text, restored: 0, unknown: [text], forgotten: [] });
    // the unambiguous slot of the same person still resolves
    expect(restore(e, `Person_${PERSON}_Mail`).text).toBe("max@example.org");
  });
});

describe("containsPlaceholder", () => {
  it("is a question of the text alone: true for a placeholder, also for one the table does not know", () => {
    const e = engineWith();
    expect(e.containsPlaceholder(`Hallo Person_${PERSON}_2`)).toBe(true);
    expect(e.containsPlaceholder(`Organisation_${ORG}`)).toBe(true);
    expect(e.containsPlaceholder(`Person_${PERSON}_Mailbox`)).toBe(false);
    expect(e.containsPlaceholder("Hallo Max")).toBe(false);
    expect(e.containsPlaceholder("")).toBe(false);
  });
  it("answers before anything is set up", () => {
    expect(new PseudonymizerEngine(new MemoryTable()).containsPlaceholder(`Person_${PERSON}`)).toBe(true);
  });
});

describe("engine state", () => {
  it("is not-set-up with nothing opened, and refuses restore and transform as values", async () => {
    const e = new PseudonymizerEngine(new MemoryTable());
    expect(e.state()).toBe("not-set-up");
    expect((e.restore(`Person_${PERSON}`, "test") as ApiError).error).toBe("not-ready");
    expect(((await e.transform({ caller: "x", documentKey: "d", interactive: false, parts: [] })) as ApiError).error).toBe("not-ready");
  });
  it("is ready when a table is injected", () => {
    expect(engineWith().state()).toBe("ready");
  });
  it("refuses restore while the memory holds no table, even if the state says ready elsewhere", () => {
    const memory = new MemoryTable();
    memory.open(sampleTable());
    memory.lock("table-missing");
    const e = new PseudonymizerEngine(memory);
    expect(e.state()).toBe("locked");
    expect((e.restore(`Person_${PERSON}`, "test") as ApiError).error).toBe("locked");
  });
});

describe("through the plugin api", () => {
  it("restore returns the contract type with raw texts, and the guard accepts the api", () => {
    const api = createApi(() => engineWith());
    expect(isPseudonymizerApi(api)).toBe(true);
    expect(api.status()).toEqual({ state: "ready" });
    expect(api.restore(`Hallo Person_${PERSON}_2, Organisation_${ORG}`, { caller: "test" })).toEqual({
      text: `Hallo Max, Organisation_${ORG}`, restored: 1, unknown: [`Organisation_${ORG}`], forgotten: [],
    });
    expect(api.containsPlaceholder(`Person_${PERSON}`)).toBe(true);
  });
  it("prints no value to the console", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    restore(engineWith(), `Person_${PERSON} Person_${PERSON}_Mail Organisation_${ORG}`);
    expect(spies.reduce((n, s) => n + s.mock.calls.length, 0)).toBe(0);
    spies.forEach((s) => s.mockRestore());
  });
});
