// Planen und Ausführen von `transform` (Bauplan Aufgabe 13; Spec 8.1, 8.4, 8.7). Rein: kein `obsidian`-Import, keine Zeit, kein Zufall (IDs kommen von außen).
//
// Zwei Schritte, getrennt, damit der zweite in der Warteschlange der Gerätedatei auf dem frischen Stand laufen kann:
//  1. `planTransform` liest die Anfrage und die Tabelle und sagt, was an welcher Stelle steht: bekannte Werte (ersetzt ohne Rückfrage), offene Kandidaten (brauchen eine Antwort).
//     Es ändert nichts.
//  2. `applyPlan` nimmt die Antworten zu den Kandidaten, legt neue Einträge an (in einer Kopie der Tabelle) und setzt die Texte zusammen.
//
// Woher die Fundstellen kommen: die Erkenner aus `pii-detect` (eine Liste mit gleicher Signatur, Spec 8.4 letzter Satz), die bekannten Formen der Tabelle (ganzes Wort), die Werte
// der `entities` und die `keep`-Werte des Aufrufers (diese nur als Sperre für genau diese Stelle). Sie überlappen sich; der längere gewinnt,
// bei Gleichstand der sicherere (`keep` vor bekannt vor Erkenner hoch, mittel, niedrig), angewendet von rechts nach links (`applyEdits` des Kits).
//
// Ein längerer Treffer gewinnt auch gegen einen `keep`-Wert, der in ihm steckt (K2a, entschieden): `keep: ["Max Mustermann"]` und eine bekannte Organisation `Max Mustermann GmbH` sind verschiedene Werte, die Organisation wird ersetzt;
// wer sie behalten will, nimmt sie selbst in `keep`.
//
// Was nie ersetzt wird: Code, Link-Ziele, URLs, Tags, Kommentare, Mathe (`replaceable-spans`, nur das Ziel von `mailto:` ist frei, Spec 8.4) und Platzhalter, die schon im Text stehen
// (ein zweiter Lauf über denselben Text darf „Person“ in `Person_k3x9m2ab7q` nicht als Namen lesen).
//
// Dateinamen [Plan, Entscheidung des Bau-Masters]: Ein Platzhalter in einem Dateinamen muss von `findPlaceholders` wiedergefunden werden, und die Spec verlangt als Grenze ein Zeichen, das kein
// Buchstabe, keine Ziffer und kein Unterstrich ist. Deshalb gilt für `kind: "filename"`:
//  - die Endung (ab dem letzten Punkt, wenn danach nur Buchstaben und Ziffern bis zu fünf Zeichen folgen) wird nie ersetzt und nie gelesen;
//  - `_` und `-` trennen beim Lesen wie ein Leerzeichen (`Rechnung_max@example.org.pdf` und `Rechnung-max@example.org.pdf` tragen dieselbe bekannte Adresse);
//  - eine UNBEKANNTE Adresse wird gierig gelesen (`greedyMails`, Entscheidung Johannes 2026-11-25): `-` und `_` gehören dort zum lokalen Teil wie im Mail-Muster des Kits, ein Wort davor verschwindet mit
//    (`Rechnung-max@example.org.pdf` wird EIN Kandidat `Rechnung-max@example.org`; zu viel ersetzen ist der ungefährliche Fehler, ein stehen gebliebenes `hans-` wäre ein Stück eines Werts);
//  - steht neben einer ersetzten Stelle ein Unterstrich, wird dieser Unterstrich ein Bindestrich (sonst wäre der Platzhalter ein Teil eines längeren Wortes).
//  - ein bekannter Wert, ein Wert aus dem Mail-Kopf und ein `keep`-Wert mit `_` oder `-` (`Hans-Peter Muster`, `max-muster@example.org`) wird zusätzlich in seiner Dateinamenform gesucht
//    und auf den Wert der Tabelle zurückgeführt (Welle 37).
// Grenzen: Der Rückweg stellt `Rechnung-max@example.org.pdf` her, nicht byte-gleich zu `Rechnung_max@example.org.pdf`. Bei einer unbekannten Adresse verschwindet ein Wort vor dem Bindestrich
// mit im Platzhalter. Eine bekannte Adresse (Tabelle, Mail-Kopf, `keep`) geht vor und ersetzt nur sich selbst: mit bekannter `max@example.org` bleibt in `hans-max@example.org.pdf` `hans-` stehen. Ein Dateiname ist keine
// Markdown-Zeile: Links, Tags und Code werden dort nicht geschützt.
//
// Benannte Lücken (Spec 8.4): Ein Dritter mitten im Satz ohne Anrede („die Kollegin Schmidt“) wird nicht gefunden. Wer in `keep` steht, wird nur geschützt, wenn er als eigene Fundstelle auftaucht
// oder als Wort im Text steht; Einträge der Ausnahmeliste und „hier lassen“ sperren nur die Fundstelle, die sie selbst treffen. Eine Fundstelle in einem Wikilink-Ziel (`[[Max Mustermann]]`) bleibt stehen
// (das Ziel ist geschützt), der Anzeigetext nach `|` ist frei.
// Besitzervorschlag aus der Struktur (Spec 8.1 Leitplanke 1): das Paar aus dem Mail-Kopf (`entities`) und der Signaturblock des Absenders. Ein Wert, den die Regel `signature` im Block nach der Grußformel
// (oder hinter `-- `) findet (Telefon, Mail, Adresse, IBAN), bekommt als `suggestedOwner` den Namen, der im selben Block davor steht (keine Leerzeile dazwischen); steht dort kein Name, gibt es keinen
// Vorschlag (Zentrale, `info@`). Das Paar aus dem Kopf geht vor. Es bleibt ein Vorschlag: bestätigt wird im Prüffenster, im unbeaufsichtigten Lauf ändert er nichts (dort werden nur bekannte Werte ersetzt).
// Von Hand markierte Stellen (`Mark`, Prüffenster „weitere Stellen markieren“): jeder Wortlaut wird an allen freien Stellen des Textes ein Kandidat ohne Besitzervorschlag.
// Suchen im Text: eine Schleife über Wortanfänge, kein verschachtelter Quantor; die Erkenner und die Bereiche kommen linear aus dem Kit.

