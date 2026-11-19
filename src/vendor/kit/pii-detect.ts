// vendored from code-kit@0.86.1, src/ts/pure/pii-detect.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
// Origin: new in code-kit (Welle 36, kp2d, order 9 of the pseudonymizer design, spec sections 7.3 row 7 and 8.4). Nothing like it existed: measured 2026-11-19,
// `naehte_suche.py anrede gruss signatur postadresse` found 0 hits in the libraries and the plugins. The shapes for e-mail, IBAN and phone are those of
// `redact.ts` (`PII_PATTERNS`, shared by an additive export, not copied); the IBAN is read through `checkIban` (check digits, so an order number in IBAN
// form is not reported), the phone number through `normalizePhone` (fewer than six digits is not a number). `applyEdits` of `placeholder.ts` resolves overlaps.
//
// WHAT A DETECTOR IS. A function `(text) => Finding[]`. It DECIDES nothing, it only reports: where (`start`/`end` into the text it was given), what kind
// (`person`, `email`, `phone`, `iban`, `address`), by which rule, and how sure (`high`, `medium`, `low`). The list {@link DEFAULT_DETECTORS} is open: the model
// stage of the design appends a detector with the same signature and nothing else changes. {@link detectPersonalData} runs a list and resolves the overlaps.
//
// WHAT A FINDING COVERS. The thing to replace and nothing around it: in "Frau Dr. Schmidt" the name "Schmidt", not the title; in "Hallo Max," the "Max", not the
// comma. So `Frau Person_x` and `Hallo Person_x,` stay readable. A name is one to four capitalised words with the particles `von`, `van`, `de`, … between them
// ("Ludwig van Beethoven", "Müller-Lüdenscheidt", "O'Brien", the "Nachname, Vorname" form in headers); the second letter must be a lowercase letter, so
// "AM", "PM" and "IBM" are not names, and a closed list of words that are capitalised without being names ("Team", "Grüße", "Sie", "Sir", …) is {@link NOT_A_NAME}.
//
// THE RULES (spec 8.4), where each one reads:
//  - `email`, `phone`, `iban`: anywhere in the text (the patterns of `redact.ts`; phone and IBAN checked as above).
//  - `salutation`: a title ("Herr", "Frau", "Dr.", "Prof.", "Mr", "Mrs", "Ms", …) and the name behind it, anywhere in a line.
//  - `greeting`: a line that starts with "Hallo", "Hi", "Liebe", "Sehr geehrte", "Dear", … (title allowed): the name, or "A und B".
//  - `closing`: a line that is a closing formula ("Viele Grüße", "Mit freundlichen Grüßen", "Best regards", …), the name behind it on that line, or the name line
//    after it (one blank line may sit between).
//  - `signature`: the lines after a closing formula (up to 12, to the next blank line) or after the line `-- `: phone numbers, e-mail addresses, IBANs, postal
//    addresses, and behind `-- ` the first line when it is a name.
//  - `header`: "Von:", "From:", "Am … schrieb Name <adresse>:", "On … Name <adresse> wrote:", "Name <adresse> schrieb am …:": the name next to the address.
//  - `postal-address`: a street with house number ("Musterstraße 12", "Berliner Allee 3a"), a postal code with place ("12345 Musterstadt"), joined when they stand
//    on one line; low certainty, by the spec.
//
// Quoted lines ("> ", "> > ") are read like the lines of the text itself: a reply quotes the very data that matters.
//
// NAMED LIMITS (measured by the fixture list in `tests/pii-detect.test.ts`, not hidden): a third party in the middle of a sentence without a title ("die Kollegin
// Schmidt") is not reported (the gap the spec names until the model stage); initials ("J. R. Tolkien") are not names; "An:", "To:", "Cc:" lines are not headers;
// a street without a compound ending ("Am Markt 5") is not an address; a title the list does not know ("Dipl.-Ing.") ends the salutation; the salutation takes at
// most three words, so a noun behind a name ("Herr Müller Verwaltung") is read as part of it. Every one of these is a candidate the user can still mark by hand.
//
// LINEARITY. Line-bound rules run per line and read each line once with anchored (sticky) expressions of bounded repetition; the whole-text patterns come from
// `redact.ts` (lead group instead of a lookbehind, iOS Safari before 16.4) or start only at a word boundary they check themselves. `tests/pii-detect.test.ts`
// counts the string work (not the clock) over the shapes that reach the expensive path, and a mutant that makes an expression quadratic turns it red.
// Nothing throws on any input; a non-string gives no findings.

