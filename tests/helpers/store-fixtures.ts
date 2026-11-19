// Bausteine für die Tests von `table-store.ts`: erfundene Ketten, Gerätedateien, die der Test ohne den Prüfling mit den Kit-Bausteinen selbst siegelt,
// und ein Gerät aus Fakes für Ablage und Schlüsselbund mit echtem WebCrypto.
import { createTableStore, type FileProblem, type TableStore, type TableStoreOptions } from "../../src/obsidian/table-store";
import { createKeyStore, type KeyStore } from "../../src/obsidian/key-store";
import { createDeviceFiles, type DeviceFiles } from "../../src/vendor/kit-obsidian/device-files";
import { sealEnvelope } from "../../src/vendor/kit/key-envelope";
import { advance, advanceTo, encryptionKey, RATCHET_MAX_JUMP, wipe, type ChainState } from "../../src/vendor/kit/key-ratchet";
import type { RecoveryCodeContent } from "../../src/vendor/kit/recovery-code";
import { emptyTable, serializeTable, tableAddEntry, tableAddValue, tableForget, type PlaceholderTable } from "../../src/vendor/kit/placeholder-table";
import { encodePayload, type PlaceholderLanguage } from "../../src/core/payload";
import { MemoryTable } from "../../src/core/memory-table";
import { fakeSecrets, type FakeSecrets } from "./key-fixtures";
import { FakeFs, ManualPorts } from "./fake-fs";

export const FOLDER = "_pseudonymizer";
export const EXT = ".pseudo";

/** Erfundene Kennungen (zehn Zeichen aus dem Alphabet der Platzhalter-IDs). */
export const ID_A = "k3x9m2ab7q";
export const ID_B = "m4t8c6r2vp";
export const ID_C = "q7d2w8n4tz";

export interface Chain { chainId: Uint8Array; key: Uint8Array }
export const CHAIN: Chain = { chainId: Uint8Array.from([0xc0, 0xde, 0x01, 0x01]), key: Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 11) & 0xff) };
export const OTHER_CHAIN: Chain = { chainId: Uint8Array.from([0xfe, 0xed, 0x02, 0x02]), key: Uint8Array.from({ length: 32 }, (_, i) => (i * 9 + 3) & 0xff) };

export const hex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

/** Der Zustand der Kette bei `stand` (Stand 0 ist die Kette selbst). */
export async function stateAt(chain: Chain, stand: number): Promise<ChainState> {
  let cur: ChainState = { chainId: Uint8Array.from(chain.chainId), stand: 0, chainKey: Uint8Array.from(chain.key) };
  // Der Sprungdeckel des Kits gilt auch für die Fixture: in Schritten bis zum Deckel.
  while (cur.stand < stand) {
    const r = await advanceTo(cur, Math.min(stand, cur.stand + RATCHET_MAX_JUMP));
    if (!r.ok) throw new Error(`fixture: advanceTo ${String(stand)}: ${r.reason}`);
    cur = r.value;
  }
  return cur;
}

/** Der Schlüsselinhalt, den ein Gerät auf `stand` im Schlüsselbund hält. */
export async function contentAt(chain: Chain, stand: number): Promise<RecoveryCodeContent> {
  const s = await stateAt(chain, stand);
  return { chainId: s.chainId, stand: s.stand, key: s.chainKey };
}

/** Eine Person mit Namen: die kleinste Tabelle, die ein Gerät kennen kann. */
export function personTable(id: string, name: string, base: PlaceholderTable = emptyTable()): PlaceholderTable {
  const e = tableAddEntry(base, id, "person");
  if (!e.ok) throw new Error(`fixture: ${e.error}`);
  const v = tableAddValue(e.table, { id, field: null, text: name });
  if (!v.ok) throw new Error(`fixture: ${v.error}`);
  return v.table;
}

export function forgetIn(table: PlaceholderTable, id: string): PlaceholderTable {
  const r = tableForget(table, id);
  if (!r.ok) throw new Error(`fixture: ${r.error}`);
  return r.table;
}

export interface SeedOptions {
  deviceId: string;
  chain?: Chain;
  stand: number;
  table: PlaceholderTable;
  name?: string;
  language?: PlaceholderLanguage;
  /** Schreibt die Datei unter einem anderen Namen als der Geräte-ID im Kopf. */
  fileName?: string;
}