import {
  applyEdits,
  findPlaceholders,
  formatPlaceholder,
  isPlaceholderId,
  type Edit,
  type PlaceholderCarrier,
  type PlaceholderField,
  type PlaceholderParts,
} from "../vendor/kit/placeholder";
import {
  normalizeTableValue,
  tableAddEntry,
  tableAddValue,
  tableFindValue,
  tableIsException,
  tableIsPlain,
  tableSetException,
  tableSetPlain,
  type PlaceholderTable,
} from "../vendor/kit/placeholder-table";
import {
  CONFIDENCE_RANK,
  detectClosing,
  detectEmail,
  detectGreeting,
  detectHeader,
  detectIban,
  detectPhone,
  detectPostalAddress,
  detectSalutation,
  detectSignature,
  type Detector,
  type Finding,
  type FindingKind,
} from "../vendor/kit/pii-detect";
import { listReplaceableSpans, type TextRange } from "../vendor/kit/replaceable-spans";
import type { TransformEntity, TransformRequest } from "../vendor/kit/pseudonymizer-source";
import type { RuleGroup } from "./settings";

// ---- Typen -------------------------------------------------------------------------------------------------------------------------------------

/** Was der Aufrufer und der Nutzer schon entschieden haben: „hier lassen“ für ein Dokument und die Ausnahmeliste („immer lassen“). */
export interface Decisions { keepHere(documentKey: string, value: string): boolean; isException(value: string): boolean }

export type CandidateKind = "person" | "organisation" | "mail" | "phone" | "address" | "iban";

/** Eine offene Fundstelle. `partId` ist `""` für einen Wert aus `entities` (er steht in keinem Teil; `entity` nennt den Index). `confidence` ist 0,9 (hoch), 0,6 (mittel) oder 0,3 (niedrig).
 *  `suggestedOwner` ist der Wert, an den die STRUKTUR diese Fundstelle bindet (das Paar aus dem Mail-Kopf: bei einer Adresse der Name, bei einem Namen die Adresse); ohne Strukturbeleg `null`
 *  (Spec 8.1 Leitplanke 1: sonst „gehört niemandem“). */
export type Candidate = { value: string; kind: CandidateKind; partId: string; start: number; end: number; confidence: number; suggestedOwner: string | null; entity?: number };

/** Eine geplante Ersetzung. `placeholder` ist der Text für einen bekannten Wert, `null` für einen offenen (dann hängt `candidate` daran). */
export interface PlannedEdit { partId: string; start: number; end: number; value: string; field: PlaceholderField | null; kind: CandidateKind; placeholder: string | null; candidate: Candidate | null }

/** Ein Wert aus `entities`: `kept` (bleibt im Klartext), bekannt (`placeholder`) oder offen (`placeholder` `null`, Kandidat in `candidates`). */
export interface EntitySlot { value: string; field: PlaceholderField | null; kind: CandidateKind; kept: boolean; placeholder: string | null }
export interface PlannedEntity { name?: EntitySlot; email?: EntitySlot }

/** `replacements`: Wortlaut eines bekannten Werts, wie er im Text stand, zu seinem Platzhalter. `candidates`: Entities zuerst, dann nach Teil und Stelle. */
export type PlanResult = { replacements: Map<string, string>; candidates: Candidate[]; edits: PlannedEdit[]; entities: PlannedEntity[] };

/** Die Antwort zu einem Kandidaten (eine Karte je Wert, `candidateKey`). `replace`: bei Person oder Organisation neuer Eintrag mit `carrier` (Vorgabe: Person) oder ein weiterer Name für `entry`;
 *  bei Adresse, Telefon, Mail oder IBAN gehört der Wert `owner`: dem vorgeschlagenen Besitzer (`"suggested"`, Vorgabe wenn es einen gibt), niemandem (`"nobody"`, sonst Vorgabe) oder einem Eintrag. */
export type Answer =
  | { action: "replace"; carrier?: PlaceholderCarrier; entry?: string; owner?: "suggested" | "nobody" | { entry: string } }
  | { action: "keep-here" }
  | { action: "keep-always" };

// ---- kleine Helfer -----------------------------------------------------------------------------------------------------------------------------

const FIELD_OF_KIND: Readonly<Record<CandidateKind, PlaceholderField | null>> = { person: null, organisation: null, mail: "mail", phone: "phone", address: "address", iban: "iban" };
const KIND_OF_FINDING: Readonly<Record<FindingKind, CandidateKind>> = { person: "person", email: "mail", phone: "phone", iban: "iban", address: "address" };
const CONFIDENCE = { high: 0.9, medium: 0.6, low: 0.3 } as const;
/** Über den Rängen der Erkenner (0 bis 2): eine bekannte Form schlägt einen gleich langen Erkenner, ein Wert der Sperrliste schlägt beide. */
const RANK_KNOWN = 4;
const RANK_KEPT = 5;
const RANK_ENTITY = CONFIDENCE_RANK.high;
const SEPARATOR_PRIORITY = -1;
const MAX_WORDS = 10;
const MAX_FORM_LENGTH = 200;

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const ALNUM = /[\p{L}\p{N}]/u;

function codePointBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index);
  }
  return text.charAt(index - 1);
}
function codePointAt(text: string, index: number): string | undefined {
  if (index >= text.length) return undefined;
  const cp = text.codePointAt(index);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}
const isWord = (ch: string | undefined): boolean => ch !== undefined && WORD_CHAR.test(ch);
const isAlnum = (ch: string | undefined): boolean => ch !== undefined && ALNUM.test(ch);
const isBlank = (ch: string): boolean => ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === " " || ch === "\f" || ch === "\v";

/** Das Gerüst eines Platzhalters oder `null`, wenn der Eintrag den Wert nicht hat (vergessen, Konflikt). */
function formatFound(parts: PlaceholderParts | undefined, lang: "de" | "en"): string | null {
  return parts === undefined ? null : formatPlaceholder(parts, lang);
}

/** Die Entscheidungen, die in der Tabelle stehen. */
export function decisionsOf(table: PlaceholderTable): Decisions {
  return { keepHere: (documentKey, value) => tableIsPlain(table, documentKey, value), isException: (value) => tableIsException(table, value) };
}

/** Die Schlüssel, nach denen zwei Fundstellen „derselbe Wert“ sind und eine Karte teilen: Art und normalisierte Form. */
export function candidateKey(c: { kind: CandidateKind; value: string }): string {
  return `${c.kind === "organisation" ? "person" : c.kind}|${normalizeTableValue(FIELD_OF_KIND[c.kind], c.value)}`;
}

/** Die Kandidaten, je Wert einer (der erste; trägt er keinen Besitzervorschlag, der erste, der einen trägt). In der Reihenfolge des ersten Auftretens. */
export function uniqueCandidates(candidates: readonly Candidate[]): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const c of candidates) {
    const k = candidateKey(c);
    const had = out.get(k);
    if (had === undefined) out.set(k, c);
    else if (had.suggestedOwner === null && c.suggestedOwner !== null) out.set(k, { ...had, suggestedOwner: c.suggestedOwner });
  }
  return [...out.values()];
}

