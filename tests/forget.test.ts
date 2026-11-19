// „Person vergessen“ als Ablauf (Bauplan Aufgabe 12 Schritt 1; Spec 8.3), gegen Fakes für Dialoge, Ablage und Schlüsselbund.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFs } from "./helpers/fake-fs";
import { sampleTable } from "./helpers/table-fixtures";
import { CHAIN, EXT, FOLDER, ID_A, ID_B, contentAt, makeDevice, personTable, seedFile, type Device } from "./helpers/store-fixtures";
import { KEY_SECRET_ID } from "../src/obsidian/key-store";
import { runForget } from "../src/obsidian/forget";
import type { KeyActionsHost, KeyActionsUi } from "../src/obsidian/key-actions";
import type { ForgetPlan, PersonOption } from "../src/core/forget-plan";
import { decodeRecoveryCode } from "../src/vendor/kit/recovery-code";
import { tableEntry, tableSetException, type PlaceholderTable } from "../src/vendor/kit/placeholder-table";

const CONSOLE = ["log", "info", "warn", "error", "debug", "trace"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => { spies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined)); });
afterEach(() => {
  const printed = spies.reduce((n, s) => n + s.mock.calls.length, 0);
  spies.forEach((s) => s.mockRestore());
  expect(printed).toBe(0);
});

interface Script { choose?: string | null | "first"; confirm?: boolean }

function fakeUi(log: string[], script: Script = {}): KeyActionsUi & { notices: { key: string; args: (string | number)[] }[]; offered: PersonOption[][]; plans: ForgetPlan[] } {
  const notices: { key: string; args: (string | number)[] }[] = [];
  const offered: PersonOption[][] = [];
  const plans: ForgetPlan[] = [];
  return {
    notices, offered, plans,
    choosePerson: (opts) => {
      log.push("ui:choose");
      offered.push([...opts]);
      const c = script.choose === undefined ? "first" : script.choose;
      return Promise.resolve(c === "first" ? (opts[0]?.id ?? null) : c);
    },
    confirmForget: (plan) => { log.push("ui:confirm"); plans.push(plan); return Promise.resolve(script.confirm ?? true); },
    confirmReplaceKey: () => Promise.resolve(true),
    confirmRemoveDevice: () => Promise.resolve(true),
    showCode: () => Promise.resolve(true),
    notify: (key, ...args) => { log.push(`ui:notice:${key}`); notices.push({ key, args }); },
  };
}

function host(d: Device, ui: KeyActionsUi): KeyActionsHost & { changes: number } {
  const h = { changes: 0, store: d.store, memory: d.memory, ownDeviceId: () => d.id, ui, changed: () => { h.changes++; } };
  return h;
}
const storedStand = (d: Device): number => {
  const c = decodeRecoveryCode(d.secrets.raw(KEY_SECRET_ID));
  if (!c.ok) throw new Error("kein Code");
  return c.stand;
};

async function readyDevice(fs: FakeFs, id: string, table: PlaceholderTable, log: string[] = []): Promise<Device> {
  await seedFile(fs, { deviceId: id, stand: 0, table, name: id });
  const d = makeDevice(fs, { deviceId: id, content: await contentAt(CHAIN, 0), name: id, log });
  await d.store.refresh();
  return d;
}
const twoPersons = (): PlaceholderTable => personTable(ID_B, "Berta Beispiel", sampleTable());

