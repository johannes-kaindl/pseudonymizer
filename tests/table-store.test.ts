// Gerätedateien öffnen, vereinigen und abbruchsicher schreiben (Bauplan Aufgabe 11, Review-Fokus 1 und 5).
// Echtes WebCrypto aus Node und die echten Kit-Bausteine; gefälscht sind nur die Ablage (Fake-Platte) und der Schlüsselbund.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFs } from "./helpers/fake-fs";
import {
  CHAIN, EXT, FOLDER, ID_A, ID_B, ID_C, OTHER_CHAIN, contentAt, forgetIn, hex, makeDevice, personTable, seedFile, stateAt,
  type Device,
} from "./helpers/store-fixtures";
import { readEnvelopeHeader } from "../src/vendor/kit/key-envelope";
import { decodeRecoveryCode } from "../src/vendor/kit/recovery-code";
import { KEY_SECRET_ID } from "../src/obsidian/key-store";
import { emptyTable, tableEntry, tableForgotten, type PlaceholderTable } from "../src/vendor/kit/placeholder-table";

const CONSOLE = ["log", "info", "warn", "error", "debug", "trace"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => { spies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined)); });
afterEach(() => {
  const printed = spies.reduce((n, s) => n + s.mock.calls.length, 0);
  spies.forEach((s) => s.mockRestore());
  // Kein Schlüssel und kein Klartext in console, in keinem Test dieser Datei.
  expect(printed).toBe(0);
});

const MAX = "Max Mustermann";
const BERTA = "Berta Beispiel";
const CORA = "Cora Codewort";

const nameOf = (t: PlaceholderTable | null, id: string): string | undefined =>
  t === null ? undefined : tableEntry(t, id)?.values.find((v) => v.value.field === null)?.value.text;
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const headOf = (fs: FakeFs, name: string) => {
  const b = fs.get(`${name}${EXT}`);
  if (b === undefined) throw new Error(`keine Datei ${name}`);
  const h = readEnvelopeHeader(b);
  if (!h.ok) throw new Error("Kopf");
  return h.header;
};
const storedKey = (d: Device) => {
  const c = decodeRecoveryCode(d.secrets.raw(KEY_SECRET_ID));
  if (!c.ok) throw new Error("kein Code im Schlüsselbund");
  return c;
};
const keyWrites = (d: Device): string[] => d.log.filter((l) => l.startsWith("key:write"));
const fileWrites = (fs: FakeFs): string[] => fs.log.filter((l) => l.startsWith("write:"));
/** Ein frisches Gerät mit demselben Schlüssel liest den Ordner: zeigt, was die Dateien tragen (nicht, was ein Arbeitsspeicher noch weiß). */
async function readFresh(fs: FakeFs, stand: number, id = "dev-reader"): Promise<Device> {
  const d = makeDevice(fs, { deviceId: id, content: await contentAt(CHAIN, stand) });
  await d.store.refresh();
  return d;
}

