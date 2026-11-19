// Vergessen, Schlüssel ersetzen, Gerät entfernen und der Code einer ersetzten Kette auf der Ebene des Bausteins (Bauplan Aufgabe 12 Schritt 1, Spec 8.3).
// Echtes WebCrypto, echte Kit-Bausteine; gefälscht sind Ablage und Schlüsselbund. Nur erfundene Werte.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFs } from "./helpers/fake-fs";
import { sampleTable } from "./helpers/table-fixtures";
import {
  CHAIN, EXT, FOLDER, ID_A, ID_B, ID_C, OTHER_CHAIN, contentAt, forgetIn, makeDevice, personTable, seedFile, stateAt, type Chain, type Device,
} from "./helpers/store-fixtures";
import { decodeRecoveryCode } from "../src/vendor/kit/recovery-code";
import { openEnvelope, readEnvelopeHeader } from "../src/vendor/kit/key-envelope";
import { encryptionKey } from "../src/vendor/kit/key-ratchet";
import { KEY_SECRET_ID } from "../src/obsidian/key-store";
import { decodePayload } from "../src/core/payload";
import { parseTable, serializeTable, tableEntry, tableForgotten, tableSetException, tableSetPlain, type PlaceholderTable } from "../src/vendor/kit/placeholder-table";

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
const MAIL = "max@example.org";
const PHONE = "030 1234567";
const NEW_CHAIN: Chain = { chainId: Uint8Array.from([0xab, 0xcd, 0x03, 0x03]), key: Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 7) & 0xff) };

const nameOf = (t: PlaceholderTable | null, id: string): string | undefined =>
  t === null ? undefined : tableEntry(t, id)?.values.find((v) => v.value.field === null)?.value.text;
const storedKey = (d: Device) => {
  const c = decodeRecoveryCode(d.secrets.raw(KEY_SECRET_ID));
  if (!c.ok) throw new Error("kein Code im Schlüsselbund");
  return c;
};

/** Öffnet die Datei eines Geräts mit dem Schlüssel ihres Standes und gibt Inhalt und Kopf zurück. */
async function openOf(fs: FakeFs, deviceId: string, chain: Chain = CHAIN) {
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
  return { header: h.header, payload: p, table: t.table, text: p.table as string };
}
const canOpen = async (fs: FakeFs, deviceId: string, chain: Chain): Promise<boolean> => {
  try { await openOf(fs, deviceId, chain); return true; } catch { return false; }
};
const idx = (log: string[], what: string): number => log.indexOf(what);

/** Zwei Personen: Max (Name, Mail, Telefon) und Berta. */
function twoPersons(): PlaceholderTable {
  return personTable(ID_B, BERTA, sampleTable());
}

/** Ein bereites Gerät auf `stand`, dessen Gerätedatei `table` trägt. */
async function readyDevice(fs: FakeFs, deviceId: string, table: PlaceholderTable, stand = 0, extra: { log?: string[]; keyWriteFails?: boolean } = {}): Promise<Device> {
  await seedFile(fs, { deviceId, stand, table, name: deviceId });
  const d = makeDevice(fs, { deviceId, content: await contentAt(CHAIN, stand), name: deviceId, ...extra });
  await d.store.refresh();
  expect(d.memory.state()).toBe("ready");
  return d;
}

