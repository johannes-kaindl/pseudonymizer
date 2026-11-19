// Einrichten und Code eingeben auf der Ebene des Bausteins (Bauplan Aufgabe 12 Schritt 1): `setUp`, `adopt`, `markCodeShown`, Geräteliste im gesperrten Zustand.
// Echtes WebCrypto, echte Kit-Bausteine; gefälscht sind Ablage und Schlüsselbund.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFs } from "./helpers/fake-fs";
import {
  CHAIN, EXT, FOLDER, ID_A, ID_B, OTHER_CHAIN, contentAt, makeDevice, personTable, seedFile, stateAt, type Device,
} from "./helpers/store-fixtures";
import { decodeRecoveryCode } from "../src/vendor/kit/recovery-code";
import { readEnvelopeHeader, openEnvelope } from "../src/vendor/kit/key-envelope";
import { encryptionKey } from "../src/vendor/kit/key-ratchet";
import { KEY_SECRET_ID } from "../src/obsidian/key-store";
import { decodePayload } from "../src/core/payload";
import { parseTable, tableEntry, type PlaceholderTable } from "../src/vendor/kit/placeholder-table";

const CONSOLE = ["log", "info", "warn", "error", "debug", "trace"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => { spies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined)); });
afterEach(() => {
  const printed = spies.reduce((n, s) => n + s.mock.calls.length, 0);
  spies.forEach((s) => s.mockRestore());
  expect(printed).toBe(0);
});

const MAX = "Max Mustermann";
const BERTA = "Berta Beispiel";
const nameOf = (t: PlaceholderTable | null, id: string): string | undefined =>
  t === null ? undefined : tableEntry(t, id)?.values.find((v) => v.value.field === null)?.value.text;
const storedKey = (d: Device) => {
  const c = decodeRecoveryCode(d.secrets.raw(KEY_SECRET_ID));
  if (!c.ok) throw new Error("kein Code im Schlüsselbund");
  return c;
};
/** Öffnet die Datei eines Geräts mit dem Schlüssel seines Standes und gibt Inhalt und Kopf zurück. */
async function openOf(fs: FakeFs, deviceId: string, chain = CHAIN) {
  const bytes = fs.get(`${deviceId}${EXT}`);
  if (bytes === undefined) throw new Error(`keine Datei ${deviceId}`);
  const h = readEnvelopeHeader(bytes);
  if (!h.ok) throw new Error("Kopf");
  const k = await encryptionKey(await stateAt(chain, h.header.stand));
  if (!k.ok) throw new Error("Schlüssel");
  const o = await openEnvelope(k.value, bytes);
  if (!o.ok) throw new Error("öffnen");
  const p = decodePayload(o.plaintext);
  if ("error" in p) throw new Error("Inhalt");
  const t = typeof p.table === "string" ? parseTable(p.table) : null;
  if (t === null || !t.ok) throw new Error("Tabelle");
  return { header: h.header, payload: p, table: t.table };
}
const keyIndex = (d: Device): number => d.log.findIndex((l) => l.startsWith("key:write"));
const fileIndex = (d: Device): number => d.log.findIndex((l) => l === "file:write" || l === "file:replace-damaged");