// ── Öffnen und Vereinigen ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("öffnen und vereinigen (Spec 11.2)", () => {
  it("zwei Fassungen, die je einen Eintrag kennen, den die andere nicht hat, ergeben nach dem Öffnen beide", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable(ID_B, BERTA) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    expect(a.memory.state()).toBe("ready");
    expect(nameOf(a.memory.table(), ID_A)).toBe(MAX);
    expect(nameOf(a.memory.table(), ID_B)).toBe(BERTA);
    expect(keyWrites(a)).toEqual([]);
    // Die eigene Datei trägt jetzt die Vereinigung: ein Gerät, das nur sie liest, sieht beide.
    fs.files.delete(fs.path(`dev-b${EXT}`));
    const c = await readFresh(fs, 0);
    expect(nameOf(c.memory.table(), ID_A)).toBe(MAX);
    expect(nameOf(c.memory.table(), ID_B)).toBe(BERTA);
  });

  it("öffnet Dateien mehrerer Stände und liest die Vereinigung; der neueste Stand gewinnt", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    await seedFile(fs, { deviceId: "dev-b", stand: 1, table: personTable(ID_B, BERTA) });
    await seedFile(fs, { deviceId: "dev-c", stand: 2, table: personTable(ID_C, CORA) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    expect(a.memory.state()).toBe("ready");
    expect([ID_A, ID_B, ID_C].map((id) => nameOf(a.memory.table(), id))).toEqual([MAX, BERTA, CORA]);
    expect(a.memory.stand()).toBe(2);
    expect(headOf(fs, "dev-a").stand).toBe(2);
  });

  it("ein zweiter Lauf ohne Änderung schreibt nichts mehr", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable(ID_B, BERTA) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    fs.clearLog();
    a.log.length = 0;
    await a.store.refresh();
    await a.store.refresh();
    expect(fs.log).toEqual([]);
    expect(a.log).toEqual([]);
  });

  it("eine beschädigte fremde Datei wird gemeldet und nicht still verworfen oder überschrieben; die übrigen werden gelesen (CORE-DATA-01)", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable(ID_B, BERTA) });
    const junk = new TextEncoder().encode("das ist keine Gerätedatei");
    fs.put(`dev-x${EXT}`, junk);
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    expect(a.memory.state()).toBe("ready");
    expect(nameOf(a.memory.table(), ID_B)).toBe(BERTA);
    expect(a.reports).toEqual([{ kind: "unreadable-header", deviceId: "dev-x", path: `${FOLDER}/dev-x${EXT}` }]);
    expect(fs.get(`dev-x${EXT}`)).toEqual(junk);
    expect(JSON.stringify(a.reports)).not.toContain("Mustermann");
  });

  it("eine Datei mit gültigem Kopf, aber verfälschtem Inhalt ist `authentication`, wird gemeldet und bleibt liegen", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    const b = await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable(ID_B, BERTA) });
    const forged = Uint8Array.from(b);
    forged[forged.length - 3] ^= 0x01;
    fs.put(`dev-b${EXT}`, forged);
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    expect(a.memory.state()).toBe("ready");
    expect(nameOf(a.memory.table(), ID_B)).toBeUndefined();
    expect(a.reports.map((r) => r.kind)).toEqual(["authentication"]);
    expect(fs.get(`dev-b${EXT}`)).toEqual(forged);
  });

  it("eine Konfliktkopie mit ungültigem Namen wird gemeldet", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    fs.put(`dev-a 2${EXT}`, "x");
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    expect(a.memory.state()).toBe("ready");
    expect(a.reports.map((r) => r.kind)).toEqual(["invalid-name"]);
  });

  it("meldet ein Problem einmal, solange es besteht, und wieder, wenn es zurückkehrt", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    fs.put(`dev-x${EXT}`, "kaputt");
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    await a.store.refresh();
    expect(a.reports).toHaveLength(1);
    fs.files.delete(fs.path(`dev-x${EXT}`));
    await a.store.refresh();
    expect(a.store.problems()).toEqual([]);
    fs.put(`dev-x${EXT}`, "kaputt");
    await a.store.refresh();
    expect(a.reports).toHaveLength(2);
  });

  it("eine neuere Fassung des Inhalts ist `newer-format`, kein Schaden, und öffnet nicht", async () => {
    const fs = new FakeFs(FOLDER);
    // Eine Datei mit Version 2 des Inhalts, mit den Kit-Bausteinen gesiegelt.
    const { encryptionKey } = await import("../src/vendor/kit/key-ratchet");
    const { sealEnvelope } = await import("../src/vendor/kit/key-envelope");
    const k = await encryptionKey(await stateAt(CHAIN, 0));
    if (!k.ok) throw new Error("key");
    const sealed = await sealEnvelope(k.value, { deviceId: "dev-n", chainId: CHAIN.chainId, stand: 0 }, new TextEncoder().encode('{"format":"pseudonymizer-device","version":2}'));
    if (!sealed.ok) throw new Error("seal");
    fs.put(`dev-n${EXT}`, sealed.bytes);
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    expect(a.reports.map((r) => r.kind)).toEqual(["newer-format"]);
    expect(a.memory.state()).toBe("locked");
    expect(a.memory.reason()).toBe("key-opens-nothing");
    expect(fileWrites(fs)).toEqual([]);
  });

  it("die Geräteliste nennt Namen, Stand, geöffnet und Marken; ein ungeöffnetes Gerät heißt nach seiner ID", async () => {
    const fs = new FakeFs(FOLDER);
    const withMark = forgetIn(personTable(ID_C, CORA, personTable(ID_A, MAX)), ID_C);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_C, CORA, personTable(ID_A, MAX)), name: "Mac A" });
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: withMark, name: "Mac B" });
    await seedFile(fs, { deviceId: "dev-z", stand: 0, table: personTable(ID_B, BERTA), chain: OTHER_CHAIN, name: "iPhone Z" });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0), name: "Mac A" });
    await a.store.refresh();
    // dev-a hatte C lebend unter Stand 0 geschrieben und lernt die Marke von dev-b: Regel 2, es dreht auf Stand 1 vor.
    const devices = a.memory.devices();
    expect(devices.map((d) => d.deviceId)).toEqual(["dev-a", "dev-b", "dev-z"]);
    expect(devices.find((d) => d.deviceId === "dev-a")).toMatchObject({ name: "Mac A", opened: true, stand: 1, carriesMarks: true });
    expect(devices.find((d) => d.deviceId === "dev-b")).toMatchObject({ name: "Mac B", opened: true, stand: 0, carriesMarks: true });
    expect(devices.find((d) => d.deviceId === "dev-z")).toMatchObject({ name: "dev-z", opened: false, carriesMarks: false });
  });
});