/** Siegelt eine Gerätedatei mit den Kit-Bausteinen, unabhängig vom Prüfling, und legt sie in den Ordner. */
export async function seedFile(fs: FakeFs, o: SeedOptions): Promise<Uint8Array> {
  const chain = o.chain ?? CHAIN;
  const state = await stateAt(chain, o.stand);
  const key = await encryptionKey(state);
  if (!key.ok) throw new Error("fixture: encryptionKey");
  const plain = encodePayload({
    format: "pseudonymizer-device",
    version: 1,
    device: { name: o.name ?? o.deviceId, codeShownAtStand: null },
    vault: { language: o.language ?? "de" },
    table: serializeTable(o.table),
  });
  const sealed = await sealEnvelope(key.value, { deviceId: o.deviceId, chainId: chain.chainId, stand: o.stand }, plain);
  if (!sealed.ok) throw new Error("fixture: sealEnvelope");
  fs.put(`${o.fileName ?? o.deviceId}${EXT}`, sealed.bytes);
  return sealed.bytes;
}

export interface Device {
  id: string;
  store: TableStore;
  memory: MemoryTable;
  secrets: FakeSecrets;
  keys: KeyStore;
  files: DeviceFiles;
  manual: ManualPorts;
  reports: FileProblem[];
  /** Aufrufe von Ablage und Schlüsselbund in der Reihenfolge, in der sie geschahen. */
  log: string[];
  /** Jeder Kettenzustand, den der Prüfling an `wipe` übergeben hat (dieselben Objekte, damit der Test ihre Bytes prüfen kann). */
  wiped: ChainState[];
  /** Jeder Schlüssel, den `keys.read()` herausgegeben hat. */
  keyReads: Uint8Array[];
  /** Der Name dieses Geräts, wie ihn das Plugin aus dem Gerätezustand liest; ein Test ändert ihn, um die Umbenennung zu spielen. */
  name: { current: string };
  /** Die geräteeigene Marke „Schlüssel ersetzen läuft“ (lokaler Speicher des Geräts); ein Neustart desselben Geräts reicht dieselbe Hülle weiter. */
  pending: { current: string | null };
}

export interface DeviceOptions {
  deviceId: string;
  /** Schlüsselinhalt im Schlüsselbund; `null`: kein Schlüssel. */
  content: RecoveryCodeContent | null;
  name?: string;
  language?: PlaceholderLanguage;
  log?: string[];
  secrets?: FakeSecrets;
  /** Wählt `writeOwn` und `replaceDamagedOwn` zum Eingreifen (Verzögern, Scheitern). */
  wrapFiles?: (files: DeviceFiles, log: string[]) => DeviceFiles;
  keyWriteFails?: boolean;
  /** Die Marke dieses Geräts; ein Neustart (`makeDevice` mit demselben Schlüsselbund) übernimmt sie. */
  pending?: { current: string | null };
}

export function makeDevice(fs: FakeFs, o: DeviceOptions): Device {
  const log = o.log ?? [];
  const manual = new ManualPorts(fs);
  const secrets = o.secrets ?? fakeSecrets();
  const inner = createKeyStore(secrets);
  const keyReads: Uint8Array[] = [];
  const keys: KeyStore = {
    read() {
      const r = inner.read();
      if (r !== null && !("error" in r)) keyReads.push(r.key);
      return r;
    },
    write(c) {
      log.push(`key:write:${String(c.stand)}`);
      if (o.keyWriteFails === true) return { error: "storage-failed" };
      return inner.write(c);
    },
    clear: () => { inner.clear(); },
  };
  if (o.content !== null) {
    inner.write(o.content);
    secrets.calls.length = 0;
  }
  const real = createDeviceFiles({ folder: FOLDER, extension: EXT, deviceId: o.deviceId, ports: manual.ports() });
  const logged: DeviceFiles = {
    ...real,
    async writeOwn(b) { log.push("file:write"); const r = await real.writeOwn(b); log.push(r.ok ? "file:done" : "file:failed"); return r; },
    async replaceDamagedOwn(b) { log.push("file:replace-damaged"); const r = await real.replaceDamagedOwn(b); log.push(r.ok ? "file:done" : "file:failed"); return r; },
    watch: (cb, opts) => real.watch(cb, opts),
  };
  const files = o.wrapFiles === undefined ? logged : o.wrapFiles(logged, log);
  const memory = new MemoryTable();
  const reports: FileProblem[] = [];
  const wiped: ChainState[] = [];
  const name = { current: o.name ?? o.deviceId };
  const pending = o.pending ?? { current: null };
  const opts: TableStoreOptions = {
    files,
    closingFiles: (id) => createDeviceFiles({ folder: FOLDER, extension: EXT, deviceId: id, ports: manual.ports() }),
    keys,
    memory,
    deviceName: () => name.current,
    replacePending: { read: () => pending.current, write: (c) => { pending.current = c; } },
    defaultLanguage: () => o.language ?? "de",
    onProblem: (p) => { reports.push(p); },
    ratchet: { advance, advanceTo, encryptionKey, wipe: (s) => { wiped.push(s); wipe(s); }, maxJump: RATCHET_MAX_JUMP },
  };
  return { id: o.deviceId, store: createTableStore(opts), memory, secrets, keys, files, manual, reports, log, wiped, keyReads, name, pending };
}
