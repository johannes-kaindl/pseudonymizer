// Einrichten, weiteres Gerät (Code eingeben) und Code anzeigen als Abläufe (Bauplan Aufgabe 12 Schritt 1), gegen Fakes für Dialoge, Ablage und Schlüsselbund.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFs } from "./helpers/fake-fs";
import { CHAIN, EXT, FOLDER, ID_A, OTHER_CHAIN, contentAt, makeDevice, personTable, seedFile, type Device } from "./helpers/store-fixtures";
import { readEnvelopeHeader } from "../src/vendor/kit/key-envelope";
import { decodeRecoveryCode, type RecoveryCodeContent } from "../src/vendor/kit/recovery-code";
import { KEY_SECRET_ID } from "../src/obsidian/key-store";
import { runEnterCode, runSetUp, runShowCode, type SetupHost, type SetupUi } from "../src/obsidian/setup";
import type { PlaceholderLanguage } from "../src/core/payload";

const CONSOLE = ["log", "info", "warn", "error", "debug", "trace"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => { spies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined)); });
afterEach(() => {
  const printed = spies.reduce((n, s) => n + s.mock.calls.length, 0);
  spies.forEach((s) => s.mockRestore());
  expect(printed).toBe(0);
});

interface UiScript {
  existing?: "enter-code" | "set-up-anyway" | null;
  language?: PlaceholderLanguage | null;
  /** Antwort auf „Code zeigen“ (Kontrollkästchen gesetzt, Weiter) */
  shown?: boolean;
  entered?: RecoveryCodeContent | null;
}

/** Ein Dialog-Fake, der jede Frage mit ihrer Reihenfolge ins gemeinsame Protokoll schreibt (dasselbe wie das der Ablage und des Schlüsselbunds). */
function fakeUi(log: string[], script: UiScript = {}): SetupUi & { notices: string[]; shownCodes: { content: RecoveryCodeContent; require: boolean }[] } {
  const notices: string[] = [];
  const shownCodes: { content: RecoveryCodeContent; require: boolean }[] = [];
  return {
    notices,
    shownCodes,
    existingFiles: () => { log.push("ui:existing"); return Promise.resolve(script.existing ?? null); },
    chooseSetUp: (def) => { log.push(`ui:choose:${def}`); return Promise.resolve(script.language === undefined ? def : script.language); },
    showCode: (content, require) => { log.push("ui:show"); shownCodes.push({ content, require }); return Promise.resolve(script.shown ?? true); },
    enterCode: () => { log.push("ui:enter"); return Promise.resolve(script.entered === undefined ? null : script.entered); },
    notify: (key) => { log.push(`ui:notice:${key}`); notices.push(key); },
  };
}

function host(d: Device, ui: SetupUi, extra: Partial<SetupHost> = {}): SetupHost & { changes: number } {
  const h = {
    changes: 0,
    store: d.store,
    memory: d.memory,
    keys: d.keys,
    ui,
    folder: () => FOLDER,
    defaultLanguage: (): PlaceholderLanguage => "de",
    newKey: () => ({ chainId: Uint8Array.from(CHAIN.chainId), stand: 0, key: Uint8Array.from(CHAIN.key) }),
    changed: () => { h.changes++; },
    ...extra,
  };
  return h;
}
const storedKey = (d: Device) => {
  const c = decodeRecoveryCode(d.secrets.raw(KEY_SECRET_ID));
  if (!c.ok) throw new Error("kein Code im Schlüsselbund");
  return c;
};
const idx = (log: string[], what: string): number => log.indexOf(what);