// ── Zustand: gesperrt, nie eine leere Tabelle ───────────────────────────────────────────────────────────────────────────────────────

describe("gesperrt statt leerer Tabelle (Review-Fokus 1)", () => {
  it("Schlüssel vorhanden, Ordner leer: locked/table-missing, und kein Schreibvorgang folgt, auch nicht auf Anforderung", async () => {
    const fs = new FakeFs(FOLDER);
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 3) });
    await a.store.refresh();
    expect(a.memory.state()).toBe("locked");
    expect(a.memory.reason()).toBe("table-missing");
    expect(a.memory.table()).toBeNull();
    expect(await a.store.persist(personTable(ID_A, MAX))).toEqual({ error: "locked" });
    expect(fs.mutations).toBe(0);
    expect(fs.files.size).toBe(0);
    expect(a.log).toEqual([]);
  });

  it("ein Ordner, der nach dem Öffnen verschwindet, sperrt wieder und nimmt die Tabelle aus dem Speicher", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    expect(a.memory.state()).toBe("ready");
    fs.files.clear();
    fs.clearLog();
    await a.store.refresh();
    expect(a.memory.state()).toBe("locked");
    expect(a.memory.reason()).toBe("table-missing");
    expect(a.memory.table()).toBeNull();
    expect(await a.store.persist(personTable(ID_B, BERTA))).toEqual({ error: "locked" });
    expect(fs.mutations).toBe(0);
  });

  it("nur Dateien einer fremden Kette: locked/foreign-chain, nichts geschrieben, der Schlüssel unberührt", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-z", stand: 0, table: personTable(ID_B, BERTA), chain: OTHER_CHAIN });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 2) });
    const before = a.secrets.raw(KEY_SECRET_ID);
    await a.store.refresh();
    expect(a.memory.state()).toBe("locked");
    expect(a.memory.reason()).toBe("foreign-chain");
    expect(fs.mutations).toBe(0);
    expect(keyWrites(a)).toEqual([]);
    expect(a.secrets.raw(KEY_SECRET_ID)).toBe(before);
  });

  it("Dateien der eigenen Kette, die sich nicht öffnen lassen: locked/key-opens-nothing, nichts geschrieben, Schlüssel unberührt", async () => {
    const fs = new FakeFs(FOLDER);
    const b = await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable(ID_B, BERTA) });
    const forged = Uint8Array.from(b);
    forged[forged.length - 1] ^= 0xff;
    fs.put(`dev-b${EXT}`, forged);
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    const before = a.secrets.raw(KEY_SECRET_ID);
    await a.store.refresh();
    expect(a.memory.reason()).toBe("key-opens-nothing");
    expect(fs.mutations).toBe(0);
    expect(keyWrites(a)).toEqual([]);
    expect(a.secrets.raw(KEY_SECRET_ID)).toBe(before);
  });

  it("Zustandstabelle: ohne Schlüssel und ohne Dateien nicht eingerichtet; mit Dateien gesperrt (no-key); beschädigter Schlüssel; Lesefehler", async () => {
    const fs = new FakeFs(FOLDER);
    const none = makeDevice(fs, { deviceId: "dev-a", content: null });
    await none.store.refresh();
    expect(none.memory.state()).toBe("not-set-up");
    expect(await none.store.persist(personTable(ID_A, MAX))).toEqual({ error: "not-ready" });

    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable(ID_B, BERTA) });
    fs.clearLog();
    await none.store.refresh();
    expect(none.memory.state()).toBe("locked");
    expect(none.memory.reason()).toBe("no-key");
    expect(fs.mutations).toBe(0);

    const corrupt = makeDevice(fs, { deviceId: "dev-c", content: null });
    corrupt.secrets.poke(KEY_SECRET_ID, "kein-code");
    await corrupt.store.refresh();
    expect(corrupt.memory.reason()).toBe("key-corrupt");

    const keyed = makeDevice(fs, { deviceId: "dev-d", content: await contentAt(CHAIN, 0) });
    fs.listThrows = true;
    await keyed.store.refresh();
    expect(keyed.memory.reason()).toBe("storage-failed");
    expect(await keyed.store.persist(personTable(ID_A, MAX))).toEqual({ error: "storage-failed" });
  });
});

// ── Vordrehen: Reihenfolge, Sprungdeckel, Leeren ────────────────────────────────────────────────────────────────────────────────────