// ---- Bereiche ----------------------------------------------------------------------------------------------------------------------------------

/** `ranges` ohne die Löcher; beide sortiert und überlappungsfrei. */
function subtract(ranges: readonly TextRange[], holes: readonly TextRange[]): TextRange[] {
  const out: TextRange[] = [];
  let h = 0;
  for (const r of ranges) {
    let at = r.start;
    while (h < holes.length && (holes[h]?.end ?? 0) <= at) h++;
    let k = h;
    while (k < holes.length && (holes[k]?.start ?? Infinity) < r.end) {
      const hole = holes[k];
      if (hole.start > at) out.push({ start: at, end: hole.start });
      at = Math.max(at, hole.end);
      k++;
    }
    if (at < r.end) out.push({ start: at, end: r.end });
  }
  return out;
}

/** Liegt `[start, end)` ganz in einem Bereich? (Binäre Suche; die Bereiche sind sortiert.) */
function inside(ranges: readonly TextRange[], start: number, end: number): boolean {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((ranges[mid]?.end ?? 0) <= start) lo = mid + 1;
    else hi = mid;
  }
  const r = ranges[lo];
  return r !== undefined && r.start <= start && end <= r.end;
}

/** Wo die Endung eines Dateinamens beginnt (`name.length`, wenn es keine gibt). */
function stemEnd(name: string): number {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name.length;
  const ext = name.slice(dot + 1);
  if (ext.length < 1 || ext.length > 5) return name.length;
  for (let i = 0; i < ext.length; i++) if (!/[A-Za-z0-9]/.test(ext.charAt(i))) return name.length;
  // `max@example.org` ohne Endung: der letzte Punkt gehört zur Adresse, wenn hinter dem `@` bis zu ihm kein weiterer Punkt und kein Trenner steht.
  const at = name.lastIndexOf("@", dot);
  if (at >= 0) {
    const domain = name.slice(at + 1, dot);
    if (domain !== "" && !/[ ._-]/.test(domain)) return name.length;
  }
  return dot;
}

/** Was ein Teil für die Suche ist: der Text, in dem gesucht wird (gleich lang wie das Original), und die Bereiche, in denen ersetzt werden darf. */
function viewOf(part: { kind: "text" | "line" | "filename"; value: string }): { view: string; ranges: TextRange[] } {
  if (part.kind === "filename") {
    const end = stemEnd(part.value);
    const stem = part.value.slice(0, end);
    const placeholders = findPlaceholders(stem).map((p) => ({ start: p.start, end: p.end }));
    let view = "";
    for (let i = 0; i < stem.length; i++) {
      const ch = stem.charAt(i);
      view += ch === "_" || ch === "-" ? " " : ch;
    }
    return { view, ranges: subtract(end > 0 ? [{ start: 0, end }] : [], placeholders) };
  }
  const placeholders = findPlaceholders(part.value).map((p) => ({ start: p.start, end: p.end }));
  return { view: part.value, ranges: subtract(listReplaceableSpans(part.value, { allow: ["mailto-target"] }), placeholders) };
}

// ---- bekannte Formen im Text suchen --------------------------------------------------------------------------------------------------------------

type Tag = "keep" | "known" | "entity";
const TAG_RANK: Readonly<Record<Tag, number>> = { entity: 0, known: 1, keep: 2 };
type ScanField = null | "address" | "mail";
const SCAN_FIELDS: readonly ScanField[] = [null, "address", "mail"];

interface FormSet { map: Map<string, Tag>; first: Set<string>; maxWords: number; maxLength: number }

const formKey = (field: ScanField, key: string): string => `${field ?? ""}|${key}`;
/** Wie viele Zeichen vom Anfang des ersten Wortes die Vorauswahl vergleicht. */
const PREFIX = 3;
/** Höchstens so viele Enden je Anfang werden geprüft (die Suche bleibt linear, auch bei Text aus lauter Wortgrenzen). */
const MAX_ENDS = 24;

function addForm(set: FormSet, field: ScanField, text: string, tag: Tag): void {
  const key = normalizeTableValue(field, text);
  if (key === "" || key.length > MAX_FORM_LENGTH) return;
  const k = formKey(field, key);
  const had = set.map.get(k);
  if (had !== undefined && TAG_RANK[had] >= TAG_RANK[tag]) return;
  set.map.set(k, tag);
  const words = key.split(" ");
  set.first.add((words[0] ?? "").slice(0, PREFIX));
  set.maxWords = Math.min(MAX_WORDS, Math.max(set.maxWords, words.length));
  set.maxLength = Math.max(set.maxLength, key.length);
}

/** Nach dem Wort liest ein Bindestrich oder ein Adresszeichen weiter: dort endet ein ganzes Wort nicht. */
function boundaryOk(view: string, start: number, end: number, field: ScanField): boolean {
  const before = codePointBefore(view, start);
  if (before !== undefined) {
    if (isWord(before)) return false;
    if (before === "-" && (field === "mail" || isAlnum(codePointBefore(view, start - 1)))) return false;
    if (field === "mail" && (before === "." || before === "%" || before === "+" || before === "@")) return false;
  }
  const after = codePointAt(view, end);
  if (after !== undefined) {
    if (isWord(after)) return false;
    const next = codePointAt(view, end + after.length);
    if (after === "-" && (field === "mail" || isAlnum(next))) return false;
    if (field === "mail" && (after === "@" || (after === "." && isAlnum(next)))) return false;
  }
  return true;
}

interface ScanHit { start: number; end: number; field: ScanField; tag: Tag; text: string }

/** Ob ein Wortanfang an `i` eine bekannte Form eröffnen könnte: die ersten Zeichen (eins bis drei), gefaltet, stehen unter den Anfängen der Formen. */
function mayStart(view: string, i: number, set: FormSet): boolean {
  for (let k = 1; k <= PREFIX && i + k <= view.length; k++) {
    if (set.first.has(normalizeTableValue(null, view.slice(i, i + k)))) return true;
  }
  return false;
}