import { checkIban, IBAN_LENGTHS } from "./iban";
import { normalizePhone } from "./phone";
import { applyEdits, type Edit } from "./placeholder";
import { PII_PATTERNS } from "./redact";

// ---- types ----------------------------------------------------------------------------------

/** What was found. `person` is a name (of a person); organisations are not recognised in version 1. */
export type FindingKind = "person" | "email" | "phone" | "iban" | "address";

/** Which rule found it. */
export type FindingRule = "email" | "phone" | "iban" | "salutation" | "greeting" | "closing" | "signature" | "header" | "postal-address";

/** How sure the rule is. When findings overlap and are equally long, the surer one wins. */
export type FindingConfidence = "high" | "medium" | "low";

/** One place in the text. `text.slice(start, end) === text` of the finding; offsets are UTF-16 code units of the text the detector was given. */
export interface Finding {
  start: number;
  end: number;
  text: string;
  kind: FindingKind;
  rule: FindingRule;
  confidence: FindingConfidence;
}

/** A detector: reports, never replaces. Same signature for every rule, so a model detector can be appended. */
export type Detector = (text: string) => Finding[];

/** `high` 2, `medium` 1, `low` 0 — the priority handed to the overlap resolution. */
export const CONFIDENCE_RANK: Readonly<Record<FindingConfidence, number>> = { high: 2, medium: 1, low: 0 };

// ---- character classes -----------------------------------------------------------------------

const SP = "[ \\u00a0]";
const LETTER = "A-Za-zÀ-ÖØ-öø-ÿĀ-ſ";
const UP = "A-ZÀ-ÖØ-ÞĀ-ſ";
const LO = "a-zß-öø-ÿ'’";
const TAIL = `${LETTER}'’-`;

const isSpace = (ch: string | undefined): boolean => ch === " " || ch === "\u00a0";

/** Capitalised words that are not names. A closed list: a word that is missing is read as a name and shows up as a candidate the user can turn down. */
export const NOT_A_NAME: ReadonlySet<string> = new Set([
  // greetings addressed to a group, closings, thanks
  "Team", "Zusammen", "Allerseits", "Leute", "Freunde", "Kollegen", "Kolleginnen", "Kunden", "Kundin", "Damen", "Herren", "Alle", "Mitglieder", "Gäste",
  "Grüße", "Grüßen", "Gruß", "Grüsse", "Grüssen", "Dank", "Danke", "Vielen", "Besten", "Beste", "Liebe", "Viele", "Herzliche", "Freundliche", "Mit",
  "Sir", "Madam", "Everyone", "All", "Folks", "Guys", "There", "World", "Welt", "Customer", "Colleagues", "Friends", "Support", "Service", "Thanks", "Thank",
  "Best", "Kind", "Warm", "Many", "Yours", "Sincerely", "Regards", "Cheers", "Wishes",
  // words that start a sentence behind a name ("Frau Müller Sie haben …")
  "Sie", "Ich", "Wir", "Er", "Es", "Ihr", "Du", "Das", "Die", "Der", "Den", "Dem", "Und", "Oder", "Ist", "Hat", "Wie", "Was", "Wer", "Wenn", "Bitte", "Aber",
  "Von", "Nach", "Bei", "Für", "Auf", "Im", "In", "Am", "An", "Zu", "Zum", "Zur", "Vor", "Mit", "Als", "Auch", "Noch", "Nur", "Dann", "Dass", "Weil",
  "The", "And", "Is", "Has", "Will", "Can", "Please", "You", "Your", "We", "He", "She", "It", "They", "This", "That", "If", "But", "For", "Of", "On", "At", "To",
]);

const PARTICLE_LEAD = "(?:von|van|vom|de|del|della|di|dos|ten|ter)";
const PARTICLE_INNER = "(?:von|van|vom|de|zu|da|di|del|della|dos|ten|ter)";
const NT_SRC = `[${UP}][${LO}][${TAIL}]*`;
const TITLE_SRC = "(?:Herrn?|Frau|Fräulein|Hr\\.|Fr\\.|Dr\\.?|Prof\\.?|Mr\\.?|Mrs\\.?|Ms\\.?|Miss|Mx\\.?)";

// Sticky expressions are module-level and always get `lastIndex` set before use (`matchAt`); nothing here is reentrant across calls.
const NT_Y = new RegExp(NT_SRC, "y");
const SPACES_Y = new RegExp(`${SP}+`, "y");
const PART_LEAD_Y = new RegExp(`${PARTICLE_LEAD}${SP}+`, "y");
const PART_INNER_Y = new RegExp(`${PARTICLE_INNER}${SP}+`, "y");
const COMMA_Y = new RegExp(`,${SP}+`, "y");