describe("vordrehen (Spec 8.3)", () => {
  async function ahead(): Promise<{ fs: FakeFs; a: Device }> {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 3, table: personTable(ID_A, MAX) });
    await seedFile(fs, { deviceId: "dev-b", stand: 4, table: personTable(ID_B, BERTA) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 3) });
    return { fs, a };
  }

  it("eine Datei mit Stand eigener + 1 öffnet im Arbeitsspeicher; erst danach wird die eigene Datei neu geschrieben und DANN der Schlüssel überschrieben (Aufrufreihenfolge)", async () => {
    const { fs, a } = await ahead();
    await a.store.refresh();
    expect(a.memory.state()).toBe("ready");
    expect(nameOf(a.memory.table(), ID_B)).toBe(BERTA);
    expect(a.log).toEqual(["file:write", "file:done", "key:write:4"]);
    expect(headOf(fs, "dev-a").stand).toBe(4);
    const k = storedKey(a);
    expect(k.stand).toBe(4);
    expect(hex(k.chainId)).toBe(hex(CHAIN.chainId));
    expect(hex(k.key)).toBe(hex((await stateAt(CHAIN, 4)).chainKey));
  });

  it("scheitert das Schreiben der eigenen Datei, wird der Schlüssel NICHT überschrieben", async () => {
    const { fs, a } = await ahead();
    const before = a.secrets.raw(KEY_SECRET_ID);
    fs.failWrites = true;
    await a.store.refresh();
    expect(keyWrites(a)).toEqual([]);
    expect(a.secrets.raw(KEY_SECRET_ID)).toBe(before);
    expect(a.reports.map((r) => r.kind)).toContain("write-failed");
    // Gelesen ist gelesen: die fremde Fassung steht im Speicher, die Platte ist unverändert, der Stand ist noch der alte.
    expect(nameOf(a.memory.table(), ID_B)).toBe(BERTA);
    expect(headOf(fs, "dev-a").stand).toBe(3);
  });

  it("bricht es zwischen Datei und Schlüssel ab, liegt der alte Schlüssel vor und führt zum neuen: der nächste Lauf schreibt nur noch den Schlüssel", async () => {
    const { fs, a } = await ahead();
    const secrets = a.secrets;
    const crashed = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 3), secrets, keyWriteFails: true });
    await crashed.store.refresh();
    expect(headOf(fs, "dev-a").stand).toBe(4);
    expect(storedKey(crashed).stand).toBe(3);
    expect(crashed.reports.map((r) => r.kind)).toContain("key-write-failed");
    fs.clearLog();
    const again = makeDevice(fs, { deviceId: "dev-a", content: null, secrets });
    await again.store.refresh();
    expect(again.memory.state()).toBe("ready");
    expect(fs.log).toEqual([]);
    expect(storedKey(again).stand).toBe(4);
  });

  it("leert den alten Kettenzustand nach dem Vordrehen (wipe), auch jeden abgeleiteten", async () => {
    const { a } = await ahead();
    await a.store.refresh();
    expect(a.keyReads.length).toBeGreaterThan(0);
    for (const k of a.keyReads) expect(Array.from(k).every((b) => b === 0)).toBe(true);
    expect(a.wiped.some((s) => s.stand === 3)).toBe(true);
    expect(a.wiped.some((s) => s.stand === 4)).toBe(true);
    for (const s of a.wiped) expect(Array.from(s.chainKey).every((b) => b === 0)).toBe(true);
    // Der Schlüssel im Schlüsselbund ist trotzdem der echte (geleert wurde erst nach dem Ablegen).
    expect(Array.from(storedKey(a).key).some((b) => b !== 0)).toBe(true);
  });

  it("leert auch, wenn der Lauf scheitert", async () => {
    const { fs, a } = await ahead();
    fs.failWrites = true;
    await a.store.refresh();
    for (const s of a.wiped) expect(Array.from(s.chainKey).every((b) => b === 0)).toBe(true);
    expect(a.wiped.length).toBeGreaterThan(0);
    for (const k of a.keyReads) expect(Array.from(k).every((b) => b === 0)).toBe(true);
  });

  it("Sprungdeckel: Stand eigener + 1000 öffnet, + 1001 nicht", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-b", stand: 1000, table: personTable(ID_B, BERTA) });
    const ok = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await ok.store.refresh();
    expect(ok.memory.state()).toBe("ready");
    expect(headOf(fs, "dev-a").stand).toBe(1000);

    const fs2 = new FakeFs(FOLDER);
    await seedFile(fs2, { deviceId: "dev-b", stand: 1001, table: personTable(ID_B, BERTA) });
    const over = makeDevice(fs2, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    const before = over.secrets.raw(KEY_SECRET_ID);
    await over.store.refresh();
    expect(over.memory.state()).toBe("locked");
    expect(over.memory.reason()).toBe("key-opens-nothing");
    expect(over.reports).toEqual([{ kind: "too-far", deviceId: "dev-b", path: `${FOLDER}/dev-b${EXT}` }]);
    expect(fs2.mutations).toBe(0);
    expect(over.secrets.raw(KEY_SECRET_ID)).toBe(before);
  });

  it("Stand eigener + 2000 wird nicht geöffnet und als beschädigt gemeldet; die anderen Dateien werden gelesen", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    await seedFile(fs, { deviceId: "dev-b", stand: 2000, table: personTable(ID_B, BERTA) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    expect(a.memory.state()).toBe("ready");
    expect(nameOf(a.memory.table(), ID_B)).toBeUndefined();
    expect(a.reports.map((r) => r.kind)).toEqual(["too-far"]);
    expect(keyWrites(a)).toEqual([]);
    expect(headOf(fs, "dev-a").stand).toBe(0);
  });

  it("eine gefälschte Datei mit hohem Stand (gültiger Kopf, falscher Inhalt) sperrt das Gerät nicht aus und der Schlüssel bleibt", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    const forged = await seedFile(fs, { deviceId: "dev-f", stand: 500, table: personTable(ID_B, BERTA) });
    const bad = Uint8Array.from(forged);
    bad[bad.length - 2] ^= 0x10;
    fs.put(`dev-f${EXT}`, bad);
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    expect(a.memory.state()).toBe("ready");
    expect(a.reports.map((r) => r.kind)).toEqual(["authentication"]);
    expect(keyWrites(a)).toEqual([]);
    expect(storedKey(a).stand).toBe(0);
    expect(headOf(fs, "dev-a").stand).toBe(0);
  });

  it("Dateien mit älterem Stand sind „noch nicht nachgezogen“: nicht geöffnet, kein Befund", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 3, table: personTable(ID_A, MAX) });
    await seedFile(fs, { deviceId: "dev-b", stand: 1, table: personTable(ID_B, BERTA) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 3) });
    await a.store.refresh();
    expect(a.memory.state()).toBe("ready");
    expect(nameOf(a.memory.table(), ID_B)).toBeUndefined();
    expect(a.reports).toEqual([]);
    expect(a.memory.devices().find((d) => d.deviceId === "dev-b")).toMatchObject({ opened: false, stand: 1 });
  });
});