describe("runForget", () => {
  it("mit vorgewähltem Eintrag entfällt die Personenwahl; auch eine zusammengeführte (nicht kleinste) ID wählt die Gruppe; eine unbekannte ID scheitert mit Meldung und vergisst nichts", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons());
    const ui = fakeUi([]);
    expect(await runForget(host(a, ui), "zzzzzzzzzz")).toBe("failed");
    expect(ui.notices.map((n) => n.key)).toEqual(["notice.forget.failed.unknown-entry"]);
    expect(ui.offered).toHaveLength(0);
    expect(await runForget(host(a, fakeUi([])), ID_B)).toBe("done");
    expect(tableEntry(a.memory.table() as PlaceholderTable, ID_B)?.forgotten).toBe(true);
    expect(tableEntry(a.memory.table() as PlaceholderTable, ID_A)?.forgotten).toBe(false);
  });

  it("die Reihenfolge: frisch lesen, Person wählen, bestätigen, dann erst die Datei und DANN der Schlüssel", async () => {
    const fs = new FakeFs(FOLDER);
    const log: string[] = [];
    const a = await readyDevice(fs, "dev-a", twoPersons(), log);
    log.length = 0;
    const ui = fakeUi(log);
    expect(await runForget(host(a, ui))).toBe("done");
    const at = (k: string): number => log.indexOf(k);
    expect(at("ui:choose")).toBeGreaterThanOrEqual(0);
    expect(at("ui:confirm")).toBeGreaterThan(at("ui:choose"));
    expect(at("file:write")).toBeGreaterThan(at("ui:confirm"));
    expect(at("key:write:1")).toBeGreaterThan(at("file:done"));
    expect(ui.notices.map((n) => n.key)).toEqual(["notice.forget.done"]);
    expect(storedStand(a)).toBe(1);
    expect(tableEntry(a.memory.table() as PlaceholderTable, ID_A)?.forgotten).toBe(true);
  });

  it("liest vorher alle lesbaren Gerätedateien neu: eine Person, die ein anderes Gerät inzwischen angelegt hat, steht zur Wahl", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", personTable(ID_A, "Max Mustermann"));
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable(ID_B, "Berta Beispiel", personTable(ID_A, "Max Mustermann")) });
    const ui = fakeUi([], { choose: null });
    await runForget(host(a, ui));
    expect(ui.offered[0].map((o) => o.label).sort()).toEqual(["Berta Beispiel", "Max Mustermann"]);
  });

  it("der Dialog bekommt den Plan: Werte, nicht lesbare Geräte, Ausnahmeliste", async () => {
    const fs = new FakeFs(FOLDER);
    const ex = tableSetException(twoPersons(), "max@example.org", true);
    if (!ex.ok) throw new Error("fixture");
    const a = await readyDevice(fs, "dev-a", ex.table);
    // b hat eine Fassung, die a nicht lesen kann (andere Kette).
    await seedFile(fs, { deviceId: "dev-b", stand: 3, table: sampleTable(), name: "iPhone JK", chain: { chainId: Uint8Array.from([1, 2, 3, 4]), key: Uint8Array.from({ length: 32 }, (_, i) => i) } });
    const ui = fakeUi([], { confirm: false });
    await runForget(host(a, ui));
    const plan = ui.plans[0];
    expect(plan.option.id).toBe(ID_A);
    expect(plan.option.values.map((v) => v.text)).toContain("max@example.org");
    expect(plan.unreadableDevices).toEqual(["dev-b"]);
    expect(plan.exceptionListed).toBe(true);
  });

  it("Abbrechen bei der Wahl oder beim Bestätigen schreibt nichts und lässt den Schlüssel", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons());
    const before = a.secrets.raw(KEY_SECRET_ID);
    fs.clearLog();
    expect(await runForget(host(a, fakeUi([], { choose: null })))).toBe("cancelled");
    expect(await runForget(host(a, fakeUi([], { confirm: false })))).toBe("cancelled");
    expect(fs.log).toEqual([]);
    expect(a.secrets.raw(KEY_SECRET_ID)).toBe(before);
    expect(tableEntry(a.memory.table() as PlaceholderTable, ID_A)?.forgotten).toBe(false);
  });

  it("niemand zu vergessen: Hinweis, kein Dialog", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", sampleTable());
    await a.store.forget(ID_A);
    const ui = fakeUi([]);
    expect(await runForget(host(a, ui))).toBe("nothing");
    expect(ui.notices.map((n) => n.key)).toEqual(["notice.forget.none"]);
    expect(ui.offered).toEqual([]);
  });

  it("gesperrt oder nicht eingerichtet: Hinweis, kein Dialog, nichts geschrieben", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: sampleTable() });
    const locked = makeDevice(fs, { deviceId: "dev-b", content: null });
    const ui = fakeUi([]);
    expect(await runForget(host(locked, ui))).toBe("failed");
    expect(ui.notices.map((n) => n.key)).toEqual(["notice.locked"]);
    const empty = makeDevice(new FakeFs(FOLDER), { deviceId: "dev-c", content: null });
    const ui2 = fakeUi([]);
    expect(await runForget(host(empty, ui2))).toBe("failed");
    expect(ui2.notices.map((n) => n.key)).toEqual(["notice.notSetUp"]);
    expect(ui.offered).toEqual([]);
  });

  it("scheitert das Schreiben: Meldung ohne Klartext, nichts vergessen; die Meldung nennt keinen Namen", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons());
    fs.failWrites = true;
    const ui = fakeUi([]);
    expect(await runForget(host(a, ui))).toBe("failed");
    expect(ui.notices.map((n) => n.key)).toEqual(["notice.forget.failed.storage-failed"]);
    for (const n of ui.notices) expect(JSON.stringify(n)).not.toMatch(/Mustermann|example\.org|1234567/);
  });

  it("der Schlüssel lässt sich nicht ablegen: eigene Meldung, die Datei steht", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: twoPersons() });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0), keyWriteFails: true });
    await a.store.refresh();
    const ui = fakeUi([]);
    expect(await runForget(host(a, ui))).toBe("failed");
    expect(ui.notices.map((n) => n.key)).toEqual(["notice.forget.failed.key-write-failed"]);
    expect(fs.names()).toContain(`dev-a${EXT}`);
  });

  it("meldet jede Änderung an die Ansicht", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons());
    const h = host(a, fakeUi([]));
    await runForget(h);
    expect(h.changes).toBeGreaterThan(0);
  });
});
