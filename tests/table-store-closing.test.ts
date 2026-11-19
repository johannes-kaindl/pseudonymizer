// Schlüssel ersetzen sperrt die anderen Geräte: die Abschlussdatei der alten Kette (Nachtrag zu Aufgabe 12, Spec 8.3).
// Echtes WebCrypto, echte Kit-Bausteine; gefälscht sind Ablage und Schlüsselbund. Nur erfundene Werte.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFs } from "./helpers/fake-fs";
import { sampleTable } from "./helpers/table-fixtures";
import { CHAIN, EXT, FOLDER, ID_A, ID_B, contentAt, hex, makeDevice, personTable, seedFile, stateAt, type Chain, type Device } from "./helpers/store-fixtures";
import { KEY_SECRET_ID } from "../src/obsidian/key-store";
import { runReplaceKey, type KeyActionsUi } from "../src/obsidian/key-actions";
import { decodeRecoveryCode } from "../src/vendor/kit/recovery-code";
import { openEnvelope, readEnvelopeHeader } from "../src/vendor/kit/key-envelope";
import { encryptionKey } from "../src/vendor/kit/key-ratchet";
import { tableEntry, type PlaceholderTable } from "../src/vendor/kit/placeholder-table";
import { closingDeviceId, decodePayload } from "../src/core/payload";
import { buildDevicesModel } from "../src/core/devices-view";

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
const CARLA = "Carla Beispiel";
const ID_C = "q7d2w8n4tz";
const NEW_CHAIN: Chain = { chainId: Uint8Array.from([0xab, 0xcd, 0x03, 0x03]), key: Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 7) & 0xff) };
const newContent = (): { chainId: Uint8Array; stand: number; key: Uint8Array } => ({ chainId: Uint8Array.from(NEW_CHAIN.chainId), stand: 0, key: Uint8Array.from(NEW_CHAIN.key) });
const CLOSING_A = closingDeviceId("dev-a", hex(CHAIN.chainId));
const CLOSING_FILE = `${CLOSING_A}${EXT}`;

const twoPersons = (): PlaceholderTable => personTable(ID_B, BERTA, sampleTable());
const nameOf = (t: PlaceholderTable | null, id: string): string | undefined =>
  t === null ? undefined : tableEntry(t, id)?.values.find((v) => v.value.field === null)?.value.text;
const storedKey = (d: Device) => {
  const c = decodeRecoveryCode(d.secrets.raw(KEY_SECRET_ID));
  if (!c.ok) throw new Error("kein Code im Schlüsselbund");
  return c;
};

async function readyDevice(fs: FakeFs, deviceId: string, table: PlaceholderTable, stand = 0): Promise<Device> {
  await seedFile(fs, { deviceId, stand, table, name: deviceId });
  const d = makeDevice(fs, { deviceId, content: await contentAt(CHAIN, stand), name: deviceId });
  await d.store.refresh();
  expect(d.memory.state()).toBe("ready");
  return d;
}

/** a und b, beide bereit auf der alten Kette; a hat den Schlüssel ersetzt. */
async function afterReplace(): Promise<{ fs: FakeFs; a: Device; b: Device }> {
  const fs = new FakeFs(FOLDER);
  const a = await readyDevice(fs, "dev-a", twoPersons());
  const b = await readyDevice(fs, "dev-b", twoPersons());
  expect(await a.store.replaceKey(newContent())).toEqual({ ok: true });
  return { fs, a, b };
}