// ── Nie zweimal unter demselben Stand ───────────────────────────────────────────────────────────────────────────────────────────────

describe("mustAdvanceBeforeWrite (Spec 8.3 Regel 2)", () => {
  /** Beide Geräte stehen auf Stand 3. dev-a hat unter Stand 3 eine Fassung mit Cora lebend geschrieben; dev-b hat Cora unter Stand 3 vergessen. */
  async function setup(markedId: string) {
    const fs = new FakeFs(FOLDER);
    const shared = personTable(ID_C, CORA, personTable(ID_A, MAX));
    await seedFile(fs, { deviceId: "dev-a", stand: 3, table: shared });
    await seedFile(fs, { deviceId: "dev-b", stand: 3, table: forgetIn(shared, markedId) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 3) });
    return { fs, a };
  }

  it("liest ein Gerät eine Marke für eine ID, die es unter diesem Stand lebend geschrieben hat, dreht es vor dem Schreiben um einen Stand weiter: Datei, dann Schlüssel", async () => {
    const { fs, a } = await setup(ID_C);
    await a.store.refresh();
    expect(a.memory.state()).toBe("ready");
    expect(headOf(fs, "dev-a").stand).toBe(4);
    expect(a.log).toEqual(["file:write", "file:done", "key:write:4"]);
    expect(storedKey(a).stand).toBe(4);
    expect(nameOf(a.memory.table(), ID_C)).toBeUndefined();
    expect(tableForgotten(a.memory.table() ?? emptyTable())).toContain(ID_C);
    // Die alte Fassung unter Stand 3 ist damit überholt; die neue trägt den Namen nicht mehr.
    fs.files.delete(fs.path(`dev-b${EXT}`));
    expect(nameOf((await readFresh(fs, 4)).memory.table(), ID_C)).toBeUndefined();
  });

  it("eine Marke für eine ID, die das Gerät nie lebend geschrieben hat, dreht nicht vor (die Marke wird übernommen, der Stand bleibt)", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 3, table: personTable(ID_A, MAX) });
    await seedFile(fs, { deviceId: "dev-b", stand: 3, table: forgetIn(personTable(ID_C, CORA, personTable(ID_A, MAX)), ID_C) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 3) });
    await a.store.refresh();
    expect(headOf(fs, "dev-a").stand).toBe(3);
    expect(keyWrites(a)).toEqual([]);
    expect(tableForgotten(a.memory.table() ?? emptyTable())).toContain(ID_C);
    // Die Marke steht jetzt in der eigenen Fassung (jedes Gerät übernimmt jede Marke, die es liest).
    expect(tableForgotten((await readFresh(fs, 3)).memory.table() ?? emptyTable())).toContain(ID_C);
  });

  it("`persist` mit einer Marke für eine lebend geschriebene ID dreht ebenfalls vor; eine Marke danach nicht noch einmal", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 3, table: personTable(ID_C, CORA, personTable(ID_A, MAX)) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 3) });
    await a.store.refresh();
    a.log.length = 0;
    expect(await a.store.persist((cur) => forgetIn(cur, ID_C))).toBeUndefined();
    expect(a.log).toEqual(["file:write", "file:done", "key:write:4"]);
    expect(headOf(fs, "dev-a").stand).toBe(4);
    expect(nameOf(a.memory.table(), ID_C)).toBeUndefined();
    // Ein weiteres persist unter Stand 4 schreibt unter Stand 4: die vergessene ID wurde dort nie lebend geschrieben.
    a.log.length = 0;
    expect(await a.store.persist(personTable(ID_B, BERTA))).toBeUndefined();
    expect(a.log).toEqual(["file:write", "file:done"]);
    expect(headOf(fs, "dev-a").stand).toBe(4);
  });

  it("zwei Geräte vergessen gleichzeitig verschiedene Personen und treffen sich auf Stand n + 2", async () => {
    const fs = new FakeFs(FOLDER);
    const base = personTable(ID_C, CORA, personTable(ID_B, BERTA, personTable(ID_A, MAX)));
    // Beide stehen auf 3, kennen alles; a vergisst Berta, b vergisst Cora, jeder schreibt unter Stand 3 (derselbe Schlüssel).
    await seedFile(fs, { deviceId: "dev-a", stand: 3, table: forgetIn(base, ID_B) });
    await seedFile(fs, { deviceId: "dev-b", stand: 3, table: forgetIn(base, ID_C) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 3) });
    const b = makeDevice(fs, { deviceId: "dev-b", content: await contentAt(CHAIN, 3) });
    await a.store.refresh();
    // a liest b: Cora ist vergessen, a hat Cora unter 3 lebend geschrieben -> 4.
    expect(headOf(fs, "dev-a").stand).toBe(4);
    await b.store.refresh();
    // b liest a (Stand 4, Berta vergessen): b dreht auf 4 (neuer als 3) und schreibt unter 4; Berta war unter 3 lebend, aber 4 ist ein anderer Stand.
    expect(headOf(fs, "dev-b").stand).toBe(4);
    await a.store.refresh();
    for (const d of [a, b]) {
      const f = tableForgotten(d.memory.table() ?? emptyTable());
      expect(f).toContain(ID_B);
      expect(f).toContain(ID_C);
      expect(nameOf(d.memory.table(), ID_A)).toBe(MAX);
    }
  });
});