/** Length of a match of the sticky `re` at `i`, or -1. */
function matchAt(re: RegExp, s: string, i: number): number {
  re.lastIndex = i;
  const m = re.exec(s);
  return m ? m[0].length : -1;
}

interface Span {
  start: number;
  end: number;
}

/** One name word at `i`: its length without trailing hyphens and apostrophes, or -1 (no name word, or one from {@link NOT_A_NAME}). */
function nameWordAt(s: string, i: number): number {
  let len = matchAt(NT_Y, s, i);
  if (len <= 0) return -1;
  while (len > 0 && "-'’".includes(s.charAt(i + len - 1))) len--;
  if (len < 2) return -1;
  return NOT_A_NAME.has(s.slice(i, i + len)) ? -1 : len;
}

/** The name at `pos`: up to `maxTokens` words, particles inside (a leading particle is skipped and not part of the span). With `comma`, one "Nachname, Vorname"
 *  comma after the first word is a separator. `null` when no name word stands there. */
function scanName(s: string, pos: number, maxTokens: number, comma = false): Span | null {
  let p = pos;
  for (let k = 0; k < 2; k++) {
    const pl = matchAt(PART_LEAD_Y, s, p);
    if (pl <= 0) break;
    p += pl;
  }
  const first = nameWordAt(s, p);
  if (first < 0) return null;
  const start = p;
  let end = p + first;
  let tokens = 1;
  while (tokens < maxTokens) {
    let q = end;
    let sep = matchAt(SPACES_Y, s, q);
    if (sep <= 0 && comma && tokens === 1) sep = matchAt(COMMA_Y, s, q);
    if (sep <= 0) break;
    q += sep;
    for (let k = 0; k < 2; k++) {
      const pl = matchAt(PART_INNER_Y, s, q);
      if (pl <= 0) break;
      q += pl;
    }
    const tl = nameWordAt(s, q);
    if (tl < 0) break;
    end = q + tl;
    tokens++;
  }
  return { start, end };
}

// ---- lines ---------------------------------------------------------------------------------

interface Line {
  /** The line without the quote marks and indentation in front and the blanks behind. */
  content: string;
  /** Offset of `content` in the whole text. */
  base: number;
}

/** The lines of `text` with their content offsets. `\r\n` is a line end; a leading run of blanks, tabs and `>` is skipped (a quoted line is read like any other). */
function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let pos = 0;
  for (;;) {
    let nl = text.indexOf("\n", pos);
    if (nl < 0) nl = text.length;
    let rawEnd = nl;
    if (rawEnd > pos && text.charCodeAt(rawEnd - 1) === 13) rawEnd--;
    let off = pos;
    for (;;) {
      const ch = text.charAt(off);
      if (off < rawEnd && (ch === " " || ch === "\t" || ch === "\u00a0" || ch === ">")) off++;
      else break;
    }
    let end = rawEnd;
    for (;;) {
      const ch = text.charAt(end - 1);
      if (end > off && (ch === " " || ch === "\t" || ch === "\u00a0")) end--;
      else break;
    }
    out.push({ content: text.slice(off, end), base: off });
    if (nl >= text.length) break;
    pos = nl + 1;
  }
  return out;
}

// ---- building findings -------------------------------------------------------------------------

function make(text: string, start: number, end: number, kind: FindingKind, rule: FindingRule, confidence: FindingConfidence): Finding {
  return { start, end, text: text.slice(start, end), kind, rule, confidence };
}

/** The hits of a pattern with a lead group (group 1 the character in front, group 2 the hit), as offsets in `s`. The pattern is copied: a global one carries `lastIndex`. */
function leadHits(re: RegExp, s: string): Span[] {
  const copy = new RegExp(re.source, re.flags);
  const out: Span[] = [];
  for (let m = copy.exec(s); m !== null; m = copy.exec(s)) {
    const start = m.index + (m[1] ?? "").length;
    out.push({ start, end: start + (m[2] ?? "").length });
  }
  return out;
}

function patternOf(label: "EMAIL" | "IBAN" | "PHONE"): RegExp {
  for (const [name, re] of PII_PATTERNS) if (name === label) return re;
  throw new Error(`pii-detect: redact.ts no longer has the ${label} pattern`);
}

const EMAIL_RE = patternOf("EMAIL");
const IBAN_RE = patternOf("IBAN");
const PHONE_RE = patternOf("PHONE");