/** `filename`: die Sicht eines Dateinamens, in der `_` und `-` Leerzeichen sind; dort darf eine Mail-Form Leerzeichen tragen (ihre Dateinamenform, `max muster@example.org`). */
function scanForms(view: string, set: FormSet, filename = false): ScanHit[] {
  const out: ScanHit[] = [];
  const n = view.length;
  if (set.map.size === 0) return out;
  const window = Math.min(MAX_FORM_LENGTH, set.maxLength * 2 + 16);
  let i = 0;
  while (i < n) {
    const ch = codePointAt(view, i) ?? " ";
    const atStart = isWord(ch) && !isWord(codePointBefore(view, i));
    if (atStart && mayStart(view, i, set)) {
      let gaps = 0;
      let tested = 0;
      for (let j = i + 1; j <= n && j - i <= window && tested < MAX_ENDS && gaps < set.maxWords; j++) {
        const prev = view.charAt(j - 1);
        const cur = j < n ? view.charAt(j) : "";
        if (cur !== "" && isBlank(cur) && !isBlank(prev)) gaps++;
        const low = cur.charCodeAt(0);
        if (cur !== "" && low >= 0xdc00 && low <= 0xdfff) continue; // mitten in einem Zeichenpaar
        const wordEnd = (isAlnum(codePointBefore(view, j)) || prev === ".") && (cur === "" || !isWord(codePointAt(view, j)));
        if (!wordEnd) continue;
        tested++;
        const sub = view.slice(i, j);
        for (const field of SCAN_FIELDS) {
          if (field === "mail" && !filename && sub.includes(" ")) continue;
          const tag = set.map.get(formKey(field, normalizeTableValue(field, sub)));
          if (tag !== undefined && boundaryOk(view, i, j, field)) out.push({ start: i, end: j, field, tag, text: sub });
        }
      }
    }
    i += ch.length;
  }
  return out;
}

// ---- Planen ------------------------------------------------------------------------------------------------------------------------------------

const DETECTORS: readonly { group: RuleGroup; run: Detector }[] = [
  { group: "patterns", run: detectEmail },
  { group: "patterns", run: detectIban },
  { group: "patterns", run: detectPhone },
  { group: "header-lines", run: detectHeader },
  { group: "salutation", run: detectGreeting },
  { group: "salutation", run: detectSalutation },
  { group: "salutation", run: detectClosing },
  { group: "signature", run: detectSignature },
  { group: "postal-address", run: detectPostalAddress },
];

/** Alle Erkennergruppen aus: die Planung findet dann nur noch, was die Tabelle schon kennt. */
const NO_RULES: Record<RuleGroup, boolean> = { patterns: false, salutation: false, signature: false, "header-lines": false, "postal-address": false };

type KeepFn = (field: PlaceholderField | null, text: string) => boolean;

/** Wer in `keep` steht, in der Ausnahmeliste oder für dieses Dokument „hier lassen“: in der Form des jeweiligen Feldes verglichen. */
function keepMatcher(keep: readonly string[], decisions: Decisions, documentKey: string): KeepFn {
  const fields: (PlaceholderField | null)[] = [null, "mail", "phone", "address", "iban"];
  const set = new Set<string>();
  for (const k of keep) for (const f of fields) { const key = normalizeTableValue(f, k); if (key !== "") set.add(`${f ?? ""}|${key}`); }
  return (field, text) => set.has(`${field ?? ""}|${normalizeTableValue(field, text)}`) || decisions.isException(text) || decisions.keepHere(documentKey, text);
}

/** Steht zwischen zwei Stellen eine Leerzeile? (Ein Signaturblock endet an ihr.) */
function hasBlankLine(between: string): boolean {
  let afterBreak = false;
  for (let i = 0; i < between.length; i++) {
    const ch = between.charAt(i);
    if (ch === "\n") { if (afterBreak) return true; afterBreak = true; }
    else if (ch !== " " && ch !== "\t" && ch !== "\r") afterBreak = false;
  }
  return false;
}

/** Strukturbeleg „Signaturblock“ (Spec 8.1 Leitplanke 1, 8.5): Ein Wert, den die Regel `signature` im Block nach der Grußformel (oder hinter `-- `) findet, wird der Person vorgeschlagen, deren Name
 *  in diesem Block steht: der nächste Name davor, ohne Leerzeile dazwischen (der Block endet an ihr). Steht kein Name im Block (Zentrale, `info@`), gibt es keinen Vorschlag. Nur ein Vorschlag:
 *  die Bestätigung bleibt im Prüffenster; im unbeaufsichtigten Lauf ändert er nichts, weil dort nur bekannte Werte ersetzt werden. */
function signatureOwner(view: string, f: Finding, names: readonly Finding[]): string | null {
  if (f.rule !== "signature" || f.kind === "person") return null;
  let best: Finding | null = null;
  for (const n of names) if (n.end <= f.start && (best === null || n.end > best.end)) best = n;
  return best !== null && !hasBlankLine(view.slice(best.end, f.start)) ? best.text : null;
}

interface Hit { start: number; end: number; text: string; field: PlaceholderField | null; kind: CandidateKind; rank: number; kept: boolean; placeholder: string | null; confidence: number; owner: string | null }

const kindOfField = (f: PlaceholderField | null): CandidateKind => (f === null ? "person" : f);

/** Ein Zeichen, das im Dateinamen noch zum lokalen Teil einer Adresse gelesen wird: Buchstaben (auch Umlaute) und Ziffern, `_` und die Zeichen `.%+-` des Kit-Musters. */
const LOCAL_CHAR = /^[\p{L}\p{N}_.%+-]$/u;
/** Am Anfang des gierigen Werts nicht mitgenommen: ein Trenner bleibt im Dateinamen stehen. */
const LOCAL_LEAD = /^[._%+-]$/;

/**
 * `filename`: die Adressen, gierig gelesen (Entscheidung Johannes 2026-11-25). Das Mail-Muster des Kits läuft auf dem rohen Stamm, in dem `-` und `_` stehen, wie sie stehen: beide sind dort
 * Zeichen des lokalen Teils (`[A-Z0-9._%+-]`), also wird `Rechnung-max-muster@example.org` und `Rechnung_max-muster@example.org` als Ganzes gelesen, nicht ab dem letzten Trenner. Danach läuft der Anfang
 * über weitere Buchstaben (auch Umlaute, die das ASCII-Muster nicht kennt) bis zu einem Leerzeichen, einem anderen Zeichen oder dem Rand des ersetzbaren Bereichs (ein Platzhalter im Namen wird nie
 * mitgenommen); ein Trenner am Anfang bleibt stehen. Vorrang: Berührt die gierige Fassung einen Treffer der Formenliste mit Feld `mail` (bekannt, aus dem Mail-Kopf, `keep`), entfällt sie, und der
 * Wert der Tabelle gewinnt wie bisher. Zurück kommen nur Fassungen, die länger sind als ein Fund der Sicht (sonst trägt der schon dieselbe Stelle); der längere gewinnt dann in `applyEdits`.
 */