// ── Eigene Datei beschädigt ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("beschädigte eigene Datei (CORE-DATA-01)", () => {
  const garbage = new TextEncoder().encode("halb geschrieben, kein Umschlag");

  it("wird vor dem Schreiben beiseitegelegt und nie überschrieben; das Plugin ist `ready`, die Bytes bleiben unter `.damaged-…`", async () => {
    const fs = new FakeFs(FOLDER);
    fs.put(`dev-a${EXT}`, garbage);
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable(ID_B, BERTA) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    expect(a.memory.state()).toBe("ready");
    expect(a.log).toEqual(["file:replace-damaged", "file:done"]);
    const aside = fs.names().filter((n) => n.startsWith(`dev-a${EXT}.damaged-`));
    expect(aside).toHaveLength(1);
    expect(fs.get(aside[0] ?? "")).toEqual(garbage);
    expect(headOf(fs, "dev-a").stand).toBe(0);
    expect(nameOf((await readFresh(fs, 0)).memory.table(), ID_B)).toBe(BERTA);
    expect(a.reports.map((r) => r.kind).sort()).toEqual(["own-set-aside", "unreadable-header"]);
    // Ein zweiter Lauf legt nichts mehr beiseite.
    fs.clearLog();
    await a.store.refresh();
    expect(fs.log).toEqual([]);
  });

  it("scheitert das Beiseitelegen, wird NICHTS geschrieben und die beschädigte Datei bleibt, wo sie war", async () => {
    const fs = new FakeFs(FOLDER);
    fs.put(`dev-a${EXT}`, garbage);
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable(ID_B, BERTA) });
    fs.failRenameFrom.add(fs.path(`dev-a${EXT}`));
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    expect(fs.get(`dev-a${EXT}`)).toEqual(garbage);
    expect(fileWrites(fs)).toEqual([]);
    expect(a.reports.map((r) => r.kind)).toContain("write-failed");
    expect(await a.store.persist(personTable(ID_C, CORA))).toEqual({ error: "storage-failed" });
    expect(fs.get(`dev-a${EXT}`)).toEqual(garbage);
    expect(nameOf(a.memory.table(), ID_C)).toBeUndefined();
  });

  it("eine eigene Datei einer fremden Kette wird ebenfalls beiseitegelegt, nie überschrieben", async () => {
    const fs = new FakeFs(FOLDER);
    const foreign = await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX), chain: OTHER_CHAIN });
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable(ID_B, BERTA) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    const aside = fs.names().filter((n) => n.startsWith(`dev-a${EXT}.damaged-`));
    expect(aside).toHaveLength(1);
    expect(fs.get(aside[0] ?? "")).toEqual(foreign);
  });
});

