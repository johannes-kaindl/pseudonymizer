// vendored from code-kit@0.86.1, src/ts/web/key-envelope.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
/** Encrypted envelope: bytes under AES-256-GCM with a readable header (format, version, device id, chain id, key stand) that is authenticated as additional data.
 *
 *  ABGENOMMEN 2026-11-19 — Opus-Review in zwei Runden (Runde 1 gegen 446a089: 0 blockierend, 0 wichtig, 6 klein, behoben in 53fd995; Runde 2 gegen 53fd995: abgenommen) mit Messung in Chromium 142 (Obsidian 1.15.1) und Node: Vektoren aus RFC 5869 und NIST CAVP, Bitkipp-Versuche, 10 000 Siegel ohne doppelten Nonce. Berichte: review-krypto-runde1.md und review-krypto-runde2.md im Planungs-Cache der Welle 36 (Kit-Linie). Nicht gemessen: WebKit/iOS (kommt mit der iPhone-Messung des Pseudonymizers).
 *
 *  Origin: order 4 of the pseudonymizer design (spec `25_Coding/pseudonymizer/_SDD/2026-11-18-pseudonymizer-design.md` § 7.3 row 1, § 8.2): one file
 *  per device in the vault, readable header, encrypted body. The key comes from `web/key-ratchet` (`encryptionKey`), the chain key lives in the
 *  key chain of the host and on paper as `pure/recovery-code`.
 *
 *  ── Axis: `web`, not `pure` ─────────────────────────────────────────────────────────────
 *  Only WebCrypto (`globalThis.crypto.subtle`, `crypto.getRandomValues`); no `node:crypto`, no primitive of our own. Named procedure: AES-256-GCM
 *  (NIST SP 800-38D), 96-bit nonce, 128-bit tag.
 *
 *  ── The bytes ───────────────────────────────────────────────────────────────────────────
 *  `header` · `nonce` (12) · `ciphertext` · `tag` (16). The header is ONE ASCII line ending in `\n`:
 *  `code-kit-envelope 1 <deviceId> <chainId as 8 lower-case hex> <stand as decimal>\n`, at most 128 bytes. It is readable without a key
 *  (`readEnvelopeHeader`) so that a device can tell which key stand a file needs, but it is NOT trusted until `openEnvelope` has authenticated it:
 *  the exact header bytes are the additional authenticated data (AAD) of the GCM, so changing one byte of the header makes the tag fail. A header is
 *  read strictly: the parsed fields are written back and must equal the bytes read (no leading zeros in the stand, no upper-case hex, no second blank).
 *
 *  ── The contract ────────────────────────────────────────────────────────────────────────
 *  - `sealEnvelope(key, header, plaintext)` takes a fresh 96-bit nonce from `crypto.getRandomValues` for EVERY call. The nonce is not a parameter and
 *    there is no option to set it; a caller cannot repeat one.
 *  - `openEnvelope(key, bytes)` returns the plaintext and the AUTHENTICATED header, or a reason. A wrong key, a changed header byte, a changed
 *    nonce, a changed ciphertext byte and a cut file are all `authentication` or `truncated`; the cryptography does not say which of the first four
 *    it was, and this module does not guess.
 *  - Errors are values. A reason is one of a closed list and never carries key material, plaintext, a nonce or the text of a platform exception.
 *  - `aesGcmSeal` and `aesGcmOpen` are the same two operations over a given AAD, without the header; the envelope is built on them and the standard
 *    test vectors (NIST CAVP) run through them. `aesGcmSeal` has no nonce parameter either: the vectors are run by replacing `getRandomValues`.
 *
 *  ── Für das Review ──────────────────────────────────────────────────────────────────────
 *  Threat picture (spec § 11.3): someone reads or changes the table file without the key, or replays an older genuine file. The envelope hides the
 *  content, makes any change (also of the header) detectable, and does NOT protect against someone who holds the key, nor against replaying an
 *  older genuine file (spec § 8.2 says so: it only re-adds entries the table already knew, forgotten ones stay forgotten through the marks of the
 *  other devices).
 *  Decisions: (1) The header is text, one line, strict and canonical, so that the AAD is exactly the bytes on disk and there is no second reading
 *  of the same file. (2) The device id is limited to `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` so that it needs no escaping in the line. (3) No length
 *  field for the body: the body is everything after the nonce. (4) An empty plaintext is allowed (a table with nothing in it). (5) No padding: the
 *  size of the file tells the size of the table, which the vault shows anyway. (6) The key must be a secret `CryptoKey` of AES-GCM, 256 bits; anything else is
 *  `key`. (7) The nonce is never reused by this module: 96 random bits per call, a collision is expected after about 2^48 encryptions under one key
 *  and the NIST limit of 2^32 per key is far above what a vault writes per stand.
 *  Not examined: behaviour with files above a few MiB (no limit is set here; the platform's limit for one `encrypt` call applies), whether the
 *  platform's `getRandomValues` is good (it is the platform's), timing side channels of the platform AES-GCM, WebKit on iOS (measured in Node 24
 *  only; the Chromium measurement is the review's job), and what a host does with the plaintext after `openEnvelope` returns it. */

