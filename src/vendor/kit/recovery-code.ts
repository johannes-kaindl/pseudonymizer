// vendored from code-kit@0.86.1, src/ts/pure/recovery-code.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
/** Recovery code: chain id, key stand and a 32-byte key as groups of Crockford-Base32 characters with a check symbol.
 *
 *  ABGENOMMEN 2026-11-19 — Opus-Review in zwei Runden (Runde 1 gegen 446a089: 0 blockierend, 0 wichtig, 6 klein, behoben in 53fd995; Runde 2 gegen 53fd995: abgenommen) mit Messung in Chromium 142 (Obsidian 1.15.1) und Node: Vektoren aus RFC 5869 und NIST CAVP, Bitkipp-Versuche, 10 000 Siegel ohne doppelten Nonce. Berichte: review-krypto-runde1.md und review-krypto-runde2.md im Planungs-Cache der Welle 36 (Kit-Linie). Nicht gemessen: WebKit/iOS (kommt mit der iPhone-Messung des Pseudonymizers).
 *
 *  Origin: order 3 of the pseudonymizer design (spec `25_Coding/pseudonymizer/_SDD/2026-11-18-pseudonymizer-design.md` § 7.3 row 3 and § 8.3), the
 *  device that sets up the key shows the code once, another device types it in. Pure encoding: no I/O, no randomness, no cryptography other
 *  than the check symbol. The envelope and the ratchet that use the key are `web/key-envelope` and `web/key-ratchet`.
 *
 *  ── Layout ──────────────────────────────────────────────────────────────────────────────
 *  40 bytes, big-endian: `version` (1) · `chainId` (4) · `stand` (3, 0 to 16 777 215) · `key` (32). 40 bytes are 320 bits are exactly 64 Base32
 *  symbols, so there is no padding to get wrong. The 65th symbol is the check symbol. Shown as 13 groups of 5 separated by `-`.
 *
 *  ── The named procedure ─────────────────────────────────────────────────────────────────
 *  Crockford's Base32 (https://www.crockford.com/base32.html): alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no I, L, O, U); on reading `I` and `L`
 *  count as `1`, `O` as `0`, case does not matter, hyphens are ignored. The check symbol is the value of the whole number modulo 37 written with
 *  the 37-symbol alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U` (the five extra symbols only ever stand in the check position). There is no hash
 *  of our own. The number is never built: the remainder is folded in symbol by symbol (`r = (r * 32 + d) mod 37`), so no BigInt is needed.
 *
 *  What the check symbol detects (37 is prime, 32 and 31 are coprime to it): EVERY single wrong symbol, and EVERY swap of two neighbouring
 *  different symbols, also with the check symbol itself (the position-by-position proof is in the test header, measured exhaustively on top).
 *  What it does not detect: two or more independent mistakes pass with a chance of 1 in 37 (measured 1 in 38.9 over 393 763 random double
 *  mistakes). The cost of that gap is small by construction (the consumer opens a file with the key before it stores it, see "Für das Review"),
 *  but the gap is real. And the check symbol is NOT a MAC: it only catches typing mistakes. EVERY valid code of a foreign chain or of an older
 *  stand passes it, because it is a correct code; whether the key opens anything is known only by opening a file.
 *
 *  ── Errors are values ───────────────────────────────────────────────────────────────────
 *  Neither function throws. A failure names the reason and, where it helps, a position or a count; it never contains a character of the input, so
 *  a code typed wrongly cannot leak through a log line. The reasons: `length`, `character` (with `at`, the index in the cleaned text), `checksum`,
 *  `version` (with `found`), `chain-length`, `stand-range`, `key-length`.
 *
 *  ── Für das Review ──────────────────────────────────────────────────────────────────────
 *  Threat picture (spec § 11.3): the code IS the key, so whoever sees the code reads the table; the module has to make a typo impossible to
 *  mistake for another key and must not put the code anywhere (log, error text). The pseudonymizer's real protection is that nothing in the
 *  table file lets one try codes.
 *  Decisions: (1) chain id 4 bytes and stand 3 bytes so that the total is a whole number of Base32 symbols; 4 bytes of chain id only tell a code
 *  of one chain from another (a wrong-chain message instead of "cannot open"), they are no secret and no integrity protection. 3 bytes of stand
 *  allow 16.7 million forgets, the ratchet jump is limited to about 1000. (2) Check symbol mod 37 and not a CRC: it is the one Crockford names,
 *  it guarantees the two error classes above instead of "most", and it needs no table. (3) `I`, `L`, `O` are accepted as `1`, `1`, `0`; fullwidth
 *  and typographic dashes (U+2010 to U+2015, U+2212) and no-break spaces (U+00A0, U+202F) are skipped like a hyphen, because a code comes out of a
 *  password manager or a PDF. Only ASCII letters are folded to capitals (no locale-sensitive `toUpperCase`: `ı` would become `I`). (4) The
 *  order of the checks is length, character, checksum, version: the version byte is not trusted before the checksum holds.
 *  (5) What the consumer must do (spec § 8.3 "Erst öffnen, dann festschreiben"): a decoded key is written to the key store only AFTER a file
 *  of the table has been opened with it (`web/key-envelope` `openEnvelope`). A valid code of a foreign chain or an older stand decodes with
 *  `ok: true`; only the open tells it apart. This is the reference that "the consumer opens a file with the key before it stores it" points to.
 *  Not examined: the quality of the randomness of whoever supplies the key (the caller), the leak of the code through the clipboard or the screen,
 *  two simultaneous mistakes (1 in 37), and whether a human reads Base32 groups of 5 from paper reliably (no usability test). */