function greedyMails(name: string, ranges: readonly TextRange[], formHits: readonly ScanHit[], viewMails: readonly Finding[]): { start: number; end: number; text: string }[] {
  const stem = name.slice(0, stemEnd(name));
  const out: { start: number; end: number; text: string }[] = [];
  // Der Anfang läuft nie über das Ende des vorigen Funds zurück: jedes Zeichen wird höchstens einmal gelesen, die Suche bleibt linear.
  let floor = 0;
  for (const f of detectEmail(stem)) {
    const range = ranges.find((r) => r.start < f.end && f.end <= r.end);
    const low = Math.max(floor, range?.start ?? 0);
    floor = f.end;
    if (range === undefined) continue;
    let start = Math.max(f.start, low);
    while (start > low) {
      const ch = codePointBefore(stem, start);
      if (ch === undefined || !LOCAL_CHAR.test(ch)) break;
      start -= ch.length;
    }
    while (start < f.end && LOCAL_LEAD.test(stem.charAt(start))) start++;
    const end = f.end;
    if (formHits.some((h) => h.field === "mail" && h.start < end && start < h.end)) continue;
    if (viewMails.some((v) => v.start <= start && end <= v.end)) continue;
    out.push({ start, end, text: stem.slice(start, end) });
  }
  return out;
}

/**
 * Was in der Anfrage steht und was die Tabelle dazu sagt. Ändert nichts. `enabled` schaltet die Regelgruppen der Erkenner ab: ein abgeschalteter Erkenner meldet keinen Kandidaten, ersetzt aber, was die
 * Tabelle schon kennt (ein bekannter Wert verschwindet nicht, weil eine Gruppe aus ist). `lang` ist die Sprache der Platzhalter-Wörter (Spec 8.1).
 */