// ── forget ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("forget: Person vergessen (Spec 8.3 Punkt 2)", () => {
  it("die geschriebene Fassung trägt die Marke und keinen Klartext der Person; Stand n+1; der Arbeitsspeicher löst sie nicht mehr auf", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 2);
    expect(await a.store.forget(ID_A)).toEqual({ ok: true, stand: 3 });
    const own = await openOf(fs, "dev-a");
    expect(own.header.stand).toBe(3);
    expect(tableForgotten(own.table)).toContain(ID_A);
    for (const secret of [MAX, MAIL, PHONE, "Mustermann"]) expect(own.text).not.toContain(secret);
    // Die andere Person bleibt unberührt.
    expect(nameOf(own.table, ID_B)).toBe(BERTA);
    expect(a.memory.stand()).toBe(3);
    expect(tableEntry(a.memory.table() as PlaceholderTable, ID_A)?.forgotten).toBe(true);
    expect(nameOf(a.memory.table(), ID_A)).toBeUndefined();
  });

  it("eine Einzelfall-Entscheidung zu einem Wert der Person („im Klartext lassen“), die nach dem Anlegen fiel, geht mit: die Fassung wird nicht mit dem Stand davor vereinigt", async () => {
    const fs = new FakeFs(FOLDER);
    const d = tableSetPlain(twoPersons(), "mail.md", MAX, true, { id: ID_C });
    if (!d.ok) throw new Error("fixture");
    const a = await readyDevice(fs, "dev-a", d.table, 0);
    expect(await a.store.forget(ID_A)).toEqual({ ok: true, stand: 1 });
    const own = await openOf(fs, "dev-a");
    expect(own.text).not.toContain(MAX);
    expect(a.memory.table()).not.toBeNull();
    expect(serializeTable(a.memory.table() as PlaceholderTable)).not.toContain(MAX);
  });

  it("erst die Datei, dann der Schlüssel (Regel 1); der Schlüssel steht danach auf n+1", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 0);
    a.log.length = 0;
    await a.store.forget(ID_A);
    expect(idx(a.log, "file:write")).toBeGreaterThanOrEqual(0);
    expect(idx(a.log, "key:write:1")).toBeGreaterThan(idx(a.log, "file:done"));
    expect(storedKey(a).stand).toBe(1);
    expect(storedKey(a).key).toEqual((await contentAt(CHAIN, 1)).key);
  });

  it("der alte Kettenzustand wird geleert, auch der aus dem Schlüsselbund gelesene Schlüssel", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 0);
    a.wiped.length = 0;
    a.keyReads.length = 0;
    await a.store.forget(ID_A);
    expect(a.wiped.some((s) => s.stand === 0)).toBe(true);
    expect(a.wiped.some((s) => s.stand === 1)).toBe(true);
    for (const s of a.wiped) expect(Array.from(s.chainKey).every((b) => b === 0)).toBe(true);
    expect(a.keyReads.length).toBeGreaterThan(0);
    for (const k of a.keyReads) expect(Array.from(k).every((b) => b === 0)).toBe(true);
  });

  it("dreht auch dann um einen Stand weiter, wenn dieses Gerät die Person nie selbst geschrieben hat", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, table: twoPersons() });
    const b = makeDevice(fs, { deviceId: "dev-b", content: await contentAt(CHAIN, 0) });
    expect(await b.store.forget(ID_A)).toEqual({ ok: true, stand: 1 });
    expect((await openOf(fs, "dev-b")).header.stand).toBe(1);
    expect(storedKey(b).stand).toBe(1);
  });

  it("liest vorher frisch: was ein anderes Gerät inzwischen über die Person weiß, geht in die Marke und die Gruppe", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 0);
    // Ein anderes Gerät trägt einen weiteren Wert derselben Person nach, ohne dass a es gelesen hat.
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: sampleTable() });
    const r = await a.store.forget(ID_A);
    expect(r).toEqual({ ok: true, stand: 1 });
    expect((await openOf(fs, "dev-a")).text).not.toContain(MAIL);
  });

  it("Datei geschrieben, Schlüssel nicht ablegbar: Grund key-write-failed, die Datei steht auf n+1 und ohne Klartext, der alte Schlüssel liegt noch", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 0, { keyWriteFails: true });
    expect(await a.store.forget(ID_A)).toEqual({ ok: false, reason: "key-write-failed" });
    const own = await openOf(fs, "dev-a");
    expect(own.header.stand).toBe(1);
    expect(own.text).not.toContain(MAX);
    expect(storedKey(a).stand).toBe(0);
  });

  it("scheitert das Schreiben: storage-failed, der Schlüssel bleibt, der Arbeitsspeicher trägt die Marke nicht", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 0);
    const before = a.secrets.raw(KEY_SECRET_ID);
    fs.failWrites = true;
    expect(await a.store.forget(ID_A)).toEqual({ ok: false, reason: "storage-failed" });
    expect(a.secrets.raw(KEY_SECRET_ID)).toBe(before);
    expect(tableEntry(a.memory.table() as PlaceholderTable, ID_A)?.forgotten).toBe(false);
    expect(a.memory.stand()).toBe(0);
  });

  it("eine unbekannte oder schon vergessene ID schreibt nichts", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 0);
    fs.clearLog();
    expect(await a.store.forget("zzzzzzzzzz")).toEqual({ ok: false, reason: "unknown-entry" });
    expect(await a.store.forget("nicht-id")).toEqual({ ok: false, reason: "unknown-entry" });
    expect(fs.log).toEqual([]);
    expect(await a.store.forget(ID_A)).toEqual({ ok: true, stand: 1 });
    fs.clearLog();
    expect(await a.store.forget(ID_A)).toEqual({ ok: false, reason: "already-forgotten" });
    expect(fs.log).toEqual([]);
    expect(storedKey(a).stand).toBe(1);
  });

  it("gesperrt oder nicht eingerichtet: nichts wird geschrieben", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, chain: OTHER_CHAIN, table: twoPersons() });
    const locked = makeDevice(fs, { deviceId: "dev-b", content: await contentAt(CHAIN, 0) });
    expect(await locked.store.forget(ID_A)).toEqual({ ok: false, reason: "locked" });
    const empty = new FakeFs(FOLDER);
    const fresh = makeDevice(empty, { deviceId: "dev-c", content: null });
    expect(await fresh.store.forget(ID_A)).toEqual({ ok: false, reason: "not-ready" });
    expect(empty.names()).toEqual([]);
  });

  it("zwei Geräte vergessen gleichzeitig verschiedene Personen: beide treffen sich auf n+2 (Regel 2), und keine Fassung trägt noch Klartext einer der beiden", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 0);
    const b = await readyDevice(fs, "dev-b", twoPersons(), 0);
    // b vergisst Berta vollständig, während a gelesen hat und gerade schreiben will: beide landen zuerst auf Stand 1 mit demselben Schlüssel.
    let injected = false;
    fs.beforeWrite = async (p) => {
      if (injected || !p.includes("dev-a")) return;
      injected = true;
      expect(await b.store.forget(ID_B)).toEqual({ ok: true, stand: 1 });
    };
    expect(await a.store.forget(ID_A)).toEqual({ ok: true, stand: 1 });
    fs.beforeWrite = null;
    expect(a.memory.stand()).toBe(1);
    // a liest die Marke von b, hat unter Stand 1 aber Berta lebend geschrieben: es dreht weiter.
    await a.store.refresh();
    expect(a.memory.stand()).toBe(2);
    expect(storedKey(a).stand).toBe(2);
    await b.store.refresh();
    expect(b.memory.stand()).toBe(2);
    expect(storedKey(b).stand).toBe(2);
    for (const id of ["dev-a", "dev-b"]) {
      const f = await openOf(fs, id);
      expect(f.header.stand).toBe(2);
      expect(tableForgotten(f.table)).toEqual([ID_A, ID_B].sort());
      for (const secret of [MAX, MAIL, PHONE, BERTA]) expect(f.text).not.toContain(secret);
    }
  });
});