const FORMAT = "code-kit-envelope";
/** Version written by this module. */
export const ENVELOPE_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_MAX = 128;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CHAIN_ID_HEX = /^[0-9a-f]{8}$/;
/** Largest key stand (24 bits, as in `key-ratchet` and `recovery-code`). */
const MAX_STAND = 2 ** 24 - 1;

export interface EnvelopeHeader {
  /** `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`: the device that wrote the file. */
  deviceId: string;
  /** 4 bytes: the key chain the file belongs to. */
  chainId: Uint8Array;
  /** 0 to 2^24 - 1: the key stand the file is encrypted under. */
  stand: number;
}

export type SealResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: "header" | "key" | "platform" };
export type OpenResult =
  | { ok: true; header: EnvelopeHeader; plaintext: Uint8Array }
  | { ok: false; reason: "format" | "version" | "header" | "truncated" | "key" | "authentication" };
export type HeaderResult = { ok: true; header: EnvelopeHeader } | { ok: false; reason: "format" | "version" | "header" };

const hex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

/** The header line for a header, or null when a field is outside what the line can hold. */
function headerLine(h: EnvelopeHeader): string | null {
  if (!DEVICE_ID.test(h.deviceId)) return null;
  if (h.chainId.length !== 4) return null;
  if (!Number.isInteger(h.stand) || h.stand < 0 || h.stand > MAX_STAND) return null;
  return `${FORMAT} ${ENVELOPE_VERSION} ${h.deviceId} ${hex(h.chainId)} ${h.stand}\n`;
}

/** Reads the header of an envelope WITHOUT a key. The result is not authenticated: use it to pick the key, then call `openEnvelope`. */
export function readEnvelopeHeader(bytes: Uint8Array): HeaderResult {
  const end = bytes.subarray(0, HEADER_MAX).indexOf(0x0a);
  if (end < 0) return { ok: false, reason: "format" };
  let line: string;
  try {
    // `ignoreBOM: true` keeps a leading U+FEFF in the text (the default strips it), so `EF BB BF` before the header cannot be read as the same header: it fails the format check.
    line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end));
  } catch {
    return { ok: false, reason: "format" };
  }
  const parts = line.split(" ");
  if (parts[0] !== FORMAT) return { ok: false, reason: "format" };
  // The version comes before the field count: a later version may have other fields, and it is still "version", not "header".
  if (parts[1] !== String(ENVELOPE_VERSION)) return { ok: false, reason: /^[1-9][0-9]{0,8}$/.test(parts[1] ?? "") ? "version" : "header" };
  if (parts.length !== 5) return { ok: false, reason: "header" };
  const deviceId = parts[2] ?? "";
  const chainHex = parts[3] ?? "";
  const standText = parts[4] ?? "";
  if (!DEVICE_ID.test(deviceId) || !CHAIN_ID_HEX.test(chainHex) || !/^(0|[1-9][0-9]{0,7})$/.test(standText)) return { ok: false, reason: "header" };
  const stand = Number(standText);
  if (stand > MAX_STAND) return { ok: false, reason: "header" };
  const chainId = Uint8Array.from({ length: 4 }, (_, i) => parseInt(chainHex.slice(2 * i, 2 * i + 2), 16));
  const header: EnvelopeHeader = { deviceId, chainId, stand };
  // Canonical: what was read, written back, is what is on disk (the header bytes are the AAD, there must be one reading only).
  return headerLine(header) === `${line}\n` ? { ok: true, header } : { ok: false, reason: "header" };
}