export function planTransform(req: TransformRequest, table: PlaceholderTable, decisions: Decisions, enabled: Record<RuleGroup, boolean>, lang: "de" | "en" = "de"): PlanResult {
  const keep = keepMatcher(req.keep ?? [], decisions, req.documentKey);
  const lookup = (field: PlaceholderField | null, text: string): string | null => formatFound(tableFindValue(table, field, text), lang);

  // Die Formen, nach denen im Text gesucht wird. Sie werden gesammelt und am Ende gebaut: für Dateinamen gibt es eine eigene Liste (N4).
  const adds: { field: ScanField; text: string; tag: Tag }[] = [];
  for (const v of table.values) {
    if (v.field !== null && v.field !== "address" && v.field !== "mail") continue;
    if (lookup(v.field, v.text) !== null) adds.push({ field: v.field, text: v.text, tag: "known" });
  }
  for (const k of req.keep ?? []) for (const f of SCAN_FIELDS) adds.push({ field: f, text: k, tag: "keep" });
  // Im Dateinamen trennen `_` und `-` wie ein Leerzeichen (`viewOf`): ein `keep`-Wert mit Bindestrich (`max-muster@example.org`) wäre dort nie zu finden, und sein hinterer Teil würde Kandidat (K2b).
  // Darum steht er zusätzlich in seiner Dateinamenform als Sperre, aber nur in der Formenliste der Dateinamen-Teile: in Text und Zeilen sperrte `Max Muster` sonst einen bekannten Wert, der nicht in `keep` steht (N4).
  const filenameAdds: { field: ScanField; text: string; tag: Tag }[] = [];
  const hasFilename = req.parts.some((p) => p.kind === "filename");
  if (hasFilename) {
    for (const k of req.keep ?? []) {
      const asName = k.replace(/[_-]/g, " ");
      if (asName !== k) for (const f of SCAN_FIELDS) filenameAdds.push({ field: f, text: asName, tag: "keep" });
    }
  }
  // Dasselbe für bekannte Werte und Werte aus dem Mail-Kopf (Welle 37, Stichprobe zur Task „Adressen mit Bindestrich im Dateinamen“): `Hans-Peter Muster` und `max-muster@example.org`
  // stünden im Dateinamen sonst als Klartext, ohne Kandidat. Ihre Dateinamenform steht nur in der Formenliste der Dateinamen-Teile, und ein Treffer wird auf den Wert der Tabelle
  // zurückgeführt (`filenameOriginal`), damit er seinen Platzhalter findet.
  const filenameOriginal = new Map<string, string>();
  const filenameKey = (field: PlaceholderField | null, text: string): string => `${field ?? ""}|${normalizeTableValue(field, text)}`;
  const addFilenameForm = (a: { field: ScanField; text: string; tag: Tag }): void => {
    if (!hasFilename || a.tag === "keep") return;
    const asName = a.text.replace(/[_-]/g, " ");
    if (asName === a.text) return;
    filenameAdds.push({ field: a.field, text: asName, tag: a.tag });
    filenameOriginal.set(filenameKey(a.field, asName), a.text);
  };

  // Die Werte aus dem Mail-Kopf: Teil der Suche (auch wo kein Erkenner anschlägt) und, wenn unbekannt, offene Kandidaten.
  const entities: PlannedEntity[] = [];
  const partner = new Map<string, string>();
  const slotOf = (value: string | undefined, field: PlaceholderField | null): EntitySlot | undefined => {
    if (value === undefined || value.trim() === "") return undefined;
    const kept = keep(field, value);
    return { value, field, kind: kindOfField(field), kept, placeholder: kept ? null : lookup(field, value) };
  };
  (req.entities ?? []).forEach((e: TransformEntity) => {
    const name = slotOf(e.name, null);
    const email = slotOf(e.email, "mail");
    entities.push({ ...(name ? { name } : {}), ...(email ? { email } : {}) });
    if (name && !name.kept && name.placeholder === null) adds.push({ field: null, text: name.value, tag: "entity" });
    if (email && !email.kept && email.placeholder === null) adds.push({ field: "mail", text: email.value, tag: "entity" });
    if (name && email && !name.kept && !email.kept) {
      partner.set(`|${normalizeTableValue(null, name.value)}`, email.value);
      partner.set(`mail|${normalizeTableValue("mail", email.value)}`, name.value);
    }
  });
  const partnerOf = (field: PlaceholderField | null, text: string): string | null => partner.get(`${field ?? ""}|${normalizeTableValue(field, text)}`) ?? null;
  const buildForms = (list: readonly { field: ScanField; text: string; tag: Tag }[]): FormSet => {
    const set: FormSet = { map: new Map(), first: new Set(), maxWords: 1, maxLength: 0 };
    for (const a of list) addForm(set, a.field, a.text, a.tag);
    return set;
  };
  for (const a of adds) addFilenameForm(a);
  const forms = buildForms(adds);
  const filenameForms = filenameAdds.length > 0 ? buildForms([...adds, ...filenameAdds]) : forms;

  const edits: PlannedEdit[] = [];
  const candidates: Candidate[] = [];
  const replacements = new Map<string, string>();

  entities.forEach((e, index) => {
    for (const slot of [e.name, e.email]) {
      if (slot === undefined || slot.kept || slot.placeholder !== null) continue;
      candidates.push({ value: slot.value, kind: slot.kind, partId: "", start: 0, end: slot.value.length, confidence: CONFIDENCE.high, suggestedOwner: partnerOf(slot.field, slot.value), entity: index });
    }
  });

  for (const part of req.parts) {
    if (part.value === "") continue;
    const { view, ranges } = viewOf(part);
    if (ranges.length === 0) continue;
    const hits: Hit[] = [];
    const push = (start: number, end: number, field: PlaceholderField | null, kind: CandidateKind, rank: number, confidence: number, tag: Tag | null, owner: string | null = null, raw?: string): void => {
      if (end <= start || !inside(ranges, start, end)) return;
      const seen = raw ?? view.slice(start, end);
      const text = part.kind === "filename" ? (filenameOriginal.get(filenameKey(field, seen)) ?? seen) : seen;
      const placeholder = lookup(field, text);
      const kept = tag === "keep" || keep(field, text);
      hits.push({ start, end, text, field, kind, rank: kept ? RANK_KEPT : placeholder !== null ? RANK_KNOWN : rank, kept, placeholder: kept ? null : placeholder, confidence, owner });
    };
    const formHits = part.kind === "filename" ? scanForms(view, filenameForms, true) : scanForms(view, forms);
    for (const h of formHits) {
      const field = h.field;
      push(h.start, h.end, field, kindOfField(field), RANK_ENTITY, CONFIDENCE.high, h.tag);
    }
    const found = DETECTORS.map((d) => ({ group: d.group, findings: d.run(view) }));
    if (part.kind === "filename") {
      const viewMails = found.flatMap((g) => g.findings).filter((f) => f.kind === "email");
      for (const g of greedyMails(part.value, ranges, formHits, viewMails)) {
        if (!enabled.patterns && lookup("mail", g.text) === null && !keep("mail", g.text)) continue;
        push(g.start, g.end, "mail", "mail", CONFIDENCE_RANK.high, CONFIDENCE.high, null, null, g.text);
      }
    }
    // Die Namen, die ein Signaturblock tragen kann: die Namenszeile nach der Grußformel und die erste Zeile hinter `-- `.
    const blockNames = found.flatMap((g) => g.findings).filter((f) => f.kind === "person" && (f.rule === "closing" || f.rule === "signature") && !keep(null, f.text));
    // Derselbe Wert wird oft von zwei Regeln gefunden (die Mail-Adresse als Muster und als Signatur); der Besitzervorschlag hängt an der Stelle, nicht an der Regel, die gewinnt.
    const owners = new Map<string, string>();
    for (const g of found) for (const f of g.findings) {
      const owner = signatureOwner(view, f, blockNames);
      if (owner !== null) owners.set(`${String(f.start)}:${String(f.end)}`, owner);
    }
    for (const g of found) {
      for (const f of g.findings) {
        const kind = KIND_OF_FINDING[f.kind];
        const field = FIELD_OF_KIND[kind];
        // Eine abgeschaltete Gruppe meldet nichts Neues, aber ein bekannter Wert wird weiter ersetzt.
        if (!enabled[g.group] && lookup(field, f.text) === null && !keep(field, f.text)) continue;
        push(f.start, f.end, field, kind, CONFIDENCE_RANK[f.confidence], CONFIDENCE[f.confidence], null, owners.get(`${String(f.start)}:${String(f.end)}`) ?? null);
      }
    }
    // Überlappung: der längere gewinnt, bei Gleichstand der Rang; `applyEdits` ist die Quelle der Regel.
    const resolved = applyEdits(view, hits.map((h, i): Edit => ({ start: h.start, end: h.end, insert: String(i), priority: h.rank }))).applied;
    for (const r of resolved) {
      const h = hits[Number(r.insert)];
      if (h === undefined || h.kept) continue;
      if (h.placeholder !== null) {
        replacements.set(h.text, h.placeholder);
        edits.push({ partId: part.id, start: h.start, end: h.end, value: h.text, field: h.field, kind: h.kind, placeholder: h.placeholder, candidate: null });
      } else {
        const candidate: Candidate = { value: h.text, kind: h.kind, partId: part.id, start: h.start, end: h.end, confidence: h.confidence, suggestedOwner: partnerOf(h.field, h.text) ?? h.owner };
        candidates.push(candidate);
        edits.push({ partId: part.id, start: h.start, end: h.end, value: h.text, field: h.field, kind: h.kind, placeholder: null, candidate });
      }
    }
  }
  return { replacements, candidates, edits, entities };
}

// ---- Von Hand markierte Stellen ------------------------------------------------------------------------------------------------------------------

/** Eine Stelle, die der Nutzer im Prüffenster von Hand markiert hat („Text ansehen und weitere Stellen markieren“, Spec 8.5): der Wortlaut und die Art. Jede Fundstelle dieses Wortlauts im Text wird ein Kandidat. */
export type Mark = { value: string; kind: CandidateKind };

/** Die Kandidaten und Ersetzungen zu den Markierungen: jede Stelle, an der der Wortlaut als ganzes Wort steht, in einem ersetzbaren Bereich (nicht in Code, Link-Zielen, URLs, Tags) und ohne eine Stelle zu
 *  berühren, die der Plan schon belegt (bekannt oder offen). Die Sicherheit ist 1, weil der Mensch es gesagt hat; einen Besitzervorschlag gibt es nicht (Spec 8.1 Leitplanke 1). In Dateinamen
 *  gilt `_`/`-` als Leerzeichen wie beim Erkennen. */