const ALNUM_RE = new RegExp(`[0-9${LETTER}_]`);
const alnum = (ch: string): boolean => ch !== "" && ALNUM_RE.test(ch);

function emailHits(s: string): Span[] {
  return leadHits(EMAIL_RE, s);
}

/** An IBAN written in groups can run into the next word ("DE89 3704 0044 0532 0130 00 und"): the pattern's hit is cut to the length the country gives, and read only
 *  when the check digits are right. */
function ibanHits(s: string): Span[] {
  const out: Span[] = [];
  for (const hit of leadHits(IBAN_RE, s)) {
    const raw = s.slice(hit.start, hit.end);
    const want = IBAN_LENGTHS[raw.slice(0, 2).toUpperCase()];
    if (want === undefined) continue;
    let count = 0;
    let end = -1;
    for (let i = 0; i < raw.length; i++) {
      if (!isSpace(raw.charAt(i))) count++;
      if (count === want) {
        end = i + 1;
        break;
      }
    }
    if (end < 0) continue;
    if (checkIban(raw.slice(0, end)).valid) out.push({ start: hit.start, end: hit.start + end });
  }
  return out;
}

/** A phone hit the normalisation accepts and that does not sit inside a longer word or number ("ID1234567", "1234567abc"). */
function phoneHits(s: string): { span: Span; sure: boolean }[] {
  const out: { span: Span; sure: boolean }[] = [];
  const copy = new RegExp(PHONE_RE.source, PHONE_RE.flags);
  for (let m = copy.exec(s); m !== null; m = copy.exec(s)) {
    const hit = m[0];
    const start = m.index;
    const end = start + hit.length;
    if (alnum(s.charAt(start - 1)) || alnum(s.charAt(end))) continue;
    // redundant with the current pattern (it needs seven digits, the normalisation six); kept so a shorter pattern cannot report a short run as a number
    if (normalizePhone(hit) === null) continue;
    out.push({ span: { start, end }, sure: hit.startsWith("+") || hit.startsWith("0") || /[ /()-]/.test(hit) });
  }
  return out;
}

// ---- the patterns: e-mail, phone, IBAN ----------------------------------------------------------

/** `email`: the EMAIL shape of `redact.ts`. Certainty high. */
export const detectEmail: Detector = (text) => {
  if (typeof text !== "string") return [];
  return emailHits(text).map((h) => make(text, h.start, h.end, "email", "email", "high"));
};

/** `iban`: the IBAN shape of `redact.ts`, cut to the length of the country and kept only when the check digits are right. Certainty high. */
export const detectIban: Detector = (text) => {
  if (typeof text !== "string") return [];
  return ibanHits(text).map((h) => make(text, h.start, h.end, "iban", "iban", "high"));
};

/** `phone`: the PHONE shape of `redact.ts`, kept when `normalizePhone` accepts it and it is not inside a longer word or number. Medium certainty with a `+`, a leading `0` or
 *  a separator; low for a bare run of digits. */
export const detectPhone: Detector = (text) => {
  if (typeof text !== "string") return [];
  return phoneHits(text).map((h) => make(text, h.span.start, h.span.end, "phone", "phone", h.sure ? "medium" : "low"));
};

// ---- salutation ---------------------------------------------------------------------------------

/** A name is at most three words; 160 characters hold the longest there are. */
const NAME_WINDOW = 160;
const SALUTATION_RE = new RegExp(`(^|[^${LETTER}])((?:${TITLE_SRC}${SP}+){1,4})`, "g");

/** `salutation`: a title and the name behind it ("Herr Müller", "Frau Dr. Schmidt", "Mr Smith"), up to three words. Medium certainty. */
export const detectSalutation: Detector = (text) => {
  if (typeof text !== "string") return [];
  const out: Finding[] = [];
  const re = new RegExp(SALUTATION_RE.source, SALUTATION_RE.flags);
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const nameFrom = m.index + (m[1] ?? "").length + (m[2] ?? "").length;
    // the name is read in a window: the whole-text scan stays with the one expression above, and the sticky reads cost what the name costs
    const span = scanName(text.slice(nameFrom, nameFrom + NAME_WINDOW), 0, 3);
    if (span) out.push(make(text, nameFrom + span.start, nameFrom + span.end, "person", "salutation", "medium"));
  }
  return out;
};

// ---- greeting -----------------------------------------------------------------------------------