// ── Nebenläufigkeit ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("Warteschlange (Spec 2, Anti-Ziel 2)", () => {
  async function ready(fs: FakeFs): Promise<Device> {
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX) });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    return a;
  }

  it("zwei gleichzeitige `persist` mit je einem neuen Eintrag: beide in Speicher und Datei", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await ready(fs);
    fs.beforeWrite = () => new Promise((r) => setTimeout(r, 5));
    const [r1, r2] = await Promise.all([a.store.persist(personTable(ID_B, BERTA)), a.store.persist(personTable(ID_C, CORA))]);
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    for (const t of [a.memory.table(), (await readFresh(fs, 0)).memory.table()]) {
      expect([ID_A, ID_B, ID_C].map((id) => nameOf(t, id))).toEqual([MAX, BERTA, CORA]);
    }
  });

  it("`persist` schreibt die Vereinigung aus dem aktuellen Stand, nicht einen Schnappschuss vom Beginn: Änderungsfunktionen sehen den frischen Stand", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await ready(fs);
    fs.beforeWrite = () => new Promise((r) => setTimeout(r, 5));
    const seen: number[] = [];
    const first = a.store.persist(personTable(ID_B, BERTA));
    const second = a.store.persist((cur) => { seen.push(cur.entries.length); return personTable(ID_C, CORA); });
    await Promise.all([first, second]);
    expect(seen).toEqual([2]);
  });

  it("`refresh` mit fremdem Eintrag während eines laufenden `persist`: beide in Speicher und Datei", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await ready(fs);
    let reached!: () => void;
    const atWrite = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    fs.beforeWrite = async () => { fs.beforeWrite = null; reached(); await hold; };
    const p = a.store.persist(personTable(ID_B, BERTA));
    await atWrite;
    await seedFile(fs, { deviceId: "dev-c", stand: 0, table: personTable(ID_C, CORA) });
    const r = a.store.refresh();
    await flush();
    release();
    await Promise.all([p, r]);
    for (const t of [a.memory.table(), (await readFresh(fs, 0)).memory.table()]) {
      expect([ID_A, ID_B, ID_C].map((id) => nameOf(t, id))).toEqual([MAX, BERTA, CORA]);
    }
  });

  it("`refresh` vereinigt in den Arbeitsspeicher statt ihn zu ersetzen: wird die eigene Datei zerstört, behält der Speicher ihren Inhalt und die neue Fassung trägt ihn wieder", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await ready(fs);
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable(ID_B, BERTA) });
    await a.store.persist(personTable(ID_C, CORA));
    fs.put(`dev-a${EXT}`, "zerstört von außen");
    await a.store.refresh();
    expect([ID_A, ID_B, ID_C].map((id) => nameOf(a.memory.table(), id))).toEqual([MAX, BERTA, CORA]);
    fs.files.delete(fs.path(`dev-b${EXT}`));
    const fresh = await readFresh(fs, 0);
    expect([ID_A, ID_B, ID_C].map((id) => nameOf(fresh.memory.table(), id))).toEqual([MAX, BERTA, CORA]);
  });

  it("scheitert das Schreiben, trägt der Arbeitsspeicher die Änderung nicht (alles oder nichts, Review-Fokus 5), die Platte ist unverändert", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await ready(fs);
    const before = fs.get(`dev-a${EXT}`);
    fs.failWrites = true;
    expect(await a.store.persist(personTable(ID_B, BERTA))).toEqual({ error: "storage-failed" });
    expect(nameOf(a.memory.table(), ID_B)).toBeUndefined();
    expect(a.memory.state()).toBe("ready");
    expect(fs.get(`dev-a${EXT}`)).toEqual(before);
    fs.failWrites = false;
    expect(await a.store.persist(personTable(ID_B, BERTA))).toBeUndefined();
    expect(nameOf(a.memory.table(), ID_B)).toBe(BERTA);
  });

  it("ein Fehler in einem Lauf hält die Warteschlange nicht an", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await ready(fs);
    const bad = a.store.persist(() => { throw new Error("Programmfehler mit Mustermann"); });
    const good = a.store.persist(personTable(ID_B, BERTA));
    expect(await bad).toEqual({ error: "storage-failed" });
    expect(await good).toBeUndefined();
    expect(nameOf(a.memory.table(), ID_B)).toBe(BERTA);
  });

  it("`persist` bringt den Gerätenamen und die Sprache in die Gerätedatei", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX), language: "en" });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0), name: "Mac Mini" });
    await a.store.refresh();
    expect(a.memory.language()).toBe("en");
    await a.store.persist(personTable(ID_B, BERTA));
    expect(a.memory.devices().find((d) => d.deviceId === "dev-a")?.name).toBe("Mac Mini");
    const c = await readFresh(fs, 0);
    expect(c.memory.language()).toBe("en");
    expect(c.memory.devices().find((d) => d.deviceId === "dev-a")?.name).toBe("Mac Mini");
  });
});

