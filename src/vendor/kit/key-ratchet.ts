// vendored from code-kit@0.91.1, src/ts/web/key-ratchet.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
/** Key ratchet: from the chain key of stand n to the chain key of stand n+1 and the encryption key of stand n, both by HKDF-SHA-256 over WebCrypto.
 *
 *  ABGENOMMEN 2026-11-19 — Opus-Review in zwei Runden (Runde 1 gegen 446a089: 0 blockierend, 0 wichtig, 6 klein, behoben in 53fd995; Runde 2 gegen 53fd995: abgenommen) mit Messung in Chromium 142 (Obsidian 1.15.1) und Node: Vektoren aus RFC 5869 und NIST CAVP, Bitkipp-Versuche, 10 000 Siegel ohne doppelten Nonce. Berichte: review-krypto-runde1.md und review-krypto-runde2.md im Planungs-Cache der Welle 36 (Kit-Linie). Nicht gemessen: WebKit/iOS (kommt mit der iPhone-Messung des Pseudonymizers).
 *
 *  Origin: order 4 of the pseudonymizer design (spec `25_Coding/pseudonymizer/_SDD/2026-11-18-pseudonymizer-design.md` § 7.3 row 2, § 8.2, § 8.3):
 *  "forget a person" turns the key forward, so an old copy of the table cannot be read with the new key. The envelope that uses the encryption
 *  key is `web/key-envelope`; the text form of a chain key for paper is `pure/recovery-code`.
 *
 *  ── Axis: `web`, not `pure` ─────────────────────────────────────────────────────────────
 *  `crypto.subtle` and `crypto.getRandomValues` are host objects (Chromium, WebKit, Node 20 and later). Nothing else is used: no
 *  `node:crypto`, no primitive of our own, no hash of our own. The two named procedures: HKDF with SHA-256 (RFC 5869) and, in the envelope,
 *  AES-256-GCM (NIST SP 800-38D).
 *
 *  ── The contract ────────────────────────────────────────────────────────────────────────
 *  - One chain: `chainId` (4 bytes, never changes along the chain), `stand` (0 to 2^24 - 1) and `chainKey` (32 bytes).
 *  - `advance` gives stand n+1 from n. `advanceTo` gives any later stand, at most {@link RATCHET_MAX_JUMP} steps ahead. There is NO function that
 *    goes back, and nothing in the module could: the chain key of n+1 is the output of a one-way function of the chain key of n.
 *  - The chain key and the encryption key of one stand are derived with DIFFERENT `info` strings, so knowing the encryption key (a non-extractable
 *    `CryptoKey`, it never leaves WebCrypto as bytes) says nothing about the chain key, and the chain key of n+1 says nothing about the
 *    encryption key of n.
 *  - Nothing here mutates an argument. `wipe` is the one function that does, on purpose, for a state the caller is done with.
 *  - Errors are values: `reason` only, never key material, never the text of a platform exception. A platform failure is `platform`.
 *
 *  ── Für das Review ──────────────────────────────────────────────────────────────────────
 *  Threat picture (spec § 11.3): someone holds an OLD copy of the table and later gets hold of the CURRENT key, or reads the table without any
 *  key. The ratchet protects the first case (the current key does not open the old copy, because forgetting turned the key), not the reverse:
 *  whoever has an old chain key computes every later one (spec § 8.3 "Entfernen entzieht keinen Zugriff", the answer there is "replace key",
 *  a new random chain).
 *  Decisions: (1) HKDF `info` is `code-kit/key-ratchet/v1/next-chain` for the chain and `code-kit/key-ratchet/v1/encryption` for the encryption key;
 *  the salt is empty (RFC 5869: HashLen zero bytes), because the input is already a uniformly random 32-byte key (RFC 5869 § 3.1: the salt is optional
 *  then). (2) NO per-device sub-key: every device derives the same encryption key for a stand, and the header of the envelope names the device.
 *  Reason: a sub-key would only widen the nonce space per key, and the nonce space is not the limit here (random 96-bit nonces under one key
 *  are safe up to 2^32 encryptions, NIST SP 800-38D § 8.3; this table is written a few hundred times per stand); what a sub-key would add is one
 *  more derivation per file and an unclear answer to "which device id goes into `info`" for a header that is untrusted until opened. The
 *  price: two devices share one encryption key per stand and nothing in the cryptography separates their files; the device id in the header is
 *  authenticated, but a device that holds the key can write a file that claims another device id. Spec § 8.3 accepts that (the shared key is
 *  the model). (3) The jump limit is 1000 (spec: "Größenordnung tausend"): a file with a forged high stand costs at most 1000 HKDF derivations
 *  (measured about 0.035 ms each in Node 24 and 0.009 ms in Chromium 142 / Electron 39, so 1000 steps take under 40 ms) before the envelope
 *  refuses to open it; without a limit a header with stand 16 777 215 would cost 16 million derivations. (4) The stand is 24 bits wide because
 *  `pure/recovery-code` carries 3 bytes of it. (5) Memory hygiene, as far as this module can go: the module's OWN copies of a chain key (the
 *  ones it makes for `importKey` in `hkdfSha256` and `encryptionKey`) are zeroed right after `importKey` has taken the bytes, and `advanceTo`
 *  zeroes every intermediate state; `wipe` zeroes the state the caller hands in. That is all JavaScript lets a module promise: the engine may
 *  have copied the bytes elsewhere (garbage collector, JIT, the structured clone inside WebCrypto), the `CryptoKey` holds the key material
 *  where no script can reach or wipe it, and the caller's own copies are the caller's to wipe. "Old key no longer in memory" (spec § 11.3) is
 *  therefore a best effort, not a guarantee.
 *  Not examined: timing side channels of the platform HKDF, and whether WebKit on iOS behaves like Chromium (measured in Node 24 and, by the
 *  review, in Chromium 142; WebKit not measured). */