// ── adopt: weiteres Gerät ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("adopt: Code eines weiteren Geräts (Spec 8.3)", () => {
  it("öffnet die Datei des anderen Geräts, schreibt die eigene Datei und legt DANACH den Schlüssel ab", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    const b = makeDevice(fs, { deviceId: "dev-b", content: null });
    await b.store.refresh();
    expect(b.memory.state()).toBe("locked");
    expect(b.memory.reason()).toBe("no-key");
    const r = await b.store.adopt(await contentAt(CHAIN, 0));
    expect(r).toEqual({ ok: true });
    expect(b.memory.state()).toBe("ready");
    expect(nameOf(b.memory.table(), ID_A)).toBe(MAX);
    expect(fs.names()).toEqual([`dev-a${EXT}`, `dev-b${EXT}`]);
    expect(fileIndex(b)).toBeGreaterThanOrEqual(0);
    expect(keyIndex(b)).toBeGreaterThan(fileIndex(b));
    expect(b.log.indexOf("file:done")).toBeLessThan(keyIndex(b));
    expect(storedKey(b).stand).toBe(0);
    // Die eigene Datei trägt, was gelesen wurde.
    const own = await openOf(fs, "dev-b");
    expect(nameOf(own.table, ID_A)).toBe(MAX);
  });

  it("dreht bis zur neuesten lesbaren Datei vor und legt den Schlüssel dieses Standes ab", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 2, table: personTable(ID_A, MAX) });
    const b = makeDevice(fs, { deviceId: "dev-b", content: null });
    expect(await b.store.adopt(await contentAt(CHAIN, 0))).toEqual({ ok: true });
    expect(storedKey(b).stand).toBe(2);
    expect(b.memory.stand()).toBe(2);
    expect((await openOf(fs, "dev-b")).header.stand).toBe(2);
    expect(storedKey(b).key).toEqual((await contentAt(CHAIN, 2)).key);
  });

  it("Code einer fremden Kette: nichts wird geschrieben, der vorhandene Schlüssel bleibt, der Grund ist genannt", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, chain: OTHER_CHAIN, table: personTable(ID_A, MAX) });
    const existing = await contentAt(OTHER_CHAIN, 0);
    const b = makeDevice(fs, { deviceId: "dev-b", content: existing });
    const before = b.secrets.raw(KEY_SECRET_ID);
    fs.clearLog();
    const r = await b.store.adopt(await contentAt(CHAIN, 0));
    expect(r).toEqual({ ok: false, reason: "foreign-chain" });
    expect(fs.log).toEqual([]);
    expect(b.log.filter((l) => l.startsWith("key:write"))).toEqual([]);
    expect(b.secrets.raw(KEY_SECRET_ID)).toBe(before);
    expect(fs.names()).toEqual([`dev-a${EXT}`]);
  });

  it("Code ohne Gerätedatei im Ordner: nichts gespeichert, Grund table-missing", async () => {
    const fs = new FakeFs(FOLDER);
    const b = makeDevice(fs, { deviceId: "dev-b", content: null });
    const r = await b.store.adopt(await contentAt(CHAIN, 0));
    expect(r).toEqual({ ok: false, reason: "table-missing" });
    expect(fs.names()).toEqual([]);
    expect(b.secrets.raw(KEY_SECRET_ID)).toBe("");
  });

  it("Code, der neuer ist als jede Datei: nichts gespeichert, Grund key-opens-nothing", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 1, table: personTable(ID_A, MAX) });
    const b = makeDevice(fs, { deviceId: "dev-b", content: null });
    const r = await b.store.adopt(await contentAt(CHAIN, 3));
    expect(r).toEqual({ ok: false, reason: "key-opens-nothing" });
    expect(b.secrets.raw(KEY_SECRET_ID)).toBe("");
    expect(fs.names()).toEqual([`dev-a${EXT}`]);
  });

  it("eine beschädigte Datei allein: nichts gespeichert, Grund unreadable, die Datei bleibt unberührt", async () => {
    const fs = new FakeFs(FOLDER);
    fs.put(`dev-a${EXT}`, "kein Umschlag");
    const b = makeDevice(fs, { deviceId: "dev-b", content: null });
    const r = await b.store.adopt(await contentAt(CHAIN, 0));
    expect(r).toEqual({ ok: false, reason: "unreadable" });
    expect(new TextDecoder().decode(fs.get(`dev-a${EXT}`))).toBe("kein Umschlag");
    expect(b.secrets.raw(KEY_SECRET_ID)).toBe("");
  });

  it("der Zustand des Geräts ändert sich bei einem Fehlschlag nicht (gesperrt bleibt mit seinem Grund)", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, chain: OTHER_CHAIN, table: personTable(ID_A, MAX) });
    const b = makeDevice(fs, { deviceId: "dev-b", content: null });
    await b.store.refresh();
    expect(b.memory.reason()).toBe("no-key");
    await b.store.adopt(await contentAt(CHAIN, 0));
    expect(b.memory.state()).toBe("locked");
    expect(b.memory.reason()).toBe("no-key");
  });

  it("scheitert das Schreiben der Datei: nichts gespeichert, kein Schlüssel", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    const b = makeDevice(fs, { deviceId: "dev-b", content: null });
    fs.failWrites = true;
    const r = await b.store.adopt(await contentAt(CHAIN, 0));
    expect(r).toEqual({ ok: false, reason: "storage-failed" });
    expect(b.secrets.raw(KEY_SECRET_ID)).toBe("");
    expect(fs.names()).toEqual([`dev-a${EXT}`]);
  });

  it("scheitert das Ablegen des Schlüssels: die Datei steht, der Grund ist key-write-failed", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    const b = makeDevice(fs, { deviceId: "dev-b", content: null, keyWriteFails: true });
    const r = await b.store.adopt(await contentAt(CHAIN, 0));
    expect(r).toEqual({ ok: false, reason: "key-write-failed" });
    expect(fs.names()).toContain(`dev-b${EXT}`);
  });

  it("lässt die Bytes des übergebenen Schlüssels unberührt (der Aufrufer leert sie selbst)", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 1, table: personTable(ID_A, MAX) });
    const b = makeDevice(fs, { deviceId: "dev-b", content: null });
    const c = await contentAt(CHAIN, 0);
    const copy = Uint8Array.from(c.key);
    await b.store.adopt(c);
    expect(c.key).toEqual(copy);
  });

  it("ein Code der eigenen Kette auf einem Gerät mit eigener Datei: öffnet, schreibt neu, legt den Schlüssel ab", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable(ID_B, BERTA) });
    const b = makeDevice(fs, { deviceId: "dev-b", content: null });
    expect(await b.store.adopt(await contentAt(CHAIN, 0))).toEqual({ ok: true });
    expect(nameOf(b.memory.table(), ID_A)).toBe(MAX);
    expect(nameOf(b.memory.table(), ID_B)).toBe(BERTA);
    expect(storedKey(b).stand).toBe(0);
  });
});