function placeMarks(req: TransformRequest, plan: PlanResult, marks: readonly Mark[]): { candidates: Candidate[]; edits: PlannedEdit[] } {
  const candidates: Candidate[] = [];
  const edits: PlannedEdit[] = [];
  const taken = new Map<string, TextRange[]>();
  for (const e of plan.edits) {
    const list = taken.get(e.partId) ?? [];
    list.push({ start: e.start, end: e.end });
    taken.set(e.partId, list);
  }
  const seen = new Set<string>();
  for (const mark of marks) {
    const key = candidateKey(mark);
    if (seen.has(key) || mark.value.trim() === "") continue;
    seen.add(key);
    for (const part of req.parts) {
      if (part.value === "") continue;
      const { view, ranges } = viewOf(part);
      const needle = part.kind === "filename" ? mark.value.replace(/[_-]/g, " ") : mark.value;
      if (needle.trim() === "") continue;
      const occupied = taken.get(part.id) ?? [];
      let from = 0;
      for (;;) {
        const at = view.indexOf(needle, from);
        if (at < 0) break;
        from = at + needle.length;
        const end = at + needle.length;
        const first = codePointAt(needle, 0);
        const last = codePointBefore(needle, needle.length);
        if (isWord(first) && isWord(codePointBefore(view, at))) continue;
        if (isWord(last) && isWord(codePointAt(view, end))) continue;
        if (!inside(ranges, at, end) || occupied.some((o) => at < o.end && o.start < end)) continue;
        const candidate: Candidate = { value: needle, kind: mark.kind, partId: part.id, start: at, end, confidence: 1, suggestedOwner: null };
        candidates.push(candidate);
        edits.push({ partId: part.id, start: at, end, value: needle, field: FIELD_OF_KIND[mark.kind], kind: mark.kind, placeholder: null, candidate });
        occupied.push({ start: at, end });
      }
      taken.set(part.id, occupied);
    }
  }
  return { candidates, edits };
}

/** Die Kandidaten zu den Markierungen (für die Karten des Prüffensters). Leer, wenn der Wortlaut nirgends als freies Wort steht. */
export function markCandidates(req: TransformRequest, plan: PlanResult, marks: readonly Mark[]): Candidate[] {
  return placeMarks(req, plan, marks).candidates;
}

/** Der Plan mit den markierten Stellen als weiteren Kandidaten und Ersetzungen. */
export function withMarks(req: TransformRequest, plan: PlanResult, marks: readonly Mark[]): PlanResult {
  if (marks.length === 0) return plan;
  const added = placeMarks(req, plan, marks);
  return { ...plan, candidates: [...plan.candidates, ...added.candidates], edits: [...plan.edits, ...added.edits] };
}

// ---- Ausführen ---------------------------------------------------------------------------------------------------------------------------------

export type Outcome = {
  /** Die Tabelle mit den neuen Einträgen, Ausnahmen und Entscheidungen; die Eingabe, wenn nichts dazukam. */
  table: PlaceholderTable;
  changed: boolean;
  parts: { id: string; value: string }[];
  entities: TransformEntity[];
  applied: number;
};
export type Applied = ({ ok: true } & Outcome) | { ok: false };

/** Die Vorgabe zu einem Kandidaten, wenn niemand etwas anderes sagt: ersetzen, Besitzer nur aus der Struktur (Spec 8.1 Leitplanke 1). Ein Name, dessen Adresse die Tabelle schon einer Person oder
 *  Organisation zuordnet, wird eine weitere Schreibweise dieser Person. */
export function defaultAnswer(c: Candidate, table: PlaceholderTable): Answer {
  if ((c.kind === "person" || c.kind === "organisation") && c.suggestedOwner !== null) {
    const holder = tableFindValue(table, "mail", c.suggestedOwner);
    if (holder !== undefined && holder.carrier !== null) return { action: "replace", entry: holder.id };
  }
  return { action: "replace", owner: c.suggestedOwner !== null ? "suggested" : "nobody" };
}

/** Der Plan für EINE vom Nutzer gewählte Stelle (Befehl „Auswahl pseudonymisieren“, Aufgabe 15): ein Teil `sel` mit dem Wert, ein Kandidat über den ganzen Wert, keine Erkennung. Mit `applyPlan` und einer
 *  Antwort unter `key` entstehen so dieselben Einträge wie im Prüffenster (neue Person, weiterer Name für einen Eintrag, Besitzer eines Werts, vorhandener Wert behält seinen Platzhalter). */
export function planSelection(value: string, kind: CandidateKind): { req: TransformRequest; plan: PlanResult; key: string } {
  const candidate: Candidate = { value, kind, partId: "sel", start: 0, end: value.length, confidence: CONFIDENCE.high, suggestedOwner: null };
  const edit: PlannedEdit = { partId: "sel", start: 0, end: value.length, value, field: FIELD_OF_KIND[kind], kind, placeholder: null, candidate };
  return {
    req: { caller: "pseudonymizer", documentKey: "selection", interactive: true, parts: [{ id: "sel", kind: "line", value }] },
    plan: { replacements: new Map(), candidates: [candidate], edits: [edit], entities: [] },
    key: candidateKey(candidate),
  };
}

/** Gelten die bekannten Stellen des Plans (Werte, die ohne Rückfrage ersetzt werden) auf `table` noch mit demselben Platzhalter? Der Plan entsteht vor dem Prüffenster; kommt währenddessen eine Vergessen-Marke an
 *  (Sync, Minutentakt), wäre der Name der vergessenen Person sonst durch ihren vergessenen Platzhalter ersetzt, statt als neue Person angeboten zu werden (Sicherheits-Lesung Runde 1, K3). */
export function knownStillHold(plan: PlanResult, table: PlaceholderTable, lang: "de" | "en" = "de"): boolean {
  const holds = (field: PlaceholderField | null, value: string, placeholder: string): boolean => {
    const now = tableFindValue(table, field, value);
    return now !== undefined && formatPlaceholder(now, lang) === placeholder;
  };
  for (const e of plan.edits) if (e.placeholder !== null && !holds(e.field, e.value, e.placeholder)) return false;
  for (const ent of plan.entities) for (const slot of [ent.name, ent.email]) if (slot !== undefined && !slot.kept && slot.placeholder !== null && !holds(slot.field, slot.value, slot.placeholder)) return false;
  return true;
}

/** Setzt die Antworten um: legt in einer Kopie von `base` die neuen Einträge an (die Kennungen kommen aus `newId`) und baut die Texte. Ein Wert, den `base` inzwischen kennt (ein anderer Weg hat ihn
 *  angelegt), bekommt dessen Platzhalter, keinen zweiten Eintrag. `{ ok: false }`, wenn die Tabelle einen Schritt ablehnt (etwa 99 Werte im Feld, ein vergessener Besitzer): dann ist nichts geändert. */