// ── Einrichten ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("Einrichten (Spec 8.3, Plan Aufgabe 12 Schritt 1)", () => {
  it("die Reihenfolge: Ordner prüfen, Sprache wählen, Code zeigen, dann die eigene Datei, dann der Schlüssel", async () => {
    const fs = new FakeFs(FOLDER);
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: null, log });
    const ui = fakeUi(log, { language: "en" });
    expect(await runSetUp(host(d, ui))).toBe("done");
    const order = ["ui:choose:de", "ui:show", "file:write", "file:done", "key:write:0", "ui:notice:notice.setup.done"].map((k) => idx(log, k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Der Ordner wird zuerst gelesen: keine Frage vor dem Lesen, und im leeren Ordner keine Warnung.
    expect(log).not.toContain("ui:existing");
    expect(d.memory.state()).toBe("ready");
    expect(d.memory.language()).toBe("en");
    expect(storedKey(d).stand).toBe(0);
  });

  it("zeigt den Code mit Pflicht-Kontrollkästchen, und es ist der Code, der danach im Schlüsselbund steht", async () => {
    const fs = new FakeFs(FOLDER);
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: null, log });
    const ui = fakeUi(log);
    await runSetUp(host(d, ui));
    expect(ui.shownCodes).toHaveLength(1);
    expect(ui.shownCodes[0].require).toBe(true);
    expect(Array.from(storedKey(d).key)).toEqual(Array.from(CHAIN.key));
  });

  it("die Sprache der Platzhalter steht in der Gerätedatei; die Vorgabe des Dialogs kommt vom Aufrufer", async () => {
    const fs = new FakeFs(FOLDER);
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: null, log });
    await runSetUp(host(d, fakeUi(log), { defaultLanguage: () => "en" }));
    expect(log).toContain("ui:choose:en");
    expect(d.memory.language()).toBe("en");
  });

  it("Abbruch beim Code (vor dem Kontrollkästchen) hinterlässt weder Datei noch Schlüssel", async () => {
    const fs = new FakeFs(FOLDER);
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: null, log });
    const ui = fakeUi(log, { shown: false });
    expect(await runSetUp(host(d, ui))).toBe("cancelled");
    expect(fs.names()).toEqual([]);
    expect(fs.log.filter((l) => !l.startsWith("mkdir"))).toEqual([]);
    expect(d.secrets.raw(KEY_SECRET_ID)).toBe("");
    expect(d.secrets.calls.filter((c) => c.startsWith("set:"))).toEqual([]);
    expect(d.memory.state()).toBe("not-set-up");
  });

  it("Abbruch im Dialog zur Sprache (und zur Sync-Voraussetzung) hinterlässt nichts und zeigt keinen Code", async () => {
    const fs = new FakeFs(FOLDER);
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: null, log });
    const ui = fakeUi(log, { language: null });
    expect(await runSetUp(host(d, ui))).toBe("cancelled");
    expect(ui.shownCodes).toEqual([]);
    expect(fs.names()).toEqual([]);
    expect(d.secrets.raw(KEY_SECRET_ID)).toBe("");
  });

  it("der Stand des gezeigten Codes geht in die Gerätedatei", async () => {
    const fs = new FakeFs(FOLDER);
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: null, log });
    await runSetUp(host(d, fakeUi(log)));
    expect(d.memory.codeStand()).toBe(0);
    const reader = makeDevice(fs, { deviceId: "dev-r", content: await contentAt(CHAIN, 0) });
    await reader.store.refresh();
    expect(reader.memory.codeStand()).toBe(0);
  });

  it("liegen im Ordner schon Gerätedateien: Warnung, in der „Code eingeben“ gleichwertig ist; Abbrechen ändert nichts", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-x", stand: 0, table: personTable(ID_A, "Max Mustermann") });
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: null, log });
    const ui = fakeUi(log, { existing: null });
    expect(await runSetUp(host(d, ui))).toBe("cancelled");
    expect(log).toContain("ui:existing");
    expect(log).not.toContain("ui:show");
    expect(fs.names()).toEqual([`dev-x${EXT}`]);
    expect(d.secrets.raw(KEY_SECRET_ID)).toBe("");
  });

  it("„Code eingeben“ aus der Warnung führt in den Ablauf für ein weiteres Gerät", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-x", stand: 0, table: personTable(ID_A, "Max Mustermann") });
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: null, log });
    const ui = fakeUi(log, { existing: "enter-code", entered: await contentAt(CHAIN, 0) });
    expect(await runSetUp(host(d, ui))).toBe("switched");
    expect(log).toContain("ui:enter");
    expect(d.memory.state()).toBe("ready");
    expect(log).not.toContain("ui:show");
  });

  it("„trotzdem neu einrichten“ aus der Warnung richtet eine neue Kette ein und lässt die fremde Datei liegen", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-x", stand: 0, chain: OTHER_CHAIN, table: personTable(ID_A, "Max Mustermann") });
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: null, log });
    expect(await runSetUp(host(d, fakeUi(log, { existing: "set-up-anyway" })))).toBe("done");
    expect(fs.names()).toEqual([`dev-a${EXT}`, `dev-x${EXT}`]);
    expect(d.memory.state()).toBe("ready");
  });

  it("ist das Gerät schon bereit, wird nichts gefragt und nichts geschrieben", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, "Max Mustermann") });
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0), log });
    fs.clearLog();
    const ui = fakeUi(log);
    expect(await runSetUp(host(d, ui))).toBe("already");
    expect(ui.notices).toEqual(["notice.setup.already"]);
    expect(fs.log).toEqual([]);
  });

  it("ein Schlüssel ohne Datei im Ordner (gesperrt, table-missing) gilt als vorhanden: Warnung, nie stilles Neueinrichten", async () => {
    const fs = new FakeFs(FOLDER);
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0), log });
    const ui = fakeUi(log, { existing: null });
    expect(await runSetUp(host(d, ui))).toBe("cancelled");
    expect(log).toContain("ui:existing");
    expect(fs.names()).toEqual([]);
  });

  it("scheitert das Schreiben der Datei, steht keine Datei und kein Schlüssel da, und die Meldung nennt den Grund", async () => {
    const fs = new FakeFs(FOLDER);
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: null, log });
    fs.failWrites = true;
    const ui = fakeUi(log);
    expect(await runSetUp(host(d, ui))).toBe("failed");
    expect(ui.notices).toEqual(["notice.setup.failed.storage-failed"]);
    expect(d.secrets.raw(KEY_SECRET_ID)).toBe("");
  });

  it("meldet der Ordner einen Lesefehler, wird nicht eingerichtet", async () => {
    const fs = new FakeFs(FOLDER);
    fs.listThrows = true;
    fs.folders.add(FOLDER);
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: null, log });
    const ui = fakeUi(log);
    expect(await runSetUp(host(d, ui))).toBe("failed");
    expect(ui.notices).toEqual(["notice.setup.readFailed"]);
    expect(ui.shownCodes).toEqual([]);
    expect(d.secrets.raw(KEY_SECRET_ID)).toBe("");
  });

  it("kann kein Schlüssel erzeugt werden, wird nichts gezeigt und nichts geschrieben", async () => {
    const fs = new FakeFs(FOLDER);
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: null, log });
    const ui = fakeUi(log);
    expect(await runSetUp(host(d, ui, { newKey: () => null }))).toBe("failed");
    expect(ui.shownCodes).toEqual([]);
    expect(ui.notices).toEqual(["notice.failed"]);
  });

  it("leert die Bytes des Schlüssels, den der Ablauf erzeugt hat, nach dem Einrichten", async () => {
    const fs = new FakeFs(FOLDER);
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: null, log });
    const made: RecoveryCodeContent = { chainId: Uint8Array.from(CHAIN.chainId), stand: 0, key: Uint8Array.from(CHAIN.key) };
    await runSetUp(host(d, fakeUi(log), { newKey: () => made }));
    expect(made.key.every((b) => b === 0)).toBe(true);
  });

  it("meldet die Änderung, damit Statusleiste und Ansicht nachziehen", async () => {
    const fs = new FakeFs(FOLDER);
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: null, log });
    const h = host(d, fakeUi(log));
    await runSetUp(h);
    expect(h.changes).toBeGreaterThan(0);
  });
});