const GREETING_Y = new RegExp(
  `(?:Sehr geehrte[rs]?|Guten (?:Morgen|Tag|Abend)|Hallo|Hi|Hey|Hej|Servus|Moin|Lieber|Liebe|Liebes|Dear|Hello|Good (?:morning|afternoon|evening))${SP}+`,
  "y",
);
const TITLES_Y = new RegExp(`(?:${TITLE_SRC}${SP}+){0,4}`, "y");
const JOIN_Y = new RegExp(`${SP}+(?:und|and|&)${SP}+`, "y");
const TERMINATOR_Y = new RegExp(`${SP}*(?:[,!:;.?]|$)`, "y");

/** `greeting`: a line that starts with a greeting word and has a name behind it. "Hallo Max," → "Max"; "Sehr geehrte Frau Mustermann," → "Mustermann"; "Hi Anna und Bob" → both.
 *  Certainty high when the name ends at a comma, a stop, a colon, an exclamation mark or the end of the line; medium (the first name only) when a word follows. */
export const detectGreeting: Detector = (text) => {
  if (typeof text !== "string") return [];
  const out: Finding[] = [];
  for (const line of splitLines(text)) {
    const c = line.content;
    const g = matchAt(GREETING_Y, c, 0);
    if (g <= 0) continue;
    const titles = matchAt(TITLES_Y, c, g);
    const first = scanName(c, g + Math.max(titles, 0), 4);
    if (!first) continue;
    const spans = [first];
    let p = first.end;
    for (let k = 0; k < 3; k++) {
      const j = matchAt(JOIN_Y, c, p);
      if (j <= 0) break;
      const next = scanName(c, p + j, 3);
      if (!next) break;
      spans.push(next);
      p = next.end;
    }
    const closed = matchAt(TERMINATOR_Y, c, p) >= 0;
    const use = closed ? spans : [first];
    for (const s of use) out.push(make(text, line.base + s.start, line.base + s.end, "person", "greeting", closed ? "high" : "medium"));
  }
  return out;
};

// ---- closing and signature ---------------------------------------------------------------------

const CLOSING_STRONG_Y = new RegExp(
  "(?:Mit (?:freundlichen|besten|herzlichen|lieben|kollegialen) Gr(?:üßen|üssen)|Mit (?:freundlichem|herzlichem|kollegialem) Gruß|" +
    "(?:Viele|Beste|Besten|Liebe|Herzliche|Herzlichste|Freundliche|Schöne|Sonnige|Kollegiale|Liebste) Gr(?:üße|üsse)|Grüße|Grüsse|Gruß|Gruss|LG|VG|MfG|" +
    "Best regards|Kind regards|Warm regards|Many regards|Regards|Sincerely(?: yours)?|Yours (?:sincerely|faithfully|truly)|Best wishes)",
  "y",
);
const CLOSING_WEAK_Y = /(?:Best|Thanks|Thank you|Many thanks|Cheers|Danke|Vielen Dank|Besten Dank|Dankeschön)/y;
const AFTER_CLOSING_Y = new RegExp(`${SP}*[,.!]?${SP}*`, "y");
const COMMA_AFTER_Y = new RegExp(`${SP}*[,.!]${SP}*`, "y");

interface Block {
  marker: "closing" | "dashes";
  /** The name written on the closing line itself ("Viele Grüße Max"). */
  inline: Span | null;
  /** Index of the closing or `-- ` line in the array of lines. */
  at: number;
  /** The lines of the block: from the line after the marker (after at most one blank line) to the next blank line, at most {@link BLOCK_LINES}. */
  lines: Line[];
}

const BLOCK_LINES = 12;

function closingAt(c: string): { inline: Span | null } | null {
  const strong = matchAt(CLOSING_STRONG_Y, c, 0);
  const len = strong > 0 ? strong : matchAt(CLOSING_WEAK_Y, c, 0);
  if (len <= 0) return null;
  const rest = (re: RegExp): number => matchAt(re, c, len);
  // the formula alone on its line, with at most one punctuation mark: the name comes on the next line
  const plain = rest(AFTER_CLOSING_Y);
  if (plain >= 0 && len + plain === c.length) return { inline: null };
  // a strong formula takes the name with or without a comma ("Viele Grüße Max", "Viele Grüße, Max"); a weak one ("Best", "Thanks") only behind a comma
  const sep = strong > 0 ? plain : rest(COMMA_AFTER_Y);
  if (sep < 0) return null;
  const name = scanName(c, len + sep, 4);
  if (!name || name.end !== c.length) return null;
  return { inline: name };
}

function isDashes(c: string): boolean {
  return c === "--";
}