export function applyPlan(req: TransformRequest, plan: PlanResult, base: PlaceholderTable, answers: ReadonlyMap<string, Answer>, newId: () => string, lang: "de" | "en" = "de"): Applied {
  let table = base;
  let changed = false;
  const fresh = (taken: (id: string) => boolean): string | null => {
    for (let i = 0; i < 32; i++) {
      const id = newId();
      if (isPlaceholderId(id) && !taken(id)) return id;
    }
    return null;
  };
  const resolved = new Map<string, string>(); // candidateKey -> Platzhalter
  const nameOwner = new Map<string, string>(); // normalisierter Name -> Eintrag
  const unique = uniqueCandidates(plan.candidates);
  const ordered = [...unique.filter((c) => c.kind === "person" || c.kind === "organisation"), ...unique.filter((c) => c.kind !== "person" && c.kind !== "organisation")];
  const idTaken = (id: string): boolean => table.entries.some((e) => e.id === id) || table.binds.some((b) => b[0] === id || b[1] === id) || table.decisions.some((d) => d.sid === id);

  for (const c of ordered) {
    const key = candidateKey(c);
    const answer = answers.get(key) ?? defaultAnswer(c, table);
    const field = FIELD_OF_KIND[c.kind];
    if (answer.action === "keep-always") {
      const r = tableSetException(table, c.value, true);
      if (!r.ok) return { ok: false };
      if (r.table !== table) { table = r.table; changed = true; }
      continue;
    }
    if (answer.action === "keep-here") {
      const id = fresh(idTaken);
      if (id === null) return { ok: false };
      const r = tableSetPlain(table, req.documentKey, c.value, true, { id });
      if (!r.ok) return { ok: false };
      if (r.table !== table) { table = r.table; changed = true; }
      continue;
    }
    const existing = tableFindValue(table, field, c.value);
    if (existing !== undefined) {
      const text = formatPlaceholder(existing, lang);
      if (text === null) return { ok: false };
      resolved.set(key, text);
      if (field === null) nameOwner.set(normalizeTableValue(null, c.value), existing.id);
      continue;
    }
    let owner: string | null = null;
    if (field === null) {
      if (answer.entry !== undefined) owner = answer.entry;
      else {
        const id = fresh(idTaken);
        if (id === null) return { ok: false };
        const carrier: PlaceholderCarrier = answer.carrier ?? (c.kind === "organisation" ? "organisation" : "person");
        const e = tableAddEntry(table, id, carrier);
        if (!e.ok) return { ok: false };
        table = e.table;
        owner = id;
      }
      nameOwner.set(normalizeTableValue(null, c.value), owner);
    } else {
      const wish = answer.owner ?? (c.suggestedOwner !== null ? "suggested" : "nobody");
      if (wish === "suggested") {
        if (c.suggestedOwner !== null) owner = nameOwner.get(normalizeTableValue(null, c.suggestedOwner)) ?? tableFindValue(table, null, c.suggestedOwner)?.id ?? null;
      } else if (wish !== "nobody") owner = wish.entry;
      if (owner === null) {
        const id = fresh(idTaken);
        if (id === null) return { ok: false };
        const e = tableAddEntry(table, id, null);
        if (!e.ok) return { ok: false };
        table = e.table;
        owner = id;
      }
    }
    const added = tableAddValue(table, { id: owner, field, text: c.value });
    if (!added.ok) return { ok: false };
    table = added.table;
    changed = true;
    const text = formatPlaceholder(added.placeholder, lang);
    if (text === null) return { ok: false };
    resolved.set(key, text);
  }

  // Eine Karte je Wert (Spec 8.5, N6): Der Wert steht jetzt in der Tabelle. Alle Teile werden noch einmal gegen die nun bekannten Formen geplant (ohne Erkenner: nur Bekanntes zählt), und jede Stelle, die der Plan nicht
  // schon belegt, wird mit ersetzt. Sonst bliebe derselbe Wert dort als Klartext stehen, wo kein Erkenner ihn fand (`Hallo Erika Musterfrau,` am Zeilenanfang wird gefunden, derselbe Gruß mitten in der Zeile nicht).
  // Stellen mit „hier lassen“ und „immer lassen“ bleiben, weil diese Entscheidungen schon in `table` stehen und die Planung sie wie `keep` behandelt.
  let planned = plan.edits;
  if (changed || resolved.size > 0) {
    const taken = new Map<string, TextRange[]>();
    for (const e of plan.edits) taken.set(e.partId, [...(taken.get(e.partId) ?? []), { start: e.start, end: e.end }]);
    const extra = planTransform(req, table, decisionsOf(table), NO_RULES, lang).edits
      .filter((e) => e.placeholder !== null && !(taken.get(e.partId) ?? []).some((t) => e.start < t.end && t.start < e.end));
    planned = [...plan.edits, ...extra];
  }

  // Die Texte: bekannte Stellen mit ihrem Platzhalter, offene mit dem Ergebnis ihrer Antwort (keine Antwort „ersetzen“: die Stelle bleibt).
  const byPart = new Map<string, Edit[]>();
  for (const e of planned) {
    const text = e.placeholder ?? (e.candidate === null ? null : (resolved.get(candidateKey(e.candidate)) ?? null));
    if (text === null) continue;
    const list = byPart.get(e.partId) ?? [];
    list.push({ start: e.start, end: e.end, insert: text, priority: 0 });
    byPart.set(e.partId, list);
  }
  let applied = 0;
  const parts = req.parts.map((p) => {
    const edits = byPart.get(p.id) ?? [];
    if (p.kind === "filename") for (const e of [...edits]) {
      if (p.value.charAt(e.start - 1) === "_") edits.push({ start: e.start - 1, end: e.start, insert: "-", priority: SEPARATOR_PRIORITY });
      if (p.value.charAt(e.end) === "_") edits.push({ start: e.end, end: e.end + 1, insert: "-", priority: SEPARATOR_PRIORITY });
    }
    const r = applyEdits(p.value, edits);
    applied += r.applied.filter((e) => e.priority !== SEPARATOR_PRIORITY).length;
    return { id: p.id, value: r.text };
  });

  const entityValue = (slot: EntitySlot | undefined): string | undefined => {
    if (slot === undefined) return undefined;
    if (slot.kept) return slot.value;
    const text = slot.placeholder ?? resolved.get(candidateKey({ kind: slot.kind, value: slot.value }));
    return text ?? slot.value;
  };
  const entities = plan.entities.map((e): TransformEntity => {
    const name = entityValue(e.name);
    const email = entityValue(e.email);
    return { ...(name !== undefined ? { name } : {}), ...(email !== undefined ? { email } : {}) };
  });
  return { ok: true, table, changed, parts, entities, applied };
}