export const RECOVERY_CODE_VERSION = 1;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CHECK_ALPHABET = `${ALPHABET}*~$=U`;
const CHAIN_BYTES = 4;
const STAND_BYTES = 3;
const KEY_BYTES = 32;
const PAYLOAD_BYTES = 1 + CHAIN_BYTES + STAND_BYTES + KEY_BYTES;
const SYMBOLS = (PAYLOAD_BYTES * 8) / 5;
const GROUP = 5;

/** Largest key stand a code can carry. */
export const RECOVERY_CODE_MAX_STAND = 2 ** (8 * STAND_BYTES) - 1;
/** Length of the cleaned code: 64 data symbols and the check symbol. */
export const RECOVERY_CODE_LENGTH = SYMBOLS + 1;

export interface RecoveryCodeContent {
  /** 4 bytes that name the key chain (a new chain starts with "replace key"); not secret. */
  chainId: Uint8Array;
  /** Key stand, an integer from 0 to {@link RECOVERY_CODE_MAX_STAND}. */
  stand: number;
  /** The 32-byte key of that stand. */
  key: Uint8Array;
}

export type RecoveryCodeEncodeResult =
  | { ok: true; code: string }
  | { ok: false; reason: "chain-length" | "stand-range" | "key-length" };

export type RecoveryCodeDecodeResult =
  | { ok: true; version: number; chainId: Uint8Array; stand: number; key: Uint8Array }
  | { ok: false; reason: "length"; got: number; expected: number }
  | { ok: false; reason: "character"; at: number }
  | { ok: false; reason: "checksum" }
  | { ok: false; reason: "version"; found: number };

/** Remainder of the number written by the data symbols, modulo 37, folded symbol by symbol. */
function remainder(values: readonly number[]): number {
  let r = 0;
  for (const v of values) r = (r * 32 + v) % 37;
  return r;
}