// ── replaceKey ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("replaceKey: neue Kette (Spec 8.3 „Entfernen entzieht keinen Zugriff“)", () => {
  const newContent = (): { chainId: Uint8Array; stand: number; key: Uint8Array } => ({ chainId: Uint8Array.from(NEW_CHAIN.chainId), stand: 0, key: Uint8Array.from(NEW_CHAIN.key) });

  it("die eigene Fassung steht danach unter der neuen Kette mit allem Lesbaren samt Marken, DANN der neue Schlüssel", async () => {
    const fs = new FakeFs(FOLDER);
    const forgotten = (await (async () => { const t = twoPersons(); return t; })());
    const a = await readyDevice(fs, "dev-a", forgotten, 2);
    await a.store.forget(ID_B);
    // Ein anderes Gerät kennt etwas, das a noch nicht gelesen hat.
    await seedFile(fs, { deviceId: "dev-b", stand: 3, table: personTable("q7d2w8n4tz", "Carla Beispiel", sampleTable()) });
    a.log.length = 0;
    expect(await a.store.replaceKey(newContent())).toEqual({ ok: true });
    expect(idx(a.log, "key:write:0")).toBeGreaterThan(idx(a.log, "file:done"));
    const own = await openOf(fs, "dev-a", NEW_CHAIN);
    expect(own.header.stand).toBe(0);
    expect(Array.from(own.header.chainId)).toEqual(Array.from(NEW_CHAIN.chainId));
    expect(tableForgotten(own.table)).toContain(ID_B);
    expect(nameOf(own.table, ID_A)).toBe(MAX);
    expect(nameOf(own.table, "q7d2w8n4tz")).toBe("Carla Beispiel");
    expect(own.text).not.toContain(BERTA);
    // Die alte Kette öffnet die neue Datei nicht mehr.
    expect(await canOpen(fs, "dev-a", CHAIN)).toBe(false);
    const stored = storedKey(a);
    expect(Array.from(stored.chainId)).toEqual(Array.from(NEW_CHAIN.chainId));
    expect(stored.stand).toBe(0);
    expect(a.memory.state()).toBe("ready");
    expect(a.memory.stand()).toBe(0);
    expect(a.memory.codeStand()).toBe(0);
    expect(own.payload.device.codeShownAtStand).toBe(0);
  });

  it("die Dateien der anderen Geräte stehen danach als nicht geöffnet da (fremde Kette)", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 0);
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: twoPersons() });
    await a.store.refresh();
    expect(a.memory.devices().find((d) => d.deviceId === "dev-b")?.opened).toBe(true);
    await a.store.replaceKey(newContent());
    const rows = a.memory.devices();
    expect(rows.find((d) => d.deviceId === "dev-b")?.opened).toBe(false);
    expect(rows.find((d) => d.deviceId === "dev-a")?.opened).toBe(true);
  });

  it("der alte Kettenzustand wird geleert, und die Bytes des übergebenen Schlüssels bleiben unberührt", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 1);
    a.wiped.length = 0;
    const c = newContent();
    const copy = Uint8Array.from(c.key);
    await a.store.replaceKey(c);
    expect(c.key).toEqual(copy);
    expect(a.wiped.some((s) => s.stand === 1 && s.chainKey.every((b) => b === 0))).toBe(true);
    for (const s of a.wiped) expect(Array.from(s.chainKey).every((b) => b === 0)).toBe(true);
  });

  it("gesperrt: nichts wird geschrieben, der Schlüssel bleibt", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, chain: OTHER_CHAIN, table: twoPersons() });
    const b = makeDevice(fs, { deviceId: "dev-b", content: await contentAt(CHAIN, 0) });
    const before = b.secrets.raw(KEY_SECRET_ID);
    fs.clearLog();
    expect(await b.store.replaceKey(newContent())).toEqual({ ok: false, reason: "locked" });
    expect(fs.log).toEqual([]);
    expect(b.secrets.raw(KEY_SECRET_ID)).toBe(before);
    expect(fs.names()).toEqual([`dev-a${EXT}`]);
  });

  it("nicht eingerichtet: not-ready, nichts geschrieben", async () => {
    const fs = new FakeFs(FOLDER);
    const a = makeDevice(fs, { deviceId: "dev-a", content: null });
    expect(await a.store.replaceKey(newContent())).toEqual({ ok: false, reason: "not-ready" });
    expect(fs.names()).toEqual([]);
  });

  it("scheitert das Schreiben: storage-failed, der alte Schlüssel bleibt und die alte Datei auch", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 0);
    const before = a.secrets.raw(KEY_SECRET_ID);
    const oldBytes = fs.get(`dev-a${EXT}`);
    fs.failWrites = true;
    expect(await a.store.replaceKey(newContent())).toEqual({ ok: false, reason: "storage-failed" });
    expect(a.secrets.raw(KEY_SECRET_ID)).toBe(before);
    expect(fs.get(`dev-a${EXT}`)).toEqual(oldBytes);
    expect(a.memory.state()).toBe("ready");
  });

  it("Datei geschrieben, Schlüssel nicht ablegbar: key-write-failed; der alte Schlüssel liegt noch", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 0, { keyWriteFails: true });
    expect(await a.store.replaceKey(newContent())).toEqual({ ok: false, reason: "key-write-failed" });
    expect(await canOpen(fs, "dev-a", NEW_CHAIN)).toBe(true);
    expect(Array.from(storedKey(a).chainId)).toEqual(Array.from(CHAIN.chainId));
  });
});