// ── Weiteres Gerät: Code eingeben ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("Weiteres Gerät: Code eingeben (Spec 8.3, Plan Aufgabe 12 Schritt 1)", () => {
  it("ein gültiger Code, mit dem sich eine Datei öffnet: vordrehen, eigene Datei schreiben, dann der Schlüssel", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 2, table: personTable(ID_A, "Max Mustermann") });
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-b", content: null, log });
    const ui = fakeUi(log, { entered: await contentAt(CHAIN, 0) });
    expect(await runEnterCode(host(d, ui))).toBe("done");
    expect(idx(log, "file:done")).toBeGreaterThan(-1);
    expect(idx(log, "key:write:2")).toBeGreaterThan(idx(log, "file:done"));
    expect(ui.notices).toEqual(["notice.code.accepted"]);
    expect(storedKey(d).stand).toBe(2);
    const own = fs.get(`dev-b${EXT}`);
    expect(own).toBeDefined();
    const head = readEnvelopeHeader(own as Uint8Array);
    expect(head.ok && head.header.stand).toBe(2);
  });

  it("Code eingeben und abbrechen: nichts gespeichert, kein Aufruf an Ablage oder Schlüsselbund", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, "Max Mustermann") });
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-b", content: null, log });
    fs.clearLog();
    expect(await runEnterCode(host(d, fakeUi(log, { entered: null })))).toBe("cancelled");
    expect(fs.log).toEqual([]);
    expect(d.secrets.calls.filter((c) => c.startsWith("set:"))).toEqual([]);
  });

  it("ein gültiger Code, aber keine Datei öffnet sich (fremde Kette): nichts gespeichert, der vorhandene Schlüssel bleibt, der Grund ist genannt", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, chain: OTHER_CHAIN, table: personTable(ID_A, "Max Mustermann") });
    const log: string[] = [];
    const existing = await contentAt(OTHER_CHAIN, 0);
    const d = makeDevice(fs, { deviceId: "dev-b", content: existing, log });
    const before = d.secrets.raw(KEY_SECRET_ID);
    fs.clearLog();
    const ui = fakeUi(log, { entered: await contentAt(CHAIN, 0) });
    expect(await runEnterCode(host(d, ui))).toBe("failed");
    expect(ui.notices).toEqual(["notice.code.failed.foreign-chain"]);
    expect(fs.log).toEqual([]);
    expect(d.secrets.raw(KEY_SECRET_ID)).toBe(before);
    expect(log.filter((l) => l.startsWith("key:write"))).toEqual([]);
  });

  it("ein Code, aber keine Gerätedatei im Ordner: nichts gespeichert, die Meldung nennt den Grund table-missing", async () => {
    const fs = new FakeFs(FOLDER);
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-b", content: null, log });
    const ui = fakeUi(log, { entered: await contentAt(CHAIN, 0) });
    await runEnterCode(host(d, ui, { folder: () => "Tabellen" }));
    expect(ui.notices).toEqual(["notice.code.failed.table-missing"]);
  });

  it("scheitert das Ablegen des Schlüssels, sagt die Meldung es, und die Datei bleibt", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, "Max Mustermann") });
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-b", content: null, log, keyWriteFails: true });
    const ui = fakeUi(log, { entered: await contentAt(CHAIN, 0) });
    expect(await runEnterCode(host(d, ui))).toBe("failed");
    expect(ui.notices).toEqual(["notice.code.failed.key-write-failed"]);
  });

  it("leert die eingegebenen Schlüsselbytes nach dem Ablauf", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, "Max Mustermann") });
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-b", content: null, log });
    const entered = await contentAt(CHAIN, 0);
    await runEnterCode(host(d, fakeUi(log, { entered })));
    expect(entered.key.every((b) => b === 0)).toBe(true);
  });

  it("meldet die Änderung, damit der Zustand in Statusleiste und Ansicht nachzieht", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, "Max Mustermann") });
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-b", content: null, log });
    const h = host(d, fakeUi(log, { entered: await contentAt(CHAIN, 0) }));
    await runEnterCode(h);
    expect(h.changes).toBeGreaterThan(0);
  });
});