/** The closing formulas and `-- ` lines of the text with the lines that follow them. */
function findBlocks(lines: readonly Line[]): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let marker: Block["marker"];
    let inline: Span | null = null;
    if (isDashes(line.content)) marker = "dashes";
    else {
      const closing = closingAt(line.content);
      if (!closing) continue;
      marker = "closing";
      inline = closing.inline;
    }
    let from = i + 1;
    if (marker === "closing" && lines[from]?.content === "") from++;
    const block: Line[] = [];
    let j = from;
    while (j < lines.length && block.length < BLOCK_LINES) {
      const l = lines[j];
      if (!l || l.content === "" || isDashes(l.content)) break; // a `-- ` line opens a block of its own
      block.push(l);
      j++;
    }
    blocks.push({ marker, inline, at: i, lines: block });
    i = Math.max(i, j - 1);
  }
  return blocks;
}

/** The whole content of `line` is one name (one to four words)? */
function nameLine(line: Line): Span | null {
  const span = scanName(line.content, 0, 4);
  return span && span.end === line.content.length ? span : null;
}

/** `closing`: the name behind a closing formula — on the same line ("Viele Grüße Max") or alone on the next line (one blank line may sit between). Medium certainty. */
export const detectClosing: Detector = (text) => {
  if (typeof text !== "string") return [];
  const out: Finding[] = [];
  const lines = splitLines(text);
  for (const b of findBlocks(lines)) {
    if (b.marker !== "closing") continue;
    const own = lines[b.at];
    const line = b.lines[0];
    if (b.inline) {
      if (own) out.push(make(text, own.base + b.inline.start, own.base + b.inline.end, "person", "closing", "medium"));
      continue;
    }
    const span = line ? nameLine(line) : null;
    if (line && span) out.push(make(text, line.base + span.start, line.base + span.end, "person", "closing", "medium"));
  }
  return out;
};

/** The shared parts of the lines of one block, as findings of the rule `signature`. */
function signatureFindings(text: string, lines: readonly Line[]): Finding[] {
  const out: Finding[] = [];
  for (const line of lines) {
    const c = line.content;
    for (const h of phoneHits(c)) out.push(make(text, line.base + h.span.start, line.base + h.span.end, "phone", "signature", "high"));
    for (const h of emailHits(c)) out.push(make(text, line.base + h.start, line.base + h.end, "email", "signature", "high"));
    for (const h of ibanHits(c)) out.push(make(text, line.base + h.start, line.base + h.end, "iban", "signature", "high"));
    for (const h of addressHits(c)) out.push(make(text, line.base + h.start, line.base + h.end, "address", "signature", "medium"));
  }
  return out;
}

/** `signature`: in the lines behind a closing formula or the line `-- `: phone numbers and IBANs and e-mail addresses (high), postal addresses (medium), and behind `-- ` the first
 *  line when it is a name (medium). */
export const detectSignature: Detector = (text) => {
  if (typeof text !== "string") return [];
  const out: Finding[] = [];
  for (const b of findBlocks(splitLines(text))) {
    for (const f of signatureFindings(text, b.lines)) out.push(f);
    const first = b.lines[0];
    if (b.marker === "dashes" && first) {
      const span = nameLine(first);
      if (span) out.push(make(text, first.base + span.start, first.base + span.end, "person", "signature", "medium"));
    }
  }
  return out;
};

// ---- headers in the text -----------------------------------------------------------------------

const FROM_Y = new RegExp(`(?:Von|From)${SP}*:${SP}*`, "y");
const AM_Y = new RegExp(`(?:Am|On)${SP}`, "y");
const ANGLE_RE = /<([^<>\s]+@[^<>\s]+)>/g;
const NAME_TOKEN_FULL = new RegExp(`^${NT_SRC}$`);
const PART_FULL = new RegExp(`^${PARTICLE_INNER}$`);