/** The code for a chain id, a stand and a key; shown as groups of five. */
export function encodeRecoveryCode(content: RecoveryCodeContent): RecoveryCodeEncodeResult {
  if (content.chainId.length !== CHAIN_BYTES) return { ok: false, reason: "chain-length" };
  if (!Number.isInteger(content.stand) || content.stand < 0 || content.stand > RECOVERY_CODE_MAX_STAND) return { ok: false, reason: "stand-range" };
  if (content.key.length !== KEY_BYTES) return { ok: false, reason: "key-length" };

  const bytes = new Uint8Array(PAYLOAD_BYTES);
  bytes[0] = RECOVERY_CODE_VERSION;
  bytes.set(content.chainId, 1);
  bytes[1 + CHAIN_BYTES] = Math.floor(content.stand / 65536) & 0xff;
  bytes[2 + CHAIN_BYTES] = Math.floor(content.stand / 256) & 0xff;
  bytes[3 + CHAIN_BYTES] = content.stand & 0xff;
  bytes.set(content.key, 1 + CHAIN_BYTES + STAND_BYTES);

  // 5 bytes are 8 symbols; 40 bytes are 64 symbols with no bit left over.
  const values: number[] = [];
  for (let i = 0; i < PAYLOAD_BYTES; i += 5) {
    const b0 = bytes[i] ?? 0, b1 = bytes[i + 1] ?? 0, b2 = bytes[i + 2] ?? 0, b3 = bytes[i + 3] ?? 0, b4 = bytes[i + 4] ?? 0;
    values.push(
      b0 >> 3,
      ((b0 & 7) << 2) | (b1 >> 6),
      (b1 >> 1) & 31,
      ((b1 & 1) << 4) | (b2 >> 4),
      ((b2 & 15) << 1) | (b3 >> 7),
      (b3 >> 2) & 31,
      ((b3 & 3) << 3) | (b4 >> 5),
      b4 & 31,
    );
  }
  let text = values.map((v) => ALPHABET.charAt(v)).join("") + CHECK_ALPHABET.charAt(remainder(values));
  const groups: string[] = [];
  for (let i = 0; i < text.length; i += GROUP) groups.push(text.slice(i, i + GROUP));
  text = groups.join("-");
  return { ok: true, code: text };
}

/** Characters a code may be copied with that carry no value: whitespace, hyphen and its typographic look-alikes, no-break spaces. */
function skipped(c: number): boolean {
  return c === 0x2d || c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x202f || (c >= 0x2010 && c <= 0x2015) || c === 0x2212;
}

/** Reads a code typed or pasted by a person; case, hyphens and blanks do not matter. A failure never contains a character of the input. */
export function decodeRecoveryCode(input: string): RecoveryCodeDecodeResult {
  const clean: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (skipped(c)) continue;
    // ASCII letters only: no locale-sensitive case folding.
    const up = c >= 97 && c <= 122 ? c - 32 : c;
    // Crockford: O is 0, I and L are 1.
    clean.push(up === 0x4f ? "0" : up === 0x49 || up === 0x4c ? "1" : String.fromCharCode(up));
  }
  if (clean.length !== RECOVERY_CODE_LENGTH) return { ok: false, reason: "length", got: clean.length, expected: RECOVERY_CODE_LENGTH };

  const values: number[] = [];
  for (let i = 0; i < SYMBOLS; i++) {
    const v = ALPHABET.indexOf(clean[i] ?? "");
    if (v < 0) return { ok: false, reason: "character", at: i };
    values.push(v);
  }
  const check = CHECK_ALPHABET.indexOf(clean[SYMBOLS] ?? "");
  if (check < 0) return { ok: false, reason: "character", at: SYMBOLS };
  if (check !== remainder(values)) return { ok: false, reason: "checksum" };

  const bytes = new Uint8Array(PAYLOAD_BYTES);
  for (let i = 0, o = 0; i < SYMBOLS; i += 8, o += 5) {
    const v = (k: number): number => values[i + k] ?? 0;
    bytes[o] = (v(0) << 3) | (v(1) >> 2);
    bytes[o + 1] = ((v(1) & 3) << 6) | (v(2) << 1) | (v(3) >> 4);
    bytes[o + 2] = ((v(3) & 15) << 4) | (v(4) >> 1);
    bytes[o + 3] = ((v(4) & 1) << 7) | (v(5) << 2) | (v(6) >> 3);
    bytes[o + 4] = ((v(6) & 7) << 5) | v(7);
  }
  const version = bytes[0] ?? 0;
  if (version !== RECOVERY_CODE_VERSION) return { ok: false, reason: "version", found: version };
  const standAt = 1 + CHAIN_BYTES;
  return {
    ok: true,
    version,
    chainId: bytes.slice(1, standAt),
    stand: (bytes[standAt] ?? 0) * 65536 + (bytes[standAt + 1] ?? 0) * 256 + (bytes[standAt + 2] ?? 0),
    key: bytes.slice(standAt + STAND_BYTES),
  };
}