// ── Zwei Geräte teilen einen Ordner ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("zwei Geräte, ein Vault-Ordner (Integration)", () => {
  it("Gerät A schreibt, Gerät B liest binnen eines Auffrisch-Zyklus (Ereignis und Zeitgeber)", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: emptyTable() });
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: emptyTable() });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    const b = makeDevice(fs, { deviceId: "dev-b", content: await contentAt(CHAIN, 0) });
    const changed = vi.fn();
    const stopB = b.store.watch(changed);
    const stopA = a.store.watch();
    await a.store.refresh();
    await b.store.refresh();
    await flush();
    fs.clearLog();

    // Ereignis: Obsidian meldet die Datei von A.
    expect(await a.store.persist(personTable(ID_A, MAX))).toBeUndefined();
    b.manual.emit(fs.path(`dev-a${EXT}`));
    await flush();
    expect(nameOf(b.memory.table(), ID_A)).toBe(MAX);
    expect(changed).toHaveBeenCalled();

    // Zeitgeber: kein Ereignis (etwa weil Obsidian für den Dateityp keines meldet), der Zeitgeber findet die Änderung.
    expect(await a.store.persist(personTable(ID_B, BERTA))).toBeUndefined();
    b.manual.tick();
    await flush();
    expect(nameOf(b.memory.table(), ID_B)).toBe(BERTA);

    // A schreibt sich nicht selbst in Dauerschleife an: keine Wiederholung ohne neue Änderung.
    const writesA = fileWrites(fs).length;
    a.manual.tick();
    b.manual.tick();
    await flush();
    await flush();
    // (B schreibt nach dem Vereinigen höchstens seine eigene Fassung einmal; danach ruht alles.)
    const settled = fileWrites(fs).length;
    a.manual.tick();
    b.manual.tick();
    await flush();
    expect(fileWrites(fs).length).toBe(settled);
    expect(settled).toBeGreaterThanOrEqual(writesA);

    stopA();
    stopB();
    expect(b.manual.listeners.size).toBe(0);
  });

  it("A vergisst, B zieht nach: B dreht vor, übernimmt die Marke, A liest B zurück", async () => {
    const fs = new FakeFs(FOLDER);
    const both = personTable(ID_C, CORA, personTable(ID_A, MAX));
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: both });
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: both });
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    const b = makeDevice(fs, { deviceId: "dev-b", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    await b.store.refresh();
    expect(await a.store.persist((cur) => forgetIn(cur, ID_C))).toBeUndefined();
    expect(headOf(fs, "dev-a").stand).toBe(1);
    await b.store.refresh();
    expect(headOf(fs, "dev-b").stand).toBe(1);
    expect(storedKey(b).stand).toBe(1);
    expect(nameOf(b.memory.table(), ID_C)).toBeUndefined();
    expect(tableForgotten(b.memory.table() ?? emptyTable())).toContain(ID_C);
    await a.store.refresh();
    expect(a.memory.devices().every((d) => d.opened && d.carriesMarks && d.stand === 1)).toBe(true);
  });

  it("kein Klartext in Meldungen, Problemen oder Fehlerwerten", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: personTable(ID_A, MAX), name: "Mac A" });
    fs.put(`dev-x${EXT}`, "kaputt");
    fs.failWrites = true;
    const a = makeDevice(fs, { deviceId: "dev-a", content: await contentAt(CHAIN, 0) });
    await a.store.refresh();
    const r = await a.store.persist(personTable(ID_B, BERTA));
    const text = JSON.stringify([a.reports, a.store.problems(), r]);
    for (const secret of [MAX, BERTA, "Mustermann", "Beispiel"]) expect(text).not.toContain(secret);
  });
});
