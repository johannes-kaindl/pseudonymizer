import type { SecretStore } from "../../src/vendor/kit/secrets";
import { encodeRecoveryCode, type RecoveryCodeContent } from "../../src/vendor/kit/recovery-code";

/** Erfundener, erkennbar künstlicher Schlüsselinhalt (kein echtes Schlüsselmaterial). */
export function sampleContent(seed = 1, stand = 3): RecoveryCodeContent {
  return {
    chainId: Uint8Array.from([0xc0, 0xde, seed, 0x01]),
    stand,
    key: Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + seed) & 0xff),
  };
}

export function codeOf(content: RecoveryCodeContent): string {
  const r = encodeRecoveryCode(content);
  if (!r.ok) throw new Error("fixture: encode failed");
  return r.code;
}

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CHECK_ALPHABET = `${ALPHABET}*~$=U`;

/** Ein gültiger Code (Prüfzeichen stimmt) mit frei wählbarem Versionsbyte: unabhängig vom Kit nachgebaut, damit der Fehlergrund `version` erreichbar ist. */
export function codeWithVersion(version: number): string {
  const bytes = new Uint8Array(40);
  bytes[0] = version;
  bytes.set(sampleContent().chainId, 1);
  bytes.set(sampleContent().key, 8);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  const values: number[] = [];
  for (let i = 0; i < bits.length; i += 5) values.push(parseInt(bits.slice(i, i + 5), 2));
  let r = 0;
  for (const v of values) r = (r * 32 + v) % 37;
  const text = values.map((v) => ALPHABET[v]).join("") + CHECK_ALPHABET[r];
  return text.match(/.{1,5}/g)?.join("-") ?? "";
}

export interface FakeSecrets extends SecretStore {
  /** Was im Schlüsselbund unter einer ID steht (leer, wenn nichts). */
  raw(id: string): string;
  /** Setzt einen Wert am Kit vorbei (Beschädigung, Fremdschreiber). */
  poke(id: string, value: string): void;
  calls: string[];
}

export interface FakeSecretsOptions {
  /** `set` wirft diese Meldung (wie `obsidianSecretStore`, wenn der Wert nicht gehalten wird). */
  throwOnSet?: string;
  throwOnGet?: string;
  throwOnDelete?: string;
  /** `set` kehrt zurück, behält den Wert aber nicht (Store ohne Rücklesen). */
  dropWrites?: boolean;
}

/** Fake nach dem Vertrag von `obsidianSecretStore`: synchron, `delete` schreibt den Leerstring, leer gilt als nicht vorhanden. */
export function fakeSecrets(opts: FakeSecretsOptions = {}): FakeSecrets {
  const m = new Map<string, string>();
  const calls: string[] = [];
  return {
    calls,
    raw: (id) => m.get(id) ?? "",
    poke: (id, v) => { m.set(id, v); },
    get(id) {
      calls.push(`get:${id}`);
      if (opts.throwOnGet !== undefined) throw new Error(opts.throwOnGet);
      const v = m.get(id) ?? "";
      return v === "" ? null : v;
    },
    set(id, value) {
      calls.push(`set:${id}`);
      if (opts.throwOnSet !== undefined) throw new Error(opts.throwOnSet);
      if (opts.dropWrites !== true) m.set(id, value);
    },
    has: (id) => (m.get(id) ?? "") !== "",
    delete(id) {
      calls.push(`delete:${id}`);
      if (opts.throwOnDelete !== undefined) throw new Error(opts.throwOnDelete);
      m.set(id, "");
    },
  };
}