/** The name that stands directly before `idx` ("Max Mustermann <", "\"Mustermann, Max\" <"): up to four words, particles inside, a quote around it allowed. */
function nameBefore(c: string, idx: number): Span | null {
  let end = idx;
  while (end > 0 && isSpace(c.charAt(end - 1))) end--;
  if ('"“\'»'.includes(c.charAt(end - 1)) && end > 0) end--;
  const words: { start: number; end: number; part: boolean }[] = [];
  let pos = end;
  while (words.length < 6) {
    let wEnd = pos;
    while (wEnd > 0 && isSpace(c.charAt(wEnd - 1))) wEnd--;
    if (wEnd === pos && words.length > 0) break;
    let wStart = wEnd;
    while (wStart > 0 && !isSpace(c.charAt(wStart - 1))) wStart--;
    if (wStart === wEnd) break;
    let s = wStart;
    while (s < wEnd && '"“\'»'.includes(c.charAt(s))) s++;
    let e = wEnd;
    // "Mustermann," is a name word only when another word follows it ("Mustermann, Max")
    if (c.charAt(e - 1) === "," && words.length > 0) e--;
    const word = c.slice(s, e);
    const isName = NAME_TOKEN_FULL.test(word) && !NOT_A_NAME.has(word);
    const isPart = PART_FULL.test(word);
    if (!isName && !isPart) break;
    words.push({ start: s, end: e, part: isPart });
    if (s !== wStart) break; // an opening quote ends the name
    pos = wStart;
  }
  // `words` runs right to left: the rightmost word must be a name word, and a particle at either end is not part of the span; at most four words
  words.length = Math.min(words.length, 4);
  while (words.length > 0 && words[0]?.part) words.shift();
  while (words.length > 0 && words[words.length - 1]?.part) words.pop();
  const right = words[0];
  const left = words[words.length - 1];
  return right && left ? { start: left.start, end: right.end } : null;
}

/** The name that starts at `pos` and is followed by the end of the line, `<`, `[`, `(`, `:` or a closing quote. */
function nameAfter(c: string, pos: number): Span | null {
  let p = pos;
  while (isSpace(c.charAt(p))) p++;
  if ('"“\'»'.includes(c.charAt(p)) && p < c.length) p++;
  const span = scanName(c, p, 4, true);
  if (!span) return null;
  let q = span.end;
  if ('"”\'«'.includes(c.charAt(q)) && q < c.length) q++;
  while (isSpace(c.charAt(q))) q++;
  const next = c.charAt(q);
  return q >= c.length || next === "<" || next === "[" || next === "(" || next === ":" ? span : null;
}

function headerNames(c: string): Span[] {
  const angles: number[] = [];
  const re = new RegExp(ANGLE_RE.source, ANGLE_RE.flags);
  let wroteAfterAngle = false;
  for (let m = re.exec(c); m !== null; m = re.exec(c)) {
    angles.push(m.index);
    let q = m.index + m[0].length;
    while (isSpace(c.charAt(q))) q++;
    if (c.startsWith("schrieb", q) || c.startsWith("wrote", q)) wroteAfterAngle = true;
  }
  const colon = c.endsWith(":");
  const from = matchAt(FROM_Y, c, 0);
  const am = colon && matchAt(AM_Y, c, 0) > 0 && (c.indexOf("schrieb") >= 0 || c.indexOf("wrote") >= 0);
  if (from < 0 && !am && !(colon && wroteAfterAngle)) return [];
  const out: Span[] = [];
  for (const a of angles) {
    const n = nameBefore(c, a);
    if (n) out.push(n);
  }
  if (angles.length > 0) return out;
  if (from >= 0) {
    const n = nameAfter(c, from);
    return n ? [n] : [];
  }
  const sch = c.indexOf("schrieb");
  if (sch >= 0) {
    const n = nameAfter(c, sch + "schrieb".length);
    return n ? [n] : [];
  }
  const wr = c.indexOf("wrote");
  const n = wr >= 0 ? nameBefore(c, wr) : null;
  return n ? [n] : [];
}

/** `header`: "Von:", "From:", "Am … schrieb Name <adresse>:", "On … Name <adresse> wrote:", "Name <adresse> schrieb am …:": the name next to the address (or, without an address, behind
 *  "Von:", "schrieb"; before "wrote"). The address itself is the `email` rule's. Certainty high. */
export const detectHeader: Detector = (text) => {
  if (typeof text !== "string") return [];
  const out: Finding[] = [];
  for (const line of splitLines(text)) {
    for (const s of headerNames(line.content)) out.push(make(text, line.base + s.start, line.base + s.end, "person", "header", "high"));
  }
  return out;
};

// ---- postal address ---------------------------------------------------------------------------