/** Largest number of stands `advanceTo` may go forward in one call. */
export const RATCHET_MAX_JUMP = 1000;
/** Largest stand a chain can reach (24 bits, as carried by the recovery code). */
export const RATCHET_MAX_STAND = 2 ** 24 - 1;

const CHAIN_ID_BYTES = 4;
const CHAIN_KEY_BYTES = 32;
const INFO_NEXT_CHAIN = "code-kit/key-ratchet/v1/next-chain";
const INFO_ENCRYPTION = "code-kit/key-ratchet/v1/encryption";

export interface ChainState {
  /** 4 bytes that name the chain; constant along it. */
  chainId: Uint8Array;
  /** 0 to {@link RATCHET_MAX_STAND}. */
  stand: number;
  /** 32 bytes; the secret of this stand. */
  chainKey: Uint8Array;
}

export type RatchetResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "chain-id-length" | "chain-key-length" | "stand-range" | "backwards" | "jump-too-large" | "platform" };

function valid(state: ChainState): RatchetResult<never> | null {
  if (state.chainId.length !== CHAIN_ID_BYTES) return { ok: false, reason: "chain-id-length" };
  if (state.chainKey.length !== CHAIN_KEY_BYTES) return { ok: false, reason: "chain-key-length" };
  if (!Number.isInteger(state.stand) || state.stand < 0 || state.stand > RATCHET_MAX_STAND) return { ok: false, reason: "stand-range" };
  return null;
}

/** A fresh chain at stand 0: a random chain id and a random key, both from `crypto.getRandomValues`. */
export function newChain(): RatchetResult<ChainState> {
  try {
    const chainId = new Uint8Array(CHAIN_ID_BYTES);
    const chainKey = new Uint8Array(CHAIN_KEY_BYTES);
    crypto.getRandomValues(chainId);
    crypto.getRandomValues(chainKey);
    return { ok: true, value: { chainId, stand: 0, chainKey } };
  } catch {
    return { ok: false, reason: "platform" };
  }
}

/** Imports `secret` as a non-extractable HKDF base key from a copy of its own and zeroes that copy as soon as `importKey` has taken its bytes (also when it throws). */
async function importAndWipe(secret: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  const copy = Uint8Array.from(secret);
  try {
    return await crypto.subtle.importKey("raw", copy, "HKDF", false, usages);
  } finally {
    copy.fill(0);
  }
}

/** HKDF-SHA-256 (RFC 5869) extract and expand: `length` bytes from `ikm`, `salt` and `info`. An empty salt means HashLen zero bytes, as in the RFC. */
export async function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<RatchetResult<Uint8Array>> {
  try {
    // `Uint8Array` is not always a `BufferSource` for the type checker (ArrayBufferLike); the copies also keep a caller's view out of WebCrypto.
    const base = await importAndWipe(ikm, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: Uint8Array.from(salt), info: Uint8Array.from(info) }, base, length * 8);
    return { ok: true, value: new Uint8Array(bits) };
  } catch {
    return { ok: false, reason: "platform" };
  }
}

const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

/** Stand n + 1: same chain id, the next chain key. The argument is not changed. */
export async function advance(state: ChainState): Promise<RatchetResult<ChainState>> {
  const bad = valid(state);
  if (bad) return bad;
  if (state.stand >= RATCHET_MAX_STAND) return { ok: false, reason: "stand-range" };
  const next = await hkdfSha256(state.chainKey, new Uint8Array(0), utf8(INFO_NEXT_CHAIN), CHAIN_KEY_BYTES);
  if (!next.ok) return next;
  return { ok: true, value: { chainId: Uint8Array.from(state.chainId), stand: state.stand + 1, chainKey: next.value } };
}

/** A later stand of the same chain, at most {@link RATCHET_MAX_JUMP} ahead. The same stand gives a copy; an earlier one is `backwards` (there is no way back). */
export async function advanceTo(state: ChainState, target: number): Promise<RatchetResult<ChainState>> {
  const bad = valid(state);
  if (bad) return bad;
  if (!Number.isInteger(target) || target < 0 || target > RATCHET_MAX_STAND) return { ok: false, reason: "stand-range" };
  if (target < state.stand) return { ok: false, reason: "backwards" };
  if (target - state.stand > RATCHET_MAX_JUMP) return { ok: false, reason: "jump-too-large" };
  let cur: ChainState = { chainId: Uint8Array.from(state.chainId), stand: state.stand, chainKey: Uint8Array.from(state.chainKey) };
  while (cur.stand < target) {
    const step = await advance(cur);
    // The intermediate key is not needed again: zero it before it is dropped.
    wipe(cur);
    if (!step.ok) return step;
    cur = step.value;
  }
  return { ok: true, value: cur };
}

/** The AES-256-GCM key of this stand: non-extractable, usable to encrypt and decrypt only. Derived with its own `info`, apart from the chain key. */
export async function encryptionKey(state: ChainState): Promise<RatchetResult<CryptoKey>> {
  const bad = valid(state);
  if (bad) return bad;
  try {
    const base = await importAndWipe(state.chainKey, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(INFO_ENCRYPTION) },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    return { ok: true, value: key };
  } catch {
    return { ok: false, reason: "platform" };
  }
}

/** Zeroes the chain key of a state the caller is done with (the old stand after the new one is safely stored). Does not reach copies made elsewhere (the caller's own, the engine's, the `CryptoKey`'s); the copies this module makes itself are already zeroed. */
export function wipe(state: ChainState): void {
  state.chainKey.fill(0);
}
