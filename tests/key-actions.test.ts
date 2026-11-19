// Schlüssel ersetzen und Gerät entfernen als Abläufe (Bauplan Aufgabe 12 Schritt 1; Spec 8.3), gegen Fakes für Dialoge, Ablage und Schlüsselbund.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFs } from "./helpers/fake-fs";
import { sampleTable } from "./helpers/table-fixtures";
import { CHAIN, EXT, FOLDER, ID_A, ID_B, contentAt, makeDevice, personTable, seedFile, type Device } from "./helpers/store-fixtures";
import { KEY_SECRET_ID } from "../src/obsidian/key-store";
import { runRemoveDevice, runReplaceKey, type KeyActionsHost, type KeyActionsUi } from "../src/obsidian/key-actions";
import { decodeRecoveryCode, type RecoveryCodeContent } from "../src/vendor/kit/recovery-code";
import type { PlaceholderTable } from "../src/vendor/kit/placeholder-table";

const CONSOLE = ["log", "info", "warn", "error", "debug", "trace"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => { spies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined)); });
afterEach(() => {
  const printed = spies.reduce((n, s) => n + s.mock.calls.length, 0);
  spies.forEach((s) => s.mockRestore());
  expect(printed).toBe(0);
});

interface Script { confirmReplace?: boolean; shown?: boolean; confirmRemove?: boolean }

function fakeUi(log: string[], script: Script = {}): KeyActionsUi & { notices: string[]; shownCodes: { content: RecoveryCodeContent; require: boolean }[]; removeAsked: { name: string; readable: boolean }[] } {
  const notices: string[] = [];
  const shownCodes: { content: RecoveryCodeContent; require: boolean }[] = [];
  const removeAsked: { name: string; readable: boolean }[] = [];
  return {
    notices, shownCodes, removeAsked,
    choosePerson: () => Promise.resolve(null),
    confirmForget: () => Promise.resolve(false),
    confirmReplaceKey: () => { log.push("ui:confirm-replace"); return Promise.resolve(script.confirmReplace ?? true); },
    confirmRemoveDevice: (device) => { log.push("ui:confirm-remove"); removeAsked.push(device); return Promise.resolve(script.confirmRemove ?? true); },
    showCode: (content, require) => { log.push("ui:show"); shownCodes.push({ content: { chainId: Uint8Array.from(content.chainId), stand: content.stand, key: Uint8Array.from(content.key) }, require }); return Promise.resolve(script.shown ?? true); },
    notify: (key) => { log.push(`ui:notice:${key}`); notices.push(key); },
  };
}

const NEW_KEY = (): RecoveryCodeContent => ({ chainId: Uint8Array.from([0xab, 0xcd, 0x03, 0x03]), stand: 0, key: Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 7) & 0xff) });

function host(d: Device, ui: KeyActionsUi, extra: Partial<KeyActionsHost> = {}): KeyActionsHost & { changes: number } {
  const h = { changes: 0, store: d.store, memory: d.memory, ownDeviceId: () => d.id, ui, newKey: NEW_KEY, changed: () => { h.changes++; }, ...extra };
  return h;
}
const stored = (d: Device) => {
  const c = decodeRecoveryCode(d.secrets.raw(KEY_SECRET_ID));
  if (!c.ok) throw new Error("kein Code");
  return c;
};
async function readyDevice(fs: FakeFs, id: string, table: PlaceholderTable, log: string[] = []): Promise<Device> {
  await seedFile(fs, { deviceId: id, stand: 0, table, name: id });
  const d = makeDevice(fs, { deviceId: id, content: await contentAt(CHAIN, 0), name: id, log });
  await d.store.refresh();
  return d;
}
const twoPersons = (): PlaceholderTable => personTable(ID_B, "Berta Beispiel", sampleTable());