// ── setUp: erstes Gerät ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("setUp: neue Kette (Spec 8.3 „Einrichten“)", () => {
  it("schreibt die eigene Datei (leere Tabelle, Sprache, Name, Stand des Codes) und legt DANACH den Schlüssel ab", async () => {
    const fs = new FakeFs(FOLDER);
    const a = makeDevice(fs, { deviceId: "dev-a", content: null, name: "Mac Büro" });
    const content = await contentAt(CHAIN, 0);
    expect(await a.store.setUp(content, "en")).toEqual({ ok: true });
    expect(fileIndex(a)).toBeGreaterThanOrEqual(0);
    expect(keyIndex(a)).toBeGreaterThan(a.log.indexOf("file:done"));
    expect(a.memory.state()).toBe("ready");
    expect(a.memory.stand()).toBe(0);
    expect(a.memory.language()).toBe("en");
    expect(a.memory.codeStand()).toBe(0);
    const own = await openOf(fs, "dev-a");
    expect(own.payload.device).toEqual({ name: "Mac Büro", codeShownAtStand: 0 });
    expect(own.payload.vault.language).toBe("en");
    expect(own.table.entries).toEqual([]);
    expect(own.header.stand).toBe(0);
    expect(storedKey(a).stand).toBe(0);
    expect(storedKey(a).key).toEqual(content.key);
    expect(a.memory.devices().map((d) => d.deviceId)).toEqual(["dev-a"]);
  });

  it("scheitert das Schreiben der Datei: weder Datei noch Schlüssel", async () => {
    const fs = new FakeFs(FOLDER);
    const a = makeDevice(fs, { deviceId: "dev-a", content: null });
    fs.failWrites = true;
    expect(await a.store.setUp(await contentAt(CHAIN, 0), "de")).toEqual({ ok: false, reason: "storage-failed" });
    expect(fs.names()).toEqual([]);
    expect(a.secrets.raw(KEY_SECRET_ID)).toBe("");
    expect(a.memory.state()).toBe("not-set-up");
  });

  it("scheitert das Ablegen des Schlüssels: Grund key-write-failed, die Datei steht", async () => {
    const fs = new FakeFs(FOLDER);
    const a = makeDevice(fs, { deviceId: "dev-a", content: null, keyWriteFails: true });
    expect(await a.store.setUp(await contentAt(CHAIN, 0), "de")).toEqual({ ok: false, reason: "key-write-failed" });
    expect(fs.names()).toEqual([`dev-a${EXT}`]);
  });

  it("eine vorhandene eigene Datei einer anderen Kette wird beiseitegelegt, nie überschrieben; fremde Dateien bleiben", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, chain: OTHER_CHAIN, table: personTable(ID_A, MAX) });
    await seedFile(fs, { deviceId: "dev-b", stand: 0, chain: OTHER_CHAIN, table: personTable(ID_B, BERTA) });
    const oldBytes = fs.get(`dev-a${EXT}`);
    const a = makeDevice(fs, { deviceId: "dev-a", content: null });
    expect(await a.store.setUp(await contentAt(CHAIN, 0), "de")).toEqual({ ok: true });
    expect(a.log).toContain("file:replace-damaged");
    const aside = fs.names().filter((n) => n.includes(".damaged-"));
    expect(aside).toHaveLength(1);
    expect(fs.get(aside[0])).toEqual(oldBytes);
    expect(fs.names()).toContain(`dev-b${EXT}`);
    expect(a.reports.map((p) => p.kind)).toContain("own-set-aside");
    expect(a.memory.state()).toBe("ready");
  });

  it("lässt die Bytes des übergebenen Schlüssels unberührt", async () => {
    const fs = new FakeFs(FOLDER);
    const a = makeDevice(fs, { deviceId: "dev-a", content: null });
    const c = await contentAt(CHAIN, 0);
    const copy = Uint8Array.from(c.key);
    await a.store.setUp(c, "de");
    expect(c.key).toEqual(copy);
  });

  it("verweigert, wenn dieses Gerät schon bereit ist: nichts wird geschrieben", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    expect(a.memory.state()).toBe("ready");
    fs.clearLog();
    expect(await a.store.setUp(await contentAt(OTHER_CHAIN, 0), "de")).toEqual({ ok: false, reason: "already-set-up" });
    expect(fs.log).toEqual([]);
    expect(a.log.filter((l) => l.startsWith("key:write"))).toEqual([]);
  });

  it("danach liest ein Gerät mit dem Code die Datei und sieht eine leere Tabelle im Zustand bereit", async () => {
    const fs = new FakeFs(FOLDER);
    const a = makeDevice(fs, { deviceId: "dev-a", content: null });
    await a.store.setUp(await contentAt(CHAIN, 0), "de");
    const b = makeDevice(fs, { deviceId: "dev-b", content: null });
    expect(await b.store.adopt(await contentAt(CHAIN, 0))).toEqual({ ok: true });
    expect(b.memory.state()).toBe("ready");
    expect(b.memory.language()).toBe("de");
  });
});