function usable(key: CryptoKey): boolean {
  const algorithm = key.algorithm as Partial<AesKeyAlgorithm> | undefined;
  return key.type === "secret" && algorithm?.name === "AES-GCM" && algorithm.length === 256;
}

/** AES-256-GCM over `aad`: `nonce (12) · ciphertext · tag (16)`. A fresh random nonce per call; there is no way to pass one. */
export async function aesGcmSeal(key: CryptoKey, aad: Uint8Array, plaintext: Uint8Array): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: "key" | "platform" }> {
  if (!usable(key) || !key.usages.includes("encrypt")) return { ok: false, reason: "key" };
  try {
    const nonce = new Uint8Array(NONCE_BYTES);
    globalThis.crypto.getRandomValues(nonce);
    const sealed = new Uint8Array(
      await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: Uint8Array.from(aad), tagLength: TAG_BYTES * 8 }, key, Uint8Array.from(plaintext)),
    );
    const out = new Uint8Array(NONCE_BYTES + sealed.length);
    out.set(nonce, 0);
    out.set(sealed, NONCE_BYTES);
    return { ok: true, bytes: out };
  } catch {
    return { ok: false, reason: "platform" };
  }
}

/** Opens `nonce (12) · ciphertext · tag (16)` over `aad`. Wrong key, changed AAD, changed bytes: `authentication`, nothing else is said. */
export async function aesGcmOpen(key: CryptoKey, aad: Uint8Array, sealed: Uint8Array): Promise<{ ok: true; plaintext: Uint8Array } | { ok: false; reason: "truncated" | "key" | "authentication" }> {
  if (!usable(key) || !key.usages.includes("decrypt")) return { ok: false, reason: "key" };
  if (sealed.length < NONCE_BYTES + TAG_BYTES) return { ok: false, reason: "truncated" };
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Uint8Array.from(sealed.subarray(0, NONCE_BYTES)), additionalData: Uint8Array.from(aad), tagLength: TAG_BYTES * 8 },
      key,
      Uint8Array.from(sealed.subarray(NONCE_BYTES)),
    );
    return { ok: true, plaintext: new Uint8Array(plain) };
  } catch {
    // WebCrypto reports every failure of the tag with the same bare error; the platform's text is dropped on purpose.
    return { ok: false, reason: "authentication" };
  }
}

/** Header line (as AAD) · nonce · ciphertext · tag. */
export async function sealEnvelope(key: CryptoKey, header: EnvelopeHeader, plaintext: Uint8Array): Promise<SealResult> {
  const line = headerLine(header);
  if (line === null) return { ok: false, reason: "header" };
  const head = new TextEncoder().encode(line);
  const sealed = await aesGcmSeal(key, head, plaintext);
  if (!sealed.ok) return sealed;
  const out = new Uint8Array(head.length + sealed.bytes.length);
  out.set(head, 0);
  out.set(sealed.bytes, head.length);
  return { ok: true, bytes: out };
}

/** The plaintext and the authenticated header of an envelope, or a reason. Reads the header strictly, then opens with the header bytes as AAD. */
export async function openEnvelope(key: CryptoKey, bytes: Uint8Array): Promise<OpenResult> {
  const read = readEnvelopeHeader(bytes);
  if (!read.ok) return read;
  const headEnd = bytes.indexOf(0x0a) + 1;
  const opened = await aesGcmOpen(key, bytes.subarray(0, headEnd), bytes.subarray(headEnd));
  if (!opened.ok) return opened;
  return { ok: true, header: read.header, plaintext: opened.plaintext };
}