// ── adopt nach dem Ersetzen ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("adopt nach einem Schlüsselwechsel: die alte Fassung wandert mit (Spec 8.3)", () => {
  /** a ersetzt den Schlüssel; b (alter Schlüssel) hat vorher etwas getan, das a nie gelesen hat: seine Datei erreicht a erst nach dem Ersetzen (Sync-Verzug).
   *  Danach ist b gesperrt und schreibt nicht mehr (Abschlussdatei, `table-store-closing.test.ts`); die Fassung von vorhin liegt noch da. */
  async function afterReplace(bWork: (b: Device) => Promise<void> = () => Promise.resolve()): Promise<{ fs: FakeFs; a: Device; b: Device }> {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 0);
    const b = await readyDevice(fs, "dev-b", twoPersons(), 0);
    const bOld = fs.get(`dev-b${EXT}`) ?? new Uint8Array();
    await bWork(b);
    const bNew = fs.get(`dev-b${EXT}`) ?? new Uint8Array();
    fs.put(`dev-b${EXT}`, bOld);
    expect(await a.store.replaceKey({ chainId: Uint8Array.from(NEW_CHAIN.chainId), stand: 0, key: Uint8Array.from(NEW_CHAIN.key) })).toEqual({ ok: true });
    fs.put(`dev-b${EXT}`, bNew);
    return { fs, a, b };
  }
  const newCode = () => ({ chainId: Uint8Array.from(NEW_CHAIN.chainId), stand: 0, key: Uint8Array.from(NEW_CHAIN.key) });

  it("ein Eintrag, den nur das alte Gerät kannte, steht danach in seiner Fassung unter der neuen Kette", async () => {
    // b hat mit dem alten Schlüssel gearbeitet, ehe es vom Wechsel erfuhr: neuer Eintrag und eine Marke, von denen a nichts weiß.
    const { fs, b } = await afterReplace(async (d) => {
      await d.store.persist(personTable("q7d2w8n4tz", "Carla Beispiel", sampleTable()));
      expect(await d.store.forget(ID_B)).toEqual({ ok: true, stand: 1 });
    });
    expect(await b.store.adopt(newCode())).toEqual({ ok: true });
    const own = await openOf(fs, "dev-b", NEW_CHAIN);
    expect(own.header.stand).toBe(0);
    expect(nameOf(own.table, "q7d2w8n4tz")).toBe("Carla Beispiel");
    expect(tableForgotten(own.table)).toContain(ID_B);
    expect(own.text).not.toContain(BERTA);
    expect(nameOf(own.table, ID_A)).toBe(MAX);
    expect(storedKey(b).stand).toBe(0);
    expect(Array.from(storedKey(b).chainId)).toEqual(Array.from(NEW_CHAIN.chainId));
    expect(nameOf(b.memory.table(), "q7d2w8n4tz")).toBe("Carla Beispiel");
  });

  it("dasselbe nach einem Neustart (leerer Arbeitsspeicher): die alte Fassung wird mit dem alten Schlüssel aus dem Schlüsselbund gelesen", async () => {
    const { fs, b } = await afterReplace((d) => d.store.persist(personTable("q7d2w8n4tz", "Carla Beispiel", sampleTable())).then(() => undefined));
    const restarted = makeDevice(fs, { deviceId: "dev-b", content: null, secrets: b.secrets, name: "dev-b" });
    expect(restarted.memory.table()).toBeNull();
    expect(await restarted.store.adopt(newCode())).toEqual({ ok: true });
    expect(nameOf((await openOf(fs, "dev-b", NEW_CHAIN)).table, "q7d2w8n4tz")).toBe("Carla Beispiel");
  });

  it("die eigene alte Datei wird dabei nicht als beschädigt beiseitegelegt, sondern abbruchsicher ersetzt", async () => {
    const { fs, b } = await afterReplace();
    await b.store.adopt(newCode());
    expect(b.log).not.toContain("file:replace-damaged");
    expect(fs.names().filter((n) => n.includes(".damaged-"))).toEqual([]);
    expect(b.reports.map((p) => p.kind)).not.toContain("own-set-aside");
  });

  it("öffnet der Code keine Datei, wird nichts gespeichert, auch wenn die alte Fassung lesbar wäre", async () => {
    const fs = new FakeFs(FOLDER);
    const b = await readyDevice(fs, "dev-b", twoPersons(), 0);
    const before = b.secrets.raw(KEY_SECRET_ID);
    const oldBytes = fs.get(`dev-b${EXT}`);
    const r = await b.store.adopt(newCode());
    expect(r.ok).toBe(false);
    expect(b.secrets.raw(KEY_SECRET_ID)).toBe(before);
    expect(fs.get(`dev-b${EXT}`)).toEqual(oldBytes);
  });

  it("ein Eintrag der alten Fassung, dessen Person die neue Kette schon vergessen hat, kommt nicht zurück", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 0);
    const b = await readyDevice(fs, "dev-b", twoPersons(), 0);
    expect(await a.store.forget(ID_B)).toEqual({ ok: true, stand: 1 });
    await a.store.replaceKey(newCode());
    expect(await b.store.adopt(newCode())).toEqual({ ok: true });
    const own = await openOf(fs, "dev-b", NEW_CHAIN);
    // Die Kette hat gewechselt: was dieses Gerät auf der alten geschrieben hat, löst kein Vordrehen auf der neuen aus.
    expect(own.header.stand).toBe(0);
    expect(tableForgotten(own.table)).toContain(ID_B);
    expect(own.text).not.toContain(BERTA);
  });
});