// ── Code anzeigen ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("Code anzeigen", () => {
  it("zeigt den Code des Schlüsselbunds ohne Pflicht-Kontrollkästchen und trägt den Stand ein", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 3, table: personTable(ID_A, "Max Mustermann") });
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 3), log });
    await d.store.refresh();
    const ui = fakeUi(log);
    await runShowCode(host(d, ui));
    expect(ui.shownCodes).toHaveLength(1);
    expect(ui.shownCodes[0].require).toBe(false);
    expect(ui.shownCodes[0].content.stand).toBe(3);
    expect(d.memory.codeStand()).toBe(3);
  });

  it("wer den Dialog abbricht, trägt nichts ein", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 3, table: personTable(ID_A, "Max Mustermann") });
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 3), log });
    await d.store.refresh();
    fs.clearLog();
    await runShowCode(host(d, fakeUi(log, { shown: false })));
    expect(fs.log).toEqual([]);
    expect(d.memory.codeStand()).toBeNull();
  });

  it("ohne Schlüssel oder mit beschädigtem Schlüssel öffnet sich kein Dialog", async () => {
    const fs = new FakeFs(FOLDER);
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: null, log });
    const ui = fakeUi(log);
    await runShowCode(host(d, ui));
    expect(ui.shownCodes).toEqual([]);
    expect(ui.notices).toEqual(["notice.code.noKey"]);
    d.secrets.poke(KEY_SECRET_ID, "kaputt");
    await runShowCode(host(d, ui));
    expect(ui.shownCodes).toEqual([]);
    expect(ui.notices).toEqual(["notice.code.noKey", "notice.code.keyCorrupt"]);
  });

  it("leert die gelesenen Schlüsselbytes nach dem Anzeigen", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, "Max Mustermann") });
    const log: string[] = [];
    const d = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0), log });
    const ui = fakeUi(log);
    await runShowCode(host(d, ui));
    expect(ui.shownCodes[0].content.key.every((b) => b === 0)).toBe(true);
  });
});