describe("runReplaceKey", () => {
  it("die Reihenfolge: frisch lesen, bestätigen, neuen Code zeigen (mit Kontrollkästchen), dann die Datei, dann der Schlüssel", async () => {
    const fs = new FakeFs(FOLDER);
    const log: string[] = [];
    const a = await readyDevice(fs, "dev-a", twoPersons(), log);
    log.length = 0;
    const ui = fakeUi(log);
    expect(await runReplaceKey(host(a, ui))).toBe("done");
    const at = (k: string): number => log.indexOf(k);
    expect(at("ui:show")).toBeGreaterThan(at("ui:confirm-replace"));
    expect(at("file:write")).toBeGreaterThan(at("ui:show"));
    expect(at("key:write:0")).toBeGreaterThan(at("file:done"));
    expect(ui.shownCodes).toHaveLength(1);
    expect(ui.shownCodes[0].require).toBe(true);
    expect(Array.from(ui.shownCodes[0].content.chainId)).toEqual([0xab, 0xcd, 0x03, 0x03]);
    expect(Array.from(stored(a).chainId)).toEqual([0xab, 0xcd, 0x03, 0x03]);
    expect(ui.notices).toEqual(["notice.replace.done"]);
  });

  it("Abbruch vor dem Bestätigen oder beim Code (vor dem Kontrollkästchen) hinterlässt weder neue Datei noch neuen Schlüssel", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons());
    const before = a.secrets.raw(KEY_SECRET_ID);
    const bytes = fs.get(`dev-a${EXT}`);
    fs.clearLog();
    expect(await runReplaceKey(host(a, fakeUi([], { confirmReplace: false })))).toBe("cancelled");
    const ui = fakeUi([], { shown: false });
    expect(await runReplaceKey(host(a, ui))).toBe("cancelled");
    expect(fs.log).toEqual([]);
    expect(fs.get(`dev-a${EXT}`)).toEqual(bytes);
    expect(a.secrets.raw(KEY_SECRET_ID)).toBe(before);
  });

  it("der gezeigte Schlüssel wird nach dem Ablauf geleert", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons());
    const made = NEW_KEY();
    await runReplaceKey(host(a, fakeUi([]), { newKey: () => made }));
    expect(Array.from(made.key).every((b) => b === 0)).toBe(true);
  });

  it("gesperrt: Hinweis, keine Frage, nichts geschrieben (nie eine leere Tabelle unter neuer Kette)", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, chain: { chainId: Uint8Array.from([9, 9, 9, 9]), key: Uint8Array.from({ length: 32 }, (_, i) => i) }, table: twoPersons() });
    const b = makeDevice(fs, { deviceId: "dev-b", content: await contentAt(CHAIN, 0) });
    const ui = fakeUi([]);
    fs.clearLog();
    expect(await runReplaceKey(host(b, ui))).toBe("failed");
    expect(ui.notices).toEqual(["notice.locked"]);
    expect(ui.shownCodes).toEqual([]);
    expect(fs.log).toEqual([]);
  });

  it("scheitert das Schreiben: Meldung, alter Schlüssel bleibt", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons());
    const before = a.secrets.raw(KEY_SECRET_ID);
    fs.failWrites = true;
    const ui = fakeUi([]);
    expect(await runReplaceKey(host(a, ui))).toBe("failed");
    expect(ui.notices).toEqual(["notice.replace.failed.storage-failed"]);
    expect(a.secrets.raw(KEY_SECRET_ID)).toBe(before);
  });

  it("kein Zufall verfügbar: Meldung, keine Frage zum Code", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons());
    const ui = fakeUi([]);
    expect(await runReplaceKey(host(a, ui, { newKey: () => null }))).toBe("failed");
    expect(ui.notices).toEqual(["notice.failed"]);
    expect(ui.shownCodes).toEqual([]);
  });
});

describe("runRemoveDevice", () => {
  it("fragt mit dem Namen und dem Zustand der Fassung, übernimmt, löscht und meldet", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", personTable(ID_A, "Max Mustermann"));
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable(ID_B, "Berta Beispiel"), name: "iPhone JK" });
    const ui = fakeUi([]);
    expect(await runRemoveDevice(host(a, ui), "dev-b")).toBe("done");
    expect(ui.removeAsked).toEqual([{ name: "iPhone JK", readable: true }]);
    expect(fs.names()).not.toContain(`dev-b${EXT}`);
    expect(ui.notices).toEqual(["notice.device.removed"]);
  });

  it("eine nicht lesbare Fassung: der Dialog bekommt readable=false (Warnung vor dem Verlust), und die Meldung nennt den Verlust", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons());
    await a.store.forget(ID_B);
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable("q7d2w8n4tz", "Carla Beispiel") });
    const ui = fakeUi([]);
    expect(await runRemoveDevice(host(a, ui), "dev-b")).toBe("done");
    expect(ui.removeAsked).toEqual([{ name: "dev-b", readable: false }]);
    expect(ui.notices).toEqual(["notice.device.removed.lost"]);
  });

  it("Abbrechen löscht nichts und schreibt nichts", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons());
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: twoPersons() });
    fs.clearLog();
    expect(await runRemoveDevice(host(a, fakeUi([], { confirmRemove: false })), "dev-b")).toBe("cancelled");
    expect(fs.log).toEqual([]);
    expect(fs.names()).toContain(`dev-b${EXT}`);
  });

  it("das eigene Gerät und ein unbekanntes Gerät: Hinweis, keine Frage", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons());
    const ui = fakeUi([]);
    expect(await runRemoveDevice(host(a, ui), "dev-a")).toBe("failed");
    expect(await runRemoveDevice(host(a, ui), "dev-zzz")).toBe("failed");
    expect(ui.removeAsked).toEqual([]);
    expect(ui.notices).toEqual(["notice.device.own", "notice.device.gone"]);
    expect(fs.names()).toEqual([`dev-a${EXT}`]);
  });

  it("scheitert das Schreiben der eigenen Fassung: Meldung, die fremde Datei bleibt", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons());
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: twoPersons() });
    await a.store.refresh();
    fs.failWrites = true;
    const ui = fakeUi([]);
    expect(await runRemoveDevice(host(a, ui), "dev-b")).toBe("failed");
    expect(ui.notices).toEqual(["notice.device.failed.storage-failed"]);
    expect(fs.names()).toContain(`dev-b${EXT}`);
  });

  it("gesperrt: Hinweis, keine Frage", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: twoPersons() });
    const a = makeDevice(fs, { deviceId: "dev-a", content: null });
    const ui = fakeUi([]);
    expect(await runRemoveDevice(host(a, ui), "dev-b")).toBe("failed");
    expect(ui.notices).toEqual(["notice.locked"]);
    expect(fs.names()).toContain(`dev-b${EXT}`);
  });
});