// ── removeDevice ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("removeDevice: Gerät entfernen (Spec 8.3)", () => {
  it("übernimmt zuerst alles Lesbare samt Marken in die eigene Fassung und löscht DANN die fremde Datei", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", personTable(ID_A, MAX), 0);
    // b kennt eine zweite Person und hat eine dritte schon vergessen.
    const t = personTable("q7d2w8n4tz", "Carla Beispiel", personTable(ID_B, BERTA, personTable(ID_A, MAX)));
    const forgot = forgetIn(t, ID_B);
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: forgot });
    fs.clearLog();
    const r = await a.store.removeDevice("dev-b");
    expect(r).toEqual({ ok: true, wasReadable: true, removed: true });
    const own = await openOf(fs, "dev-a", CHAIN);
    expect(nameOf(own.table, "q7d2w8n4tz")).toBe("Carla Beispiel");
    expect(tableForgotten(own.table)).toContain(ID_B);
    expect(own.text).not.toContain(BERTA);
    expect(fs.names()).not.toContain(`dev-b${EXT}`);
    const wrote = fs.log.findIndex((l) => l.startsWith("rename:") && l.endsWith(`dev-a${EXT}`));
    const removed = fs.log.findIndex((l) => l === `remove:${FOLDER}/dev-b${EXT}`);
    expect(wrote).toBeGreaterThanOrEqual(0);
    expect(removed).toBeGreaterThan(wrote);
    expect(a.memory.devices().map((d) => d.deviceId)).toEqual(["dev-a"]);
  });

  it("scheitert das Schreiben der eigenen Fassung: die fremde Datei bleibt liegen", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", personTable(ID_A, MAX), 0);
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable(ID_B, BERTA) });
    fs.failWrites = true;
    expect(await a.store.removeDevice("dev-b")).toEqual({ ok: false, reason: "storage-failed" });
    expect(fs.names()).toContain(`dev-b${EXT}`);
  });

  it("ein Gerät mit nicht lesbarer Fassung (älterer Stand): wasReadable ist false, die Datei wird trotzdem entfernt, übernommen wird nichts", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 0);
    // a dreht weiter, bevor es die Datei von b je gelesen hat; danach ist b (Stand 0) für a nicht mehr lesbar.
    await a.store.forget(ID_B);
    await seedFile(fs, { deviceId: "dev-b", stand: 0, table: personTable("q7d2w8n4tz", "Carla Beispiel") });
    await a.store.refresh();
    expect(a.memory.devices().find((d) => d.deviceId === "dev-b")?.opened).toBe(false);
    const r = await a.store.removeDevice("dev-b");
    expect(r).toEqual({ ok: true, wasReadable: false, removed: true });
    expect(nameOf((await openOf(fs, "dev-a", CHAIN)).table, "q7d2w8n4tz")).toBeUndefined();
    expect(fs.names()).not.toContain(`dev-b${EXT}`);
  });

  it("die eigene Datei entfernt es nie", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 0);
    fs.clearLog();
    expect(await a.store.removeDevice("dev-a")).toEqual({ ok: false, reason: "own-device" });
    expect(fs.log).toEqual([]);
    expect(fs.names()).toContain(`dev-a${EXT}`);
  });

  it("gesperrt: weder geschrieben noch gelöscht", async () => {
    const fs = new FakeFs(FOLDER);
    await seedFile(fs, { deviceId: "dev-a", stand: 0, chain: OTHER_CHAIN, table: twoPersons() });
    await seedFile(fs, { deviceId: "dev-c", stand: 0, chain: OTHER_CHAIN, table: twoPersons() });
    const b = makeDevice(fs, { deviceId: "dev-b", content: await contentAt(CHAIN, 0) });
    fs.clearLog();
    expect(await b.store.removeDevice("dev-c")).toEqual({ ok: false, reason: "locked" });
    expect(fs.log).toEqual([]);
    expect(fs.names()).toContain(`dev-c${EXT}`);
  });

  it("ein Gerät, das es nicht gibt: removed ist false, nichts geht kaputt", async () => {
    const fs = new FakeFs(FOLDER);
    const a = await readyDevice(fs, "dev-a", twoPersons(), 0);
    expect(await a.store.removeDevice("dev-zzz")).toEqual({ ok: true, wasReadable: false, removed: false });
  });
});

// ── Ausnahmeliste ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("forget und die Ausnahmeliste", () => {
  it("ein Wert auf der Ausnahmeliste bleibt dort stehen, die Ausnahmeliste gehört keiner Person (Grenze, die der Dialog nennt)", async () => {
    const fs = new FakeFs(FOLDER);
    const r = tableSetException(twoPersons(), PHONE, true);
    if (!r.ok) throw new Error("fixture");
    const a = await readyDevice(fs, "dev-a", r.table, 0);
    await a.store.forget(ID_A);
    const own = await openOf(fs, "dev-a");
    expect(own.text).toContain(PHONE);
    expect(serializeTable(own.table)).toContain(PHONE);
  });
});