describe("Abschlussdatei: andere Geräte sperren sich (Spec 8.3)", () => {
  it("(a) b mit dem alten Schlüssel wird beim nächsten Auffrischen gesperrt (key-replaced) und schreibt nichts mehr", async () => {
    const { fs, b } = await afterReplace();
    expect(fs.names()).toContain(CLOSING_FILE);
    const keyBefore = b.secrets.raw(KEY_SECRET_ID);
    fs.clearLog();
    await b.store.refresh();
    expect(b.memory.state()).toBe("locked");
    expect(b.memory.reason()).toBe("key-replaced");
    expect(b.memory.table()).toBeNull();
    expect(await b.store.persist(personTable(ID_C, CARLA, sampleTable()))).toEqual({ error: "locked" });
    expect(await b.store.forget(ID_B)).toEqual({ ok: false, reason: "locked" });
    expect(fs.log).toEqual([]);
    expect(b.secrets.raw(KEY_SECRET_ID)).toBe(keyBefore);
  });

  it("(a) auch ein Gerät, dessen Schlüssel hinter dem der Abschlussdatei liegt, sperrt sich (die Abschlussdatei trägt den höchsten gelesenen Stand)", async () => {
    const fs = new FakeFs(FOLDER);
    // b liegt auf Stand 0 und hat a (Stand 1) noch nie gelesen; sonst zöge es beim Auffrischen selbst auf Stand 1 vor.
    const b = await readyDevice(fs, "dev-b", twoPersons(), 0);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 1);
    expect(storedKey(b).stand).toBe(0);
    expect(await a.store.replaceKey(newContent())).toEqual({ ok: true });
    const h = readEnvelopeHeader(fs.get(CLOSING_FILE) ?? new Uint8Array());
    expect(h.ok && h.header.stand).toBe(1);
    expect(storedKey(b).stand).toBe(0);
    await b.store.refresh();
    expect(b.memory.reason()).toBe("key-replaced");
  });

  it("(b) b gibt den neuen Code ein: bereit, und ein Eintrag, den nur b kannte, steht in seiner neuen Fassung", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons());
    const b = await readyDevice(fs, "dev-b", twoPersons());
    // b schreibt etwas, das a noch nicht gesehen hat: die Datei erreicht a erst nach dem Ersetzen (Sync-Verzug).
    const bOld = fs.get("dev-b" + EXT) ?? new Uint8Array();
    await b.store.persist(personTable(ID_C, CARLA, sampleTable()));
    const bNew = fs.get("dev-b" + EXT) ?? new Uint8Array();
    fs.put("dev-b" + EXT, bOld);
    expect(await a.store.replaceKey(newContent())).toEqual({ ok: true });
    fs.put("dev-b" + EXT, bNew);

    await b.store.refresh();
    expect(b.memory.reason()).toBe("key-replaced");
    expect(await b.store.adopt(newContent())).toEqual({ ok: true });
    expect(b.memory.state()).toBe("ready");
    expect(nameOf(b.memory.table(), ID_C)).toBe(CARLA);
    expect(nameOf(b.memory.table(), ID_A)).toBe(MAX);
    expect(Array.from(storedKey(b).chainId)).toEqual(Array.from(NEW_CHAIN.chainId));
    await a.store.refresh();
    expect(nameOf(a.memory.table(), ID_C)).toBe(CARLA);
  });

  it("(c) Abbruch bis zum Kontrollkästchen sperrt b nicht: nichts wird geschrieben", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons());
    const b = await readyDevice(fs, "dev-b", twoPersons());
    const ui: KeyActionsUi = {
      choosePerson: () => Promise.resolve(null), confirmForget: () => Promise.resolve(false), confirmRemoveDevice: () => Promise.resolve(false),
      confirmReplaceKey: () => Promise.resolve(true), showCode: () => Promise.resolve(false), notify: () => undefined,
    };
    fs.clearLog();
    const out = await runReplaceKey({ store: a.store, memory: a.memory, ownDeviceId: () => "dev-a", ui, newKey: newContent, changed: () => undefined });
    expect(out).toBe("cancelled");
    expect(fs.log).toEqual([]);
    expect(fs.names().sort()).toEqual([`dev-a${EXT}`, `dev-b${EXT}`]);
    await b.store.refresh();
    expect(b.memory.state()).toBe("ready");
  });

  it("(c) scheitert das Schreiben der eigenen neuen Fassung, nimmt a die Abschlussdatei zurück: b bleibt bereit, der alte Schlüssel bleibt", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons());
    const b = await readyDevice(fs, "dev-b", twoPersons());
    const before = a.secrets.raw(KEY_SECRET_ID);
    const oldOwn = fs.get(`dev-a${EXT}`);
    fs.beforeWrite = (p) => (p.includes(`/dev-a${EXT}`) ? Promise.reject(new Error("Platte voll")) : Promise.resolve());
    expect(await a.store.replaceKey(newContent())).toEqual({ ok: false, reason: "storage-failed" });
    fs.beforeWrite = null;
    expect(fs.names()).not.toContain(CLOSING_FILE);
    expect(fs.get(`dev-a${EXT}`)).toEqual(oldOwn);
    expect(a.secrets.raw(KEY_SECRET_ID)).toBe(before);
    await b.store.refresh();
    expect(b.memory.state()).toBe("ready");
    await a.store.refresh();
    expect(a.memory.state()).toBe("ready");
  });

  it("(c) scheitert schon die Abschlussdatei, ist nichts geändert: weder neue Fassung noch Schlüssel", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons());
    const before = a.secrets.raw(KEY_SECRET_ID);
    const oldOwn = fs.get(`dev-a${EXT}`);
    fs.beforeWrite = (p) => (p.includes("closed-") ? Promise.reject(new Error("Platte voll")) : Promise.resolve());
    expect(await a.store.replaceKey(newContent())).toEqual({ ok: false, reason: "storage-failed" });
    fs.beforeWrite = null;
    expect(fs.get(`dev-a${EXT}`)).toEqual(oldOwn);
    expect(a.secrets.raw(KEY_SECRET_ID)).toBe(before);
    expect(fs.names().filter((n) => n.startsWith("closed-"))).toEqual([]);
  });

  it("Datei geschrieben, Schlüssel nicht ablegbar: die Abschlussdatei bleibt (der Wechsel gilt), b ist gesperrt", async () => {
    const fs = new FakeFs(FOLDER);
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0), name: "dev-a", keyWriteFails: true });
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: twoPersons() });
    const b = await readyDevice(fs, "dev-b", twoPersons());
    await a.store.refresh();
    expect(await a.store.replaceKey(newContent())).toEqual({ ok: false, reason: "key-write-failed" });
    expect(fs.names()).toContain(CLOSING_FILE);
    await b.store.refresh();
    expect(b.memory.reason()).toBe("key-replaced");
  });

  it("(d) die Abschlussdatei enthält nach dem Öffnen nur die Markierung: keinen Wert, keinen Namen, keine Tabelle", async () => {
    const { fs } = await afterReplace();
    const bytes = fs.get(CLOSING_FILE) ?? new Uint8Array();
    const h = readEnvelopeHeader(bytes);
    if (!h.ok) throw new Error("Kopf");
    expect(Array.from(h.header.chainId)).toEqual(Array.from(CHAIN.chainId));
    expect(h.header.deviceId).toBe(CLOSING_A);
    const k = await encryptionKey(await stateAt(CHAIN, h.header.stand));
    if (!k.ok) throw new Error("Schlüssel");
    const o = await openEnvelope(k.value, bytes);
    if (!o.ok) throw new Error("öffnen");
    const plain = new TextDecoder().decode(o.plaintext);
    expect(JSON.parse(plain)).toEqual({ format: "pseudonymizer-closed", version: 1, replaced: true });
    for (const secret of [MAX, BERTA, "max@example.org", "030 1234567", ID_A, ID_B, "table", "name"]) expect(plain).not.toContain(secret);
    // Ein Leser ohne Kenntnis der Markierung liest keine leere Tabelle daraus (CORE-DATA-01).
    expect("error" in decodePayload(o.plaintext)).toBe(true);
    // Auch die Datei selbst trägt nichts im Klartext.
    expect(new TextDecoder("latin1").decode(bytes)).not.toContain(MAX);
  });

  it("(e) sie zählt nicht als Gerät: nicht in der Geräteliste (auch nicht bei b), nicht im Vergessen-Fortschritt, nicht in den Problemen", async () => {
    const { a, b } = await afterReplace();
    await a.store.refresh();
    await b.store.refresh();
    for (const d of [a, b]) {
      expect(d.memory.devices().map((x) => x.deviceId)).not.toContain(CLOSING_A);
      expect(d.store.problems()).toEqual([]);
      expect(d.reports).toEqual([]);
    }
    expect(a.memory.devices().map((x) => x.deviceId).sort()).toEqual(["dev-a", "dev-b"]);
    // Der Fortschritt des Vergessens zählt zwei Geräte, nicht drei.
    expect(await a.store.forget(ID_B)).toMatchObject({ ok: true });
    const m = buildDevicesModel({
      state: a.memory.state(), reason: a.memory.reason(), stand: a.memory.stand(), devices: a.memory.devices(), ownDeviceId: "dev-a",
      problems: a.store.problems(), codeStand: a.memory.codeStand(), table: a.memory.table(),
    });
    expect(m.progress?.devicesTotal).toBe(2);
    expect(m.rows.map((r) => r.deviceId)).not.toContain(CLOSING_A);
  });

  it("(e) „Gerät entfernen“ löscht sie nie", async () => {
    const { fs, a } = await afterReplace();
    expect(await a.store.removeDevice(CLOSING_A)).toEqual({ ok: false, reason: "not-a-device" });
    expect(fs.names()).toContain(CLOSING_FILE);
  });

  it("(e) im gesperrten Zustand führt auch die Liste der ungeöffneten Dateien sie nicht", async () => {
    const { b } = await afterReplace();
    await b.store.refresh();
    expect(b.memory.devices().map((x) => x.deviceId)).toEqual(["dev-a", "dev-b"]);
  });

  it("(f) a räumt sie weg, sobald keine andere Datei der alten Kette mehr liegt, und vorher nicht", async () => {
    const { fs, a, b } = await afterReplace();
    await a.store.refresh();
    expect(fs.names()).toContain(CLOSING_FILE); // b liegt noch mit der alten Kette im Ordner
    await b.store.refresh();
    expect(fs.names()).toContain(CLOSING_FILE);
    expect(await b.store.adopt(newContent())).toEqual({ ok: true });
    await b.store.refresh();
    expect(fs.names()).toContain(CLOSING_FILE); // nur das ersetzende Gerät räumt auf
    fs.clearLog();
    await a.store.refresh();
    expect(fs.names()).toEqual([`dev-a${EXT}`, `dev-b${EXT}`]);
    expect(fs.log).toEqual([`remove:${FOLDER}/${CLOSING_FILE}`]);
  });

  it("(f) auch nach „Gerät entfernen“ des letzten alten Geräts", async () => {
    const { fs, a } = await afterReplace();
    expect(await a.store.removeDevice("dev-b")).toMatchObject({ ok: true });
    expect(fs.names()).toEqual([`dev-a${EXT}`]);
  });

  it("(f) eine nicht lesbare Datei im Ordner hält sie fest (sie könnte zur alten Kette gehören)", async () => {
    const { fs, a, b } = await afterReplace();
    expect(await b.store.adopt(newContent())).toEqual({ ok: true });
    fs.put("dev-x" + EXT, new Uint8Array([1, 2, 3]));
    await a.store.refresh();
    expect(fs.names()).toContain(CLOSING_FILE);
  });

  it("die Datei einer ersetzten Kette stört das Gerät mit der neuen Kette nicht: bereit, ohne Befund", async () => {
    const { a } = await afterReplace();
    await a.store.refresh();
    expect(a.memory.state()).toBe("ready");
    expect(a.store.problems()).toEqual([]);
  });
});
