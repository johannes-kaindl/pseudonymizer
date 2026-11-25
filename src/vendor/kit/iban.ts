// vendored from code-kit@0.91.1, src/ts/pure/iban.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
// Origin: new in code-kit (Welle 36, kp2, order 6 of the pseudonymizer design, spec section 8.4). No consumer copy exists: measured 2026-11-18, the
// workspace held no check-digit function (0 hits for luhn / mod 97). `redact.ts` has an IBAN SHAPE (`createPiiRedactor`, label `IBAN`); this module
// answers the question the shape cannot: is the check digit right.
//
// ISO 13616-1 (IBAN structure; check digits "02 to 98", clause on the calculation of the check digits) with ISO 7064 MOD 97-10: an IBAN is `CC kk BBAN`: two letters of country, two check digits, then the national part. Move the first four
// characters to the end, write every letter as its two-digit value (A = 10 … Z = 35), and the resulting number is valid when it leaves remainder 1
// modulo 97. The remainder is carried character by character (no BigInt, no regular expression: the walk is linear and a long input is refused after
// 34 characters), so an arbitrarily long string cannot cost more than reading it.
//
// What is checked: the country is in the table below, the length is the one the registry gives for that country, every character is an ASCII letter
// or digit (check digits: digits), and the remainder is 1 with check digits 02..98. What is NOT checked: the national structure of the BBAN (bank code, account number
// format, national check digits), and whether the account exists. A valid result therefore means "this is not a typo and not an order number
// that merely has the shape", nothing more.
//
// Accepted spelling: upper or lower case, ASCII spaces and no-break spaces anywhere (a printed IBAN comes in groups of four). The result carries
// the compact upper-case form. Nothing throws: a non-string, an empty string, a string that is too long all come back as a failure value.

/** Why an input is not an IBAN: `shape` (not 2 letters + 2 digits + letters/digits, or empty, too long or not a string), `country` (not in
 *  {@link IBAN_LENGTHS}), `length` (wrong length for that country), `checksum` (remainder is not 1). Checked in that order. */
export type IbanFailure = "shape" | "country" | "length" | "checksum";

export type IbanCheck =
  | { valid: true; iban: string; country: string; checkDigits: string; bban: string }
  | { valid: false; reason: IbanFailure };

/** Total length per country, from the SWIFT IBAN registry (countries that issue IBANs, including the ones that only use the format, such as `BR`,
 *  `EG`, `KZ`, `XK`). A country that is missing here is `country`, not `checksum`: adding one is additive. */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26,
  IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18,
  NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24,
  TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

/** The longest IBAN there is (34 characters); a longer input is refused without being read to the end. */
const MAX_LENGTH = 34;

/** `s` without ASCII spaces and no-break spaces, upper-cased, or `null` when more than {@link MAX_LENGTH} characters remain. One pass, stops early. */
function compact(s: string): string | null {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0xa0) continue;
    if (out.length === MAX_LENGTH) return null;
    // ASCII lower case only: `toUpperCase` would turn "ß" into "SS" and "ı" into "I", which are no IBAN characters.
    out += c >= 0x61 && c <= 0x7a ? String.fromCharCode(c - 32) : s.charAt(i);
  }
  return out;
}

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isUpper = (c: number): boolean => c >= 0x41 && c <= 0x5a;

/** Checks `text` as an IBAN. Never throws. */
export function checkIban(text: string): IbanCheck {
  if (typeof text !== "string") return { valid: false, reason: "shape" };
  const iban = compact(text);
  if (iban === null || iban.length < 5) return { valid: false, reason: "shape" };
  for (let i = 0; i < iban.length; i++) {
    const c = iban.charCodeAt(i);
    const ok = i < 2 ? isUpper(c) : i < 4 ? isDigit(c) : isDigit(c) || isUpper(c);
    if (!ok) return { valid: false, reason: "shape" };
  }
  const country = iban.slice(0, 2);
  const want = IBAN_LENGTHS[country]; // keys are two capitals: no prototype property has such a name
  if (want === undefined) return { valid: false, reason: "country" };
  if (iban.length !== want) return { valid: false, reason: "length" };
  // Rearranged: BBAN, country, check digits. The remainder is carried one character at a time; a letter is two digits.
  let rem = 0;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  for (let i = 0; i < rearranged.length; i++) {
    const c = rearranged.charCodeAt(i);
    rem = isDigit(c) ? (rem * 10 + (c - 0x30)) % 97 : (rem * 100 + (c - 0x41 + 10)) % 97;
  }
  // The standard issues check digits 02..98 only (98 - remainder, remainder 0..96). 00, 01 and 99 are congruent to 97, 98 and 02 modulo 97, so the
  // remainder alone would accept them; they are refused here.
  const cd = Number(iban.slice(2, 4));
  if (rem !== 1 || cd < 2 || cd > 98) return { valid: false, reason: "checksum" };
  return { valid: true, iban, country, checkDigits: iban.slice(2, 4), bban: iban.slice(4) };
}

/** `checkIban(text).valid`. */
export function isValidIban(text: string): boolean {
  return checkIban(text).valid;
}