const STREET_SUFFIX = "(?:str\\.|stra(?:ß|ss)e|weg|allee|platz|gasse|ring|damm|ufer|chaussee|pfad|steig|promenade)";
const STREET_WORD = "(?:Stra(?:ß|ss)e|Str\\.|Weg|Allee|Platz|Gasse|Ring|Damm|Ufer|Chaussee|Pfad|Steig|Promenade)";
const STREET_RE = new RegExp(
  `(^|[^${LETTER}])((?:[${UP}][${TAIL}]{0,48}${STREET_SUFFIX}|[${UP}][${LO}][${TAIL}]{0,30}${SP}${STREET_WORD})${SP}+\\d{1,4}[a-z]?(?:[-/]\\d{1,4}[a-z]?)?)(?![0-9A-Za-z])`,
  "g",
);
const PLACE = `[${UP}][${LO}][${TAIL}]{0,40}`;
const PLZ_RE = new RegExp(
  `(^|[^0-9${LETTER}])((?:0[1-9]|[1-9]\\d)\\d{3}${SP}+${PLACE}(?:${SP}(?:am|an der|im|bei|ob der)${SP}${PLACE})?)(?![${TAIL}])`,
  "g",
);
const GAP_RE = /^[ \u00a0]*[,;|·•-]?[ \u00a0]*$/;
/** A word behind a five-digit number that is a unit or a count, not a place ("50000 Euro"). */
const NOT_A_PLACE: ReadonlySet<string> = new Set([
  "Euro", "Stück", "Einwohner", "Besucher", "Personen", "Teilnehmer", "Mitglieder", "Jahre", "Seiten", "Zeichen", "Wörter", "Nutzer", "Kunden", "Dollar", "Franken",
  "Fälle", "Fans", "Mal", "Menschen", "Mitarbeiter", "Tonnen", "Kilometer", "Meter", "Users", "People", "Words", "Dollars", "Pounds", "Cent", "Prozent",
]);

function addressHits(c: string): Span[] {
  const streets = leadHits(STREET_RE, c);
  const places = leadHits(PLZ_RE, c).filter((h) => {
    const word = /^[0-9]{5}[ \u00a0]+(\S+)/.exec(c.slice(h.start, h.end));
    return !(word && NOT_A_PLACE.has(word[1] ?? ""));
  });
  // both lists are in text order: one pass, a street takes the place right behind it (the places in front of it stand alone)
  const out: Span[] = [];
  let pi = 0;
  for (const st of streets) {
    while (pi < places.length && (places[pi]?.start ?? 0) < st.end) {
      const lone = places[pi];
      if (lone) out.push(lone);
      pi++;
    }
    const next = places[pi];
    if (next && next.start - st.end <= 4 && GAP_RE.test(c.slice(st.end, next.start))) {
      out.push({ start: st.start, end: next.end });
      pi++;
    } else out.push(st);
  }
  for (; pi < places.length; pi++) {
    const lone = places[pi];
    if (lone) out.push(lone);
  }
  return out;
}

/** `postal-address`: a street with house number, a postal code with place, joined on one line. Low certainty (spec 8.4). */
export const detectPostalAddress: Detector = (text) => {
  if (typeof text !== "string") return [];
  const out: Finding[] = [];
  for (const line of splitLines(text)) {
    for (const h of addressHits(line.content)) out.push(make(text, line.base + h.start, line.base + h.end, "address", "postal-address", "low"));
  }
  return out;
};

// ---- running them --------------------------------------------------------------------------------

/** The detectors of version 1, in this order (the order breaks the last tie between overlapping findings of equal length and certainty). The model stage appends. */
export const DEFAULT_DETECTORS: readonly Detector[] = [
  detectEmail,
  detectIban,
  detectPhone,
  detectHeader,
  detectGreeting,
  detectSalutation,
  detectClosing,
  detectSignature,
  detectPostalAddress,
];

/** Resolves overlaps: of two findings that overlap the LONGER one stays, with equal length the surer, then the one that starts earlier, then the earlier in the list; findings that touch
 *  do not overlap. A finding that is empty, outside the text or not made of integers is dropped. The result is in text order. Spec 8.4. */
export function resolveFindings(text: string, findings: readonly Finding[]): Finding[] {
  if (typeof text !== "string") return [];
  const edits: Edit[] = [];
  findings.forEach((f, i) => {
    if (f.end > f.start) edits.push({ start: f.start, end: f.end, insert: String(i), priority: CONFIDENCE_RANK[f.confidence] ?? 0 });
  });
  const out: Finding[] = [];
  for (const e of applyEdits(text, edits).applied) {
    const f = findings[Number(e.insert)];
    if (f) out.push(f);
  }
  return out;
}

/** Runs `detectors` over `text` and resolves the overlaps ({@link resolveFindings}). A detector reports, it never replaces: the caller decides what happens to a finding. */
export function detectPersonalData(text: string, detectors: readonly Detector[] = DEFAULT_DETECTORS): Finding[] {
  if (typeof text !== "string" || text === "") return [];
  const all: Finding[] = [];
  for (const d of detectors) {
    for (const f of d(text)) all.push(f);
  }
  return resolveFindings(text, all);
}