// ── markCodeShown ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("markCodeShown: Stand des gesicherten Codes", () => {
  it("trägt den Stand in die eigene Datei ein und in den Arbeitsspeicher", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 3, table: personTable(ID_A, MAX) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 3) });
    await a.store.refresh();
    expect(a.memory.codeStand()).toBeNull();
    expect(await a.store.markCodeShown(3)).toBeUndefined();
    expect(a.memory.codeStand()).toBe(3);
    expect((await openOf(fs, "dev-a")).payload.device.codeShownAtStand).toBe(3);
  });

  it("ein späteres Schreiben behält den Stand; ein kleinerer Wert senkt ihn nie", async () => {
    const fs = new FakeFs(FOLDER);
    const a = makeDevice(fs, { deviceId: "dev-a", content: null });
    await a.store.setUp(await contentAt(CHAIN, 0), "de");
    await a.store.markCodeShown(0);
    await a.store.persist(personTable(ID_A, MAX));
    expect((await openOf(fs, "dev-a")).payload.device.codeShownAtStand).toBe(0);
    expect(a.memory.codeStand()).toBe(0);
  });

  it("gesperrt: nichts wird geschrieben", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, chain: OTHER_CHAIN, table: personTable(ID_A, MAX) });
    const b = makeDevice(fs, { deviceId: "dev-b", content: await contentAt(CHAIN, 0) });
    await b.store.refresh();
    fs.clearLog();
    expect(await b.store.markCodeShown(0)).toEqual({ error: "locked" });
    expect(fs.log).toEqual([]);
  });

  it("der Stand des Codes ist der höchste unter den geöffneten Fassungen", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    await a.store.markCodeShown(0);
    const c = makeDevice(fs, { deviceId: "dev-c", content: await contentAt(CHAIN, 0) });
    await c.store.refresh();
    expect(c.memory.codeStand()).toBe(0);
  });
});

// ── Geräteliste im gesperrten Zustand, Gerätename ───────────────────────────────────────────────────────────────────────────────────

describe("Geräteliste und Name", () => {
  it("gesperrt zeigt die Liste, welche Dateien angekommen sind (auch unlesbare), ohne sie als gelesen auszugeben", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 2, chain: OTHER_CHAIN, table: personTable(ID_A, MAX), name: "Mac Büro" });
    fs.put(`dev-x${EXT}`, "kein Umschlag");
    const b = makeDevice(fs, { deviceId: "dev-b", content: null });
    await b.store.refresh();
    expect(b.memory.state()).toBe("locked");
    const rows = b.memory.devices();
    expect(rows.map((r) => r.deviceId)).toEqual(["dev-a", "dev-x"]);
    expect(rows.every((r) => !r.opened)).toBe(true);
    expect(rows.find((r) => r.deviceId === "dev-a")?.stand).toBe(2);
    expect(b.store.problems().some((p) => p.deviceId === "dev-x" && p.kind === "unreadable-header")).toBe(true);
  });

  it("ändert sich der Gerätename, schreibt der nächste Lauf die eigene Datei mit dem neuen Namen", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX), name: "alt" });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0), name: "alt" });
    await a.store.refresh();
    fs.clearLog();
    await a.store.refresh();
    expect(fs.log).toEqual([]);
    a.name.current = "Mac Büro";
    await a.store.refresh();
    expect((await openOf(fs, "dev-a")).payload.device.name).toBe("Mac Büro");
  });
});
