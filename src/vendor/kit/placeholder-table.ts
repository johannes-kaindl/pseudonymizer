// vendored from code-kit@0.86.1, src/ts/pure/placeholder-table.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
// Origin: new in code-kit (Welle 36, kp2c, order 5 of the pseudonymizer design, spec sections 8.1 to 8.3, released by Johannes 2026-11-18 22:44). Builds on
// `placeholder.ts` (the grammar, `PlaceholderParts`, `PlaceholderResolution`, `restorePlaceholders`); it is the table behind the placeholders: who an ID
// belongs to, which values and spellings it stands for, what was forgotten.
//
// ONE IDEA: the table is a set of FACTS that only ever grow, and everything else is derived from them. Merging two versions is the union of the facts, so
// it is commutative, associative and idempotent by construction, and a device can write a complete version of what it knows (spec 8.2: "jede Fassung
// vollständig"). The facts:
//
//   entry   {id, kind, from}   an ID and what it belongs to: a person, an organisation, or nobody (`none`, a value without a carrier). `from` lists the
//                              ID a detached value came from. Entries are never removed: an ID is no personal data, and the marks and the cascade need it.
//   link    {a, b}             two entries a user merged on purpose.
//   value   {id, field, n, key, text}
//                              the slot (id, field, n) — the placeholder `Person_<id>_Telefon_2` — stands for the value `text`. `field` is `null` for the
//                              name. `key` is the normalized form (below) and part of the fact's identity; `text` is the original spelling (the smallest
//                              wins when two devices wrote the same form differently).
//   redirect {id, field, n, to} the value of that slot was detached (spec 8.1 rule 2): it belongs to the entry `to` now, which holds its own copy as
//                              (to, field, 1). A fact without a value, so it can stay when everything else of a forgotten entry goes.
//   mark    {ids, keep}        a forgotten entry: all its IDs, and the IDs of detached values that stay. Names are never in a mark.
//   exception / decision       a text the person wants left alone (everywhere / in one document), with a change counter. A decision has a random ID of
//                              its own (`sid`, drawn by the caller like an entry ID).
//   bind    {sid, anchor}      the decision `sid` concerns the entry `anchor`. A fact without a text, like `redirect`, and never removed: it is what lets every
//                              device drop the text of a decision when the entry is forgotten, in whatever order the versions meet (Welle 36, review E1).
//
// DERIVED, never stored: the forgotten set, the groups of entries, the look-ups.
//
//   Groups. Entries are one group when a link joins them or when they share a LIVE value (same field, same normalized form): two devices that created
//   the same new person at once end up as one group, and both IDs keep resolving (spec 8.2). A detached value no longer joins anything.
//   Forgotten. Every ID in a mark is forgotten, and so is every entry detached from a forgotten ID unless EVERY mark that covers the source lists it in
//   `keep` and the source is not itself forgotten through ITS source: a mark wins against a concurrent "detach" (spec 8.2). The set is derived from the
//   marks and the `from` links, which stay. (The last condition was found by the property test: without it a mark of another device that keeps a value
//   of an entry already forgotten through its source brought the value back, and the set did not only grow.)
//   Dropping. A value is dropped as soon as its `id` is forgotten, in every `finish`, so a merge with an older copy that still holds the value cannot
//   bring it back: a mark wins in every order. Nothing that is dropped leaves a trace except IDs. (Why the redirect is a fact of its own: with the target
//   inside the value, the owner of a value changed as versions were merged, and whether the value had been dropped by then depended on the order. The
//   property test found it.) A detached slot resolves through its redirect to the copy under the new ID, so a value that stays when its old person is
//   forgotten still comes back in the old notes; if the new entry is forgotten, so is the old slot.
//   Slots. A slot (id, field, n) with two different values (two devices added a second spelling at the same time) is a CONFLICT: it resolves to
//   nothing, never to a guess, and `tableConflicts` lists it. `tableAddValue` never reuses a conflicting slot.
//
//   Decisions. A decision is dropped as soon as ANY entry it is bound to is forgotten (monotone: the forgotten set and the binds only grow). It is bound to
//   the holders of its text when it is made, to the entry that gets the text later (`tableAddValue`), to the new entry when the value is detached, and by
//   the device that forgets, when the decision was bound to nobody (that device still knows the values). A decision on a device that never saw a bind
//   and a mark together keeps its text: a mark carries no names (pinned limit).
//   The caller's duty: after every reading of another device's version (`mergeTables`, `mergeAllTables`) it runs `tableBindDecisions` on the result, once, before it
//   writes the table. The union cannot bind (it would stop being associative); the device can, because decision and holder meet in ITS table. Without the call a
//   mark that arrives later does not take the decision. The call also makes a bound decision follow a redirect of its anchor when the copy at the target holds its
//   text (review round 2, R1: one device decided about a form of M while another detached that form to N; without it the name stayed after N was forgotten).
//   It does NOT bind to every holder of the text: that would take the decision of a person who stays when the other one is forgotten (review B7).
//   Detached slots. The values of a slot whose redirect leads to a forgotten entry are dropped too: the text of a detached value must not stay under its old
//   place. A slot that was detached AND holds two values (another device filled the same slot at the same time) is a conflict, like any slot with two values.
//
// Notes and decisions: the one with the higher change counter wins (the counter of an item is its highest seen value plus one, not the clock); at the
// same counter the removal wins, then the smaller text. So a concurrent edit errs on the side of pseudonymizing.
//
// Not in this module: the key, the encryption, the file (spec 8.2/8.3), the device list, the schema of `data.json`. No `crypto`, no I/O, no throw on
// user input: the operations return `{ ok: false, error }`, `parseTable` returns the reason. No regular expression with a nested quantifier; every
// operation is linear or n log n in the size of the table.
import { foldCase } from "./fold-case";
import { normalizePhone } from "./phone";
import {
  formatPlaceholder,
  isPlaceholderId,
  type PlaceholderCarrier,
  type PlaceholderField,
  type PlaceholderLookup,
  type PlaceholderParts,
  type PlaceholderResolution,
} from "./placeholder";

// ---- types ------------------------------------------------------------------------------------

/** What an ID belongs to: a person, an organisation, or nobody. */
export type EntryKind = PlaceholderCarrier | "none";

export interface TableEntry {
  readonly id: string;
  readonly kind: EntryKind;
  /** The IDs a detached value was split off from (sorted; empty for an entry nobody detached). One ID in practice; a list because two devices that draw
   *  the same new ID for different detachments (it cannot happen with random IDs, but a damaged file might) must still end in one table in every order. */
  readonly from: readonly string[];
}

export interface TableValue {
  readonly id: string;
  /** `null` is the name of a person or organisation. */
  readonly field: PlaceholderField | null;
  /** The slot number, 1 to 99: `Person_<id>_Telefon_2` is the slot (id, phone, 2). */
  readonly n: number;
  /** The normalized form ({@link normalizeTableValue}); the look-up key. */
  readonly key: string;
  /** The original spelling. */
  readonly text: string;
}

/** The value of the slot (id, field, n) was detached to the entry `to` (see the file header). */
export interface TableRedirect {
  readonly id: string;
  readonly field: PlaceholderField | null;
  readonly n: number;
  readonly to: string;
}

export interface ForgetMark {
  /** Every ID of the forgotten entry, sorted. */
  readonly ids: readonly string[];
  /** IDs of detached values that stay, sorted. */
  readonly keep: readonly string[];
}

/** An entry of the exception list: a text that stays as it is. `key` is its normalized form. */
export interface TableNote {
  readonly key: string;
  readonly text: string;
  readonly counter: number;
  readonly removed: boolean;
}

/** A decision for one document ("leave this in the clear in this mail"). A record is identified by its random `sid`, the document and the normalized form. What
 *  a decision means is, per (document, form), the record with the highest counter over all `sid`s (then the removal, the smaller text, the smaller `sid`).
 *  Which entries it concerns is not in the record but in the {@link TableBind}s: the text of the record is dropped as soon as one of them is forgotten. */
export interface DocumentNote extends TableNote {
  readonly sid: string;
  readonly doc: string;
}

/** The decision `sid` concerns the entry `anchor`. Holds no text, so it can stay when the text of a forgotten entry is gone. */
export type TableBind = readonly [sid: string, anchor: string];

/** The table. Plain data, deeply frozen, always in canonical order; build it only through this module's functions. */
export interface PlaceholderTable {
  readonly entries: readonly TableEntry[];
  readonly links: readonly (readonly [string, string])[];
  readonly values: readonly TableValue[];
  readonly redirects: readonly TableRedirect[];
  readonly marks: readonly ForgetMark[];
  readonly exceptions: readonly TableNote[];
  readonly decisions: readonly DocumentNote[];
  readonly binds: readonly TableBind[];
}

export type TableError =
  | "bad-id" //            not an ID of ten characters from the alphabet
  | "bad-carrier" //       neither person, organisation nor null
  | "bad-field" //         not one of the four fields nor null
  | "bad-input" //         a text, a document or a list of the wrong type
  | "id-taken" //          the ID is in use (for a new entry)
  | "unknown-entry" //     no such ID
  | "kind-mismatch" //     the ID exists with another kind
  | "forgotten" //         the entry was forgotten
  | "no-name" //           an entry without a carrier has no name
  | "empty-value" //       nothing left after normalizing
  | "slots-full" //        the field already holds 99 values
  | "same-entry" //        a link from an ID to itself
  | "not-found" //         no such slot
  | "conflict" //          the slot holds two values
  | "detached" //          the value was detached already
  | "bad-keep"; //         a `keep` ID that was not detached from this entry

export type TableResult<T = unknown> = ({ readonly ok: true; readonly table: PlaceholderTable } & T) | { readonly ok: false; readonly error: TableError };

export type ParseFailure = "syntax" | "format" | "version" | "shape" | "reference";
export type ParseResult = { readonly ok: true; readonly table: PlaceholderTable } | { readonly ok: false; readonly error: ParseFailure; readonly path: string };

/** What a table shows of one ID (and the entries joined with it). */
export interface EntryView {
  readonly id: string;
  readonly kind: EntryKind;
  /** The IDs of the group that are not forgotten, sorted; contains `id`. */
  readonly ids: readonly string[];
  readonly forgotten: boolean;
  /** The values of the group, by field and slot, each with the placeholder that stands for it. */
  readonly values: readonly { readonly value: TableValue; readonly placeholder: PlaceholderParts; /** the slot holds two values: the placeholder resolves to neither */ readonly conflict: boolean }[];
}

const FIELDS: readonly PlaceholderField[] = ["mail", "phone", "address", "iban"];
const FIELD_ORDER = new Map<string, number>([["", 0], ["mail", 1], ["phone", 2], ["address", 3], ["iban", 4]]);
const KIND_RANK: Readonly<Record<EntryKind, number>> = { none: 0, organisation: 1, person: 2 };
const FORMAT = "placeholder-table";
const VERSION = 2; // 1 (code-kit 0.82.0): decisions with an anchor each, no binds; read as "version", never half
const MAX_N = 99;

// ---- normalizing ------------------------------------------------------------------------------

const BLANKS = /\s+/gu;

/** The form in which two spellings of one value are the same value, per field (spec 8.1 "Schreibweisen"; look-ups go through it):
 *  name and address: case-folded (NFC), runs of white space become one blank, trimmed; mail: trimmed and case-folded; phone: `normalizePhone`
 *  (`+49…`), or, below six digits, the digits and plus signs behind a `~`; IBAN: no white space, upper case. `""` when nothing is left (such a value
 *  is refused). Linear. */
export function normalizeTableValue(field: PlaceholderField | null, text: string): string {
  if (typeof text !== "string") return "";
  switch (field) {
    case null:
    case "address":
      return foldCase(text).replace(BLANKS, " ").trim();
    case "mail":
      return foldCase(text).trim();
    case "phone": {
      const n = normalizePhone(text);
      if (n !== null) return n;
      const rest = text.replace(/[^\d+]/gu, "");
      return rest === "" ? "" : `~${rest}`;
    }
    case "iban":
      return text.replace(BLANKS, "").toUpperCase();
    default:
      return "";
  }
}

// ---- the draft: facts in maps, with the join rules ---------------------------------------------

interface Draft {
  entries: Map<string, TableEntry>;
  links: Map<string, readonly [string, string]>;
  values: Map<string, TableValue>;
  redirects: Map<string, TableRedirect>;
  marks: Map<string, ForgetMark>;
  exceptions: Map<string, TableNote>;
  decisions: Map<string, DocumentNote>;
  binds: Map<string, TableBind>;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list === undefined) m.set(k, [v]);
  else list.push(v);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const valueKey = (v: { id: string; field: PlaceholderField | null; n: number; key: string }): string => `${v.id}|${v.field ?? ""}|${v.n}|${v.key}`;
const slotKey = (id: string, field: PlaceholderField | null, n: number): string => `${id}|${field ?? ""}|${n}`;
const formKey = (field: PlaceholderField | null, key: string): string => `${field ?? ""}|${key}`;
const linkKey = (a: string, b: string): string => `${a}|${b}`;
const markKey = (m: ForgetMark): string => JSON.stringify([m.ids, m.keep]);
const decisionKey = (sid: string, doc: string, key: string): string => JSON.stringify([sid, doc, key]);
const bindKey = (sid: string, anchor: string): string => `${sid}|${anchor}`;

function emptyDraft(): Draft {
  return { entries: new Map(), links: new Map(), values: new Map(), redirects: new Map(), marks: new Map(), exceptions: new Map(), decisions: new Map(), binds: new Map() };
}

const NO_SOURCES: readonly string[] = Object.freeze([]);

function mkEntry(id: string, kind: EntryKind, from: readonly string[]): TableEntry {
  return Object.freeze({ id, kind, from: from.length === 0 ? NO_SOURCES : Object.freeze([...new Set(from)].sort(cmp)) });
}

function joinEntry(a: TableEntry | undefined, b: TableEntry): TableEntry {
  if (a === undefined) return b;
  const kind = KIND_RANK[a.kind] >= KIND_RANK[b.kind] ? a.kind : b.kind;
  const from = [...new Set([...a.from, ...b.from])].sort(cmp);
  const sameFrom = (e: TableEntry): boolean => e.from.length === from.length && e.from.every((f, i) => f === from[i]);
  return kind === a.kind && sameFrom(a) ? a : kind === b.kind && sameFrom(b) ? b : mkEntry(a.id, kind, from);
}

const redirectKey = (r: { id: string; field: PlaceholderField | null; n: number; to: string }): string => `${slotKey(r.id, r.field, r.n)}|${r.to}`;

function mkRedirect(id: string, field: PlaceholderField | null, n: number, to: string): TableRedirect {
  return Object.freeze({ id, field, n, to });
}

function mkValue(id: string, field: PlaceholderField | null, n: number, key: string, text: string): TableValue {
  return Object.freeze({ id, field, n, key, text });
}

function joinValue(a: TableValue | undefined, b: TableValue): TableValue {
  if (a === undefined) return b;
  return a.text <= b.text ? a : b;
}

/** The note that wins: the higher counter, then the removal, then the smaller text. A total order, so the choice does not depend on the order of the join. */
function winner<T extends TableNote>(a: T | undefined, b: T): T {
  if (a === undefined) return b;
  if (a.counter !== b.counter) return a.counter > b.counter ? a : b;
  if (a.removed !== b.removed) return a.removed ? a : b;
  return a.text <= b.text ? a : b;
}

/** Like {@link winner}, and at last the smaller `sid`: records of different lineages for one (document, form) must have a total order too. */
function docWinner(a: DocumentNote | undefined, b: DocumentNote): DocumentNote {
  if (a === undefined) return b;
  if (a.counter !== b.counter || a.removed !== b.removed || a.text !== b.text) return winner(a, b);
  return a.sid <= b.sid ? a : b;
}

function mkNote(key: string, text: string, counter: number, removed: boolean): TableNote {
  return Object.freeze({ key, text, counter, removed });
}

function mkDocNote(sid: string, doc: string, key: string, text: string, counter: number, removed: boolean): DocumentNote {
  return Object.freeze({ sid, doc, key, text, counter, removed });
}

function addBind(d: Draft, sid: string, anchor: string): void {
  if (!d.binds.has(bindKey(sid, anchor))) d.binds.set(bindKey(sid, anchor), Object.freeze([sid, anchor] as const));
}

function mkMark(ids: Iterable<string>, keep: Iterable<string>): ForgetMark {
  const sorted = (x: Iterable<string>): readonly string[] => Object.freeze([...new Set(x)].sort(cmp));
  return Object.freeze({ ids: sorted(ids), keep: sorted(keep) });
}

/** Joins the facts of `t` into `d`. */
function joinInto(d: Draft, t: PlaceholderTable): void {
  for (const e of t.entries) d.entries.set(e.id, joinEntry(d.entries.get(e.id), e));
  for (const [x, y] of t.links) {
    const [a, b] = x <= y ? [x, y] : [y, x];
    if (!d.links.has(linkKey(a, b))) d.links.set(linkKey(a, b), Object.freeze([a, b] as const));
  }
  for (const v of t.values) {
    const k = valueKey(v);
    d.values.set(k, joinValue(d.values.get(k), v));
  }
  for (const r of t.redirects) d.redirects.set(redirectKey(r), r);
  for (const m of t.marks) {
    const k = markKey(m);
    if (!d.marks.has(k)) d.marks.set(k, m);
  }
  for (const n of t.exceptions) d.exceptions.set(n.key, winner(d.exceptions.get(n.key), n));
  for (const n of t.decisions) {
    const k = decisionKey(n.sid, n.doc, n.key);
    d.decisions.set(k, winner(d.decisions.get(k), n));
  }
  for (const [sid, anchor] of t.binds) addBind(d, sid, anchor);
}

/** The IDs that are forgotten: every ID in a mark, and every entry detached from a forgotten one, unless the mark of that source keeps it. A mark keeps a
 *  detached entry only when the source is forgotten BY THAT MARK ALONE (the source is in a mark and was not itself forgotten through its own source) and
 *  EVERY mark that covers the source lists the entry. The last conditions make the set only grow as marks and links arrive, in any order: a mark of
 *  another device that "keeps" a value of an entry that is forgotten through its source anyway must not bring the value back. The least fixpoint of
 *  that rule, by a worklist; linear in the entries and the sources. */
function forgottenOf(entries: ReadonlyMap<string, TableEntry>, marks: Iterable<ForgetMark>): Set<string> {
  const covering = new Map<string, Set<string>[]>();
  for (const m of marks) {
    const keep = new Set(m.keep);
    for (const id of m.ids) push(covering, id, keep);
  }
  const children = new Map<string, TableEntry[]>();
  for (const e of entries.values()) for (const source of e.from) push(children, source, e);
  const forgotten = new Set<string>(covering.keys());
  const cascaded = new Set<string>();
  const kept = (source: string, child: string): boolean => {
    const covers = covering.get(source);
    return covers !== undefined && !cascaded.has(source) && covers.every((k) => k.has(child));
  };
  const queue = [...forgotten];
  for (let s = queue.pop(); s !== undefined; s = queue.pop()) {
    for (const y of children.get(s) ?? []) {
      if (cascaded.has(y.id) || !y.from.some((source) => forgotten.has(source) && !kept(source, y.id))) continue;
      cascaded.add(y.id);
      forgotten.add(y.id);
      queue.push(y.id);
    }
  }
  return forgotten;
}

function sortedValues<T>(m: ReadonlyMap<string, T>): readonly T[] {
  const keys = [...m.keys()].sort(cmp);
  return Object.freeze(keys.map((k) => m.get(k) as T));
}

/** The slots whose value was detached to a forgotten entry, each with the forgotten entry it ends at (review E2). A value that was detached again follows the
 *  copy: the slot (M, f, n) leads to N, whose copy (N, f, 1) leads to the forgotten O, so BOTH slots are gone, and the text stays under neither (review round 2,
 *  chain M to N to O). A worklist over the reverse links, so every slot enters once: linear, and a cycle in a hand-written file cannot loop. */
function goneSlotsOf(redirects: Iterable<TableRedirect>, forgotten: ReadonlySet<string>): Map<string, string> {
  const gone = new Map<string, string>();
  const viaCopy = new Map<string, TableRedirect[]>(); // slot of the copy -> the redirects whose copy it is
  const queue: string[] = [];
  for (const r of redirects) {
    push(viaCopy, slotKey(r.to, r.field, 1), r);
    if (forgotten.has(r.to)) {
      const k = slotKey(r.id, r.field, r.n);
      if (!gone.has(k)) { gone.set(k, r.to); queue.push(k); }
    }
  }
  for (let k = queue.pop(); k !== undefined; k = queue.pop()) {
    const owner = gone.get(k) as string;
    for (const r of viaCopy.get(k) ?? []) {
      const up = slotKey(r.id, r.field, r.n);
      if (gone.has(up)) continue;
      gone.set(up, owner);
      queue.push(up);
    }
  }
  return gone;
}

/** Drops what a mark forgets and writes the canonical, frozen table. Every function that returns a table ends here. */
function finish(d: Draft): PlaceholderTable {
  const forgotten = forgottenOf(d.entries, d.marks.values());
  const values = new Map<string, TableValue>();
  // the slots whose value was detached to an entry that is forgotten: the text stays nowhere (review E2)
  const goneSlots = goneSlotsOf(d.redirects.values(), forgotten);
  for (const [k, v] of d.values) if (!forgotten.has(v.id) && !goneSlots.has(slotKey(v.id, v.field, v.n))) values.set(k, v);
  // a decision dies with any entry it is bound to (review E1); the binds stay
  const dead = new Set<string>();
  for (const [sid, anchor] of d.binds.values()) if (forgotten.has(anchor)) dead.add(sid);
  const decisions = new Map<string, DocumentNote>();
  for (const [k, n] of d.decisions) if (!dead.has(n.sid)) decisions.set(k, n);
  return Object.freeze({
    entries: sortedValues(d.entries),
    links: sortedValues(d.links),
    values: sortedValues(values),
    redirects: sortedValues(d.redirects),
    marks: sortedValues(d.marks),
    exceptions: sortedValues(d.exceptions),
    decisions: sortedValues(decisions),
    binds: sortedValues(d.binds),
  });
}

function draftOf(t: PlaceholderTable): Draft {
  const d = emptyDraft();
  joinInto(d, t);
  return d;
}

const EMPTY: PlaceholderTable = finish(emptyDraft());

/** The table with nothing in it. */
export function emptyTable(): PlaceholderTable {
  return EMPTY;
}

// ---- merging ----------------------------------------------------------------------------------

/** The union of two versions: entries, links, values and marks of both; of two notes the winner; then whatever a mark forgets is dropped. Commutative,
 *  associative and idempotent; the result is the canonical form, so `serializeTable` of equal knowledge is equal text. **Caller's duty:** when the other version
 *  comes from another device, run {@link tableBindDecisions} on the result before writing it, or a mark that arrives later does not take the decisions. */
export function mergeTables(a: PlaceholderTable, b: PlaceholderTable): PlaceholderTable {
  const d = draftOf(a);
  joinInto(d, b);
  return finish(d);
}

/** The union of any number of versions (`mergeTables` folded); the empty list gives the empty table. Same duty as {@link mergeTables}: after reading the versions of
 *  other devices, run {@link tableBindDecisions} on the result before writing it. */
export function mergeAllTables(tables: readonly PlaceholderTable[]): PlaceholderTable {
  const d = emptyDraft();
  for (const t of tables) joinInto(d, t);
  return finish(d);
}

// ---- the index: what is derived ---------------------------------------------------------------

interface Index {
  readonly forgotten: ReadonlySet<string>;
  readonly entries: ReadonlyMap<string, TableEntry>;
  /** Every value (live or detached) by slot. */
  readonly slots: ReadonlyMap<string, readonly TableValue[]>;
  /** The targets a slot was detached to; a slot in here no longer shows its value as the entry's. */
  readonly redirects: ReadonlyMap<string, readonly string[]>;
  /** Live values (their slot is not detached) by (field, normalized form). */
  readonly forms: () => ReadonlyMap<string, readonly TableValue[]>;
  /** The group of every ID, forgotten ones included, sorted. */
  readonly group: () => ReadonlyMap<string, readonly string[]>;
  /** The most recent slot number given out per (id, field), over live and detached values. */
  readonly top: () => ReadonlyMap<string, number>;
}

const INDEX = new WeakMap<PlaceholderTable, Index>();

/** Computes `make` on the first call only. The index is built for every look-up table, and a look-up (the way back, `restorePlaceholders`) needs the slots
 *  and the forgotten set, not the forms, the groups or the slot tops: building them all made reading a table of 50 000 entries allocate about twice what
 *  it had to, and the time (not the number of steps) grew faster than n log n. */
function lazy<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

function indexOf(t: PlaceholderTable): Index {
  const cached = INDEX.get(t);
  if (cached !== undefined) return cached;
  const entries = new Map<string, TableEntry>();
  for (const e of t.entries) entries.set(e.id, e);
  const slots = new Map<string, TableValue[]>();
  const redirects = new Map<string, string[]>();
  for (const r of t.redirects) push(redirects, slotKey(r.id, r.field, r.n), r.to);
  for (const v of t.values) push(slots, slotKey(v.id, v.field, v.n), v);
  const forms = lazy(() => {
    const out = new Map<string, TableValue[]>();
    for (const v of t.values) if (!redirects.has(slotKey(v.id, v.field, v.n))) push(out, formKey(v.field, v.key), v);
    return out;
  });
  const top = lazy(() => {
    const out = new Map<string, number>();
    for (const v of t.values) {
      const tk = `${v.id}|${v.field ?? ""}`;
      if (v.n > (out.get(tk) ?? 0)) out.set(tk, v.n);
    }
    // a detached slot whose text was dropped (its new entry was forgotten) still counts: the number is never given out twice
    for (const r of t.redirects) {
      const tk = `${r.id}|${r.field ?? ""}`;
      if (r.n > (out.get(tk) ?? 0)) out.set(tk, r.n);
    }
    return out;
  });
  const group = lazy(() => {
    // only the entries that a link or a shared form joins are in here; the others are their own group and callers fall back to `[id]`
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      for (let p = parent.get(root); p !== undefined && p !== root; p = parent.get(root)) root = p;
      for (let cur = x; cur !== root; ) {
        const next = parent.get(cur) ?? root;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };
    const union = (a: string, b: string): void => {
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    };
    for (const [a, b] of t.links) if (entries.has(a) && entries.has(b)) union(a, b);
    for (const list of forms().values()) {
      const first = list[0];
      if (first === undefined || list.length < 2 || !entries.has(first.id)) continue;
      for (const v of list) if (entries.has(v.id)) union(first.id, v.id);
    }
    const members = new Map<string, string[]>();
    for (const id of parent.keys()) push(members, find(id), id);
    const out = new Map<string, readonly string[]>();
    for (const list of members.values()) {
      const sorted = Object.freeze([...list].sort(cmp));
      for (const id of sorted) out.set(id, sorted);
    }
    return out;
  });
  const idx: Index = { forgotten: forgottenOf(entries, t.marks), entries, slots, redirects, forms, group, top };
  INDEX.set(t, idx);
  return idx;
}

const carrierOf = (kind: EntryKind): PlaceholderCarrier | null => (kind === "none" ? null : kind);

function partsOf(idx: Index, v: TableValue): PlaceholderParts {
  return { carrier: carrierOf(idx.entries.get(v.id)?.kind ?? "none"), id: v.id, field: v.field, n: v.n };
}

/** The values of `list` whose slot holds nothing else, so the placeholder is unambiguous, smallest ID and slot first. */
function usable(idx: Index, list: readonly TableValue[] | undefined, within?: readonly string[]): TableValue[] {
  const out: TableValue[] = [];
  for (const v of list ?? []) {
    if (idx.slots.get(slotKey(v.id, v.field, v.n))?.length !== 1) continue;
    if (within !== undefined && !within.includes(v.id)) continue;
    out.push(v);
  }
  return out.sort((a, b) => cmp(a.id, b.id) || a.n - b.n);
}

// ---- look-ups ---------------------------------------------------------------------------------

/** The detailed answer of a look-up: what {@link resolveTablePlaceholder} turns into `undefined` keeps its reason, so a view can show a conflict and a
 *  consumer can tell "never issued" from "two devices wrote two values here". */
export type TableLookup =
  | { readonly status: "known"; readonly value: string }
  | { readonly status: "forgotten" }
  | { readonly status: "conflict"; readonly values: readonly string[] }
  | { readonly status: "unknown"; readonly reason: "no-entry" | "carrier" | "no-slot" };

function detailIn(idx: Index, p: PlaceholderParts): TableLookup {
  const entry = idx.entries.get(p.id);
  if (entry === undefined) return { status: "unknown", reason: "no-entry" };
  if (entry.kind !== (p.carrier ?? "none") || (p.carrier === null && p.field === null)) return { status: "unknown", reason: "carrier" };
  const slot = slotKey(p.id, p.field, p.n);
  const targets = idx.redirects.get(slot);
  const own = idx.slots.get(slot);
  // detached AND filled again: another device put a value into the old place while this one moved the old value away. Which one the placeholder means is
  // not known, so it is a conflict and never the value of the detached copy (review E3)
  if (targets !== undefined && own !== undefined && own.length > 1) return { status: "conflict", values: own.map((v) => v.text).sort(cmp) };
  if (targets !== undefined) {
    // detached: the value is the copy under the new ID(s); forgotten as soon as one of them is, known when they agree
    const texts = new Set<string>();
    for (const to of targets) {
      if (idx.forgotten.has(to)) return { status: "forgotten" };
      for (const v of idx.slots.get(slotKey(to, p.field, 1)) ?? []) texts.add(v.text);
    }
    if (texts.size === 0) return { status: "unknown", reason: "no-slot" };
    const only = [...texts][0];
    return texts.size === 1 && only !== undefined ? { status: "known", value: only } : { status: "conflict", values: [...texts].sort(cmp) };
  }
  const hit = idx.slots.get(slot);
  if (hit === undefined || hit.length === 0) return idx.forgotten.has(p.id) ? { status: "forgotten" } : { status: "unknown", reason: "no-slot" };
  const only = hit[0];
  if (hit.length !== 1 || only === undefined) return { status: "conflict", values: hit.map((v) => v.text).sort(cmp) };
  return { status: "known", value: only.text };
}

function lookupIn(idx: Index, p: PlaceholderParts): PlaceholderResolution | undefined {
  const r = detailIn(idx, p);
  return r.status === "known" || r.status === "forgotten" ? r : undefined;
}

/** The detailed look-up: `known`, `forgotten`, `conflict` (the slot holds two different values; both stay in the table, the placeholder resolves to neither,
 *  and for {@link restorePlaceholders} it is unknown, so no consumer puts one of them into a text) or `unknown` with the reason. */
export function lookupTablePlaceholder(table: PlaceholderTable, parts: PlaceholderParts): TableLookup {
  return detailIn(indexOf(table), parts);
}

/** What the table says about one placeholder: `known` with the original spelling, `forgotten`, or `undefined` for one it never issued, one whose carrier
 *  does not fit its ID, and one whose slot is in conflict (a guess would put a wrong value into a text). A detached value keeps resolving under its old
 *  placeholder. */
export function resolveTablePlaceholder(table: PlaceholderTable, parts: PlaceholderParts): PlaceholderResolution | undefined {
  return lookupIn(indexOf(table), parts);
}

/** The look-up for {@link restorePlaceholders}; the index is built once. */
export function tableLookup(table: PlaceholderTable): PlaceholderLookup {
  const idx = indexOf(table);
  return (p) => lookupIn(idx, p);
}

/** The placeholder for a value that is in the table, or `undefined`. The value is read in its normalized form for `field` (`null` is the name), so
 *  "MAX@Example.org " finds `max@example.org`. Several IDs of a group stand for it: the smallest ID and slot with an unambiguous slot is taken. */
export function tableFindValue(table: PlaceholderTable, field: PlaceholderField | null, text: string): PlaceholderParts | undefined {
  const key = normalizeTableValue(field, text);
  if (key === "") return undefined;
  const idx = indexOf(table);
  const first = usable(idx, idx.forms().get(formKey(field, key)))[0];
  return first === undefined ? undefined : partsOf(idx, first);
}

/** What the table shows of `id` and the entries joined with it, or `undefined` for an ID it does not know. A forgotten ID shows no values. */
export function tableEntry(table: PlaceholderTable, id: string): EntryView | undefined {
  const idx = indexOf(table);
  const entry = idx.entries.get(id);
  if (entry === undefined) return undefined;
  const forgotten = idx.forgotten.has(id);
  const ids = (idx.group().get(id) ?? [id]).filter((x) => !idx.forgotten.has(x));
  const values: { value: TableValue; placeholder: PlaceholderParts; conflict: boolean }[] = [];
  if (!forgotten) {
    for (const v of table.values) {
      if (!ids.includes(v.id)) continue;
      const slot = slotKey(v.id, v.field, v.n);
      const conflict = (idx.slots.get(slot)?.length ?? 0) > 1;
      // a detached slot is not the entry's value any more, unless it was filled again and now holds two (then both are shown, as a conflict)
      if (!idx.redirects.has(slot) || conflict) values.push({ value: v, placeholder: partsOf(idx, v), conflict });
    }
  }
  values.sort((a, b) => (FIELD_ORDER.get(a.value.field ?? "") ?? 0) - (FIELD_ORDER.get(b.value.field ?? "") ?? 0) || cmp(a.value.id, b.value.id) || a.value.n - b.value.n);
  return { id, kind: entry.kind, ids, forgotten, values };
}

/** The groups of entries that are not forgotten, each as sorted IDs, ordered by the smallest ID. */
export function tableGroups(table: PlaceholderTable): readonly (readonly string[])[] {
  const idx = indexOf(table);
  const seen = new Set<string>();
  const out: (readonly string[])[] = [];
  for (const e of table.entries) {
    if (seen.has(e.id) || idx.forgotten.has(e.id)) continue;
    const ids = (idx.group().get(e.id) ?? [e.id]).filter((x) => !idx.forgotten.has(x));
    for (const x of ids) seen.add(x);
    out.push(ids);
  }
  return out;
}

/** Every forgotten ID, sorted (marks and the cascade). */
export function tableForgotten(table: PlaceholderTable): readonly string[] {
  return [...indexOf(table).forgotten].sort(cmp);
}

/** The slots that hold two different values: a placeholder there resolves to nothing. */
export function tableConflicts(table: PlaceholderTable): readonly { readonly id: string; readonly field: PlaceholderField | null; readonly n: number; readonly values: readonly string[] }[] {
  const out: { id: string; field: PlaceholderField | null; n: number; values: string[] }[] = [];
  for (const list of indexOf(table).slots.values()) {
    const first = list[0];
    if (first === undefined || list.length < 2) continue;
    out.push({ id: first.id, field: first.field, n: first.n, values: list.map((v) => v.text).sort(cmp) });
  }
  return out.sort((a, b) => cmp(a.id, b.id) || (FIELD_ORDER.get(a.field ?? "") ?? 0) - (FIELD_ORDER.get(b.field ?? "") ?? 0) || a.n - b.n);
}

// ---- operations -------------------------------------------------------------------------------

function ok<T extends object>(d: Draft, extra: T): { readonly ok: true; readonly table: PlaceholderTable } & T {
  return { ok: true, table: tableBindDecisions(finish(d)), ...extra };
}

/** Binds every decision that nothing is bound to yet to the entries that hold its text (see `TableBind`), and returns the table unchanged when there is nothing to bind.
 *  The union of two versions cannot do this: a bind made at the moment a decision meets a holder would depend on whether a mark had dropped the holder's value
 *  by then, so the union would stop being associative. A device can: the decision and the holder meet in ITS table, and the bind is a true fact about it. Every
 *  operation of this module ends here; after a merge (reading another device's version) the caller runs it once, before it writes the table, so that a mark that
 *  arrives later takes the decision too. A decision that is bound already follows a redirect of its anchor when the copy at the target holds its text, a chain of
 *  redirects to its end (review round 2, R1); it is never bound to a holder it did not come from. */
export function tableBindDecisions(table: PlaceholderTable): PlaceholderTable {
  if (table.decisions.length === 0) return table;
  const bound = new Set(table.binds.map((b) => b[0]));
  const idx = indexOf(table);
  let d: Draft | undefined;
  for (const n of table.decisions) {
    if (bound.has(n.sid)) continue;
    for (const holder of holdersOf(idx, n.text)) {
      d ??= draftOf(table);
      addBind(d, n.sid, holder);
    }
  }
  // A bound decision follows a redirect of its anchor when the copy at the target holds its text (review round 2, R1): one device decided about a form of M while
  // another detached that form to N, and neither bound the decision to N. Index: the anchors of a decision, and per source entry the targets by form of the copy.
  const followers = table.redirects.length === 0 ? undefined : followersOf(idx, table.redirects);
  if (followers !== undefined) {
    const anchorsOf = new Map<string, string[]>();
    for (const [sid, anchor] of table.binds) push(anchorsOf, sid, anchor);
    for (const n of table.decisions) {
      const anchors = anchorsOf.get(n.sid);
      if (anchors === undefined) continue;
      const seen = new Set(anchors);
      const forms = [null, ...FIELDS].map((field) => [field, normalizeTableValue(field, n.text)] as const);
      for (const anchor of anchors) { // the loop sees what is pushed below: a chain is followed to its end
        const byForm = followers.get(anchor);
        if (byForm === undefined) continue;
        for (const [field, key] of forms) {
          if (key === "") continue;
          for (const to of byForm.get(formKey(field, key)) ?? []) {
            if (seen.has(to)) continue;
            seen.add(to);
            anchors.push(to);
            d ??= draftOf(table);
            addBind(d, n.sid, to);
          }
        }
      }
    }
  }
  return d === undefined ? table : finish(d);
}

/** Per source entry of a redirect: the targets whose copy (to, field, 1) holds a value, by form. A copy that a mark dropped is not in the index, so it is not here. */
function followersOf(idx: Index, redirects: readonly TableRedirect[]): Map<string, Map<string, string[]>> {
  const out = new Map<string, Map<string, string[]>>();
  for (const r of redirects) {
    for (const v of idx.slots.get(slotKey(r.to, r.field, 1)) ?? []) {
      let byForm = out.get(r.id);
      if (byForm === undefined) out.set(r.id, (byForm = new Map<string, string[]>()));
      push(byForm, formKey(r.field, v.key), r.to);
    }
  }
  return out;
}

const fail = (error: TableError): { readonly ok: false; readonly error: TableError } => ({ ok: false, error });

function validField(field: unknown): field is PlaceholderField | null {
  return field === null || (typeof field === "string" && (FIELDS as readonly string[]).includes(field));
}

/** Adds an entry with a new ID (draw the ID with {@link placeholderIdFromBytes}); the same ID with the same carrier again changes nothing. `carrier`
 *  `null` is an entry without a carrier. */
export function tableAddEntry(table: PlaceholderTable, id: string, carrier: PlaceholderCarrier | null): TableResult {
  if (!isPlaceholderId(id)) return fail("bad-id");
  if (carrier !== null && carrier !== "person" && carrier !== "organisation") return fail("bad-carrier");
  const kind: EntryKind = carrier ?? "none";
  const had = table.entries.find((e) => e.id === id);
  if (had !== undefined) return had.kind === kind ? { ok: true, table } : fail("kind-mismatch");
  const d = draftOf(table);
  d.entries.set(id, mkEntry(id, kind, []));
  return ok(d, {});
}

/** Puts a value into an entry and says which placeholder stands for it. `field` `null` is the name. If the same form is in the entry's group already,
 *  nothing is added and that placeholder comes back (`created: false`). A form that exists only in another group is added under `id`, which joins the
 *  groups (spec 8.2: the same form in two entries is one entry). The slot is the next free one of (id, field); a slot number is never given out twice. */
export function tableAddValue(
  table: PlaceholderTable,
  input: { readonly id: string; readonly field: PlaceholderField | null; readonly text: string },
): TableResult<{ readonly placeholder: PlaceholderParts; readonly created: boolean }> {
  const { id, field, text } = input;
  if (!isPlaceholderId(id)) return fail("bad-id");
  if (!validField(field)) return fail("bad-field");
  if (typeof text !== "string") return fail("bad-input");
  const idx = indexOf(table);
  const entry = idx.entries.get(id);
  if (entry === undefined) return fail("unknown-entry");
  if (idx.forgotten.has(id)) return fail("forgotten");
  if (field === null && entry.kind === "none") return fail("no-name");
  const key = normalizeTableValue(field, text);
  if (key === "") return fail("empty-value");
  const group = idx.group().get(id) ?? [id];
  const existing = usable(idx, idx.forms().get(formKey(field, key)), group).sort((a, b) => Number(b.id === id) - Number(a.id === id) || cmp(a.id, b.id) || a.n - b.n)[0];
  if (existing !== undefined) return { ok: true, table, placeholder: partsOf(idx, existing), created: false };
  const n = (idx.top().get(`${id}|${field ?? ""}`) ?? 0) + 1;
  if (n > MAX_N) return fail("slots-full");
  const d = draftOf(table);
  const v = mkValue(id, field, n, key, text);
  d.values.set(valueKey(v), v);
  // a decision made before this value was in the table concerns this entry from now on: `tableBindDecisions` at the end binds it (a decision that is bound to
  // somebody else already is that entry's decision and stays so: binding it here too would let forgetting THIS entry take the other one's decision, review B7)
  return { ok: true, table: tableBindDecisions(finish(d)), placeholder: { carrier: carrierOf(entry.kind), id, field, n }, created: true };
}

/** Joins two entries on purpose (they stay one group; both IDs keep resolving, nothing in the notes changes). */
export function tableLinkEntries(table: PlaceholderTable, a: string, b: string): TableResult {
  if (!isPlaceholderId(a) || !isPlaceholderId(b)) return fail("bad-id");
  if (a === b) return fail("same-entry");
  const idx = indexOf(table);
  if (!idx.entries.has(a) || !idx.entries.has(b)) return fail("unknown-entry");
  if (idx.forgotten.has(a) || idx.forgotten.has(b)) return fail("forgotten");
  const d = draftOf(table);
  const [x, y] = a < b ? [a, b] : [b, a];
  d.links.set(linkKey(x, y), Object.freeze([x, y] as const));
  return ok(d, {});
}

/** Detaches a wrongly assigned value from its entry (spec 8.1 rule 2): the value becomes an entry of its own under `newId` (without a carrier, except a
 *  name, which keeps the kind), the old placeholder keeps resolving, and the old entry, its display and its forgetting leave the value alone. Nothing in
 *  the notes is rewritten. The slot must hold exactly this one live value. */
export function tableDetachValue(
  table: PlaceholderTable,
  input: { readonly id: string; readonly field: PlaceholderField | null; readonly n: number; readonly newId: string },
): TableResult<{ readonly placeholder: PlaceholderParts }> {
  const { id, field, n, newId } = input;
  if (!isPlaceholderId(id) || !isPlaceholderId(newId)) return fail("bad-id");
  if (!validField(field)) return fail("bad-field");
  const idx = indexOf(table);
  const entry = idx.entries.get(id);
  if (entry === undefined) return fail("unknown-entry");
  if (idx.forgotten.has(id)) return fail("forgotten");
  if (idx.entries.has(newId)) return fail("id-taken");
  const hit = idx.slots.get(slotKey(id, field, n));
  if (hit === undefined || hit.length === 0) return fail("not-found");
  const only = hit[0];
  if (hit.length !== 1 || only === undefined) return fail("conflict");
  if (idx.redirects.has(slotKey(id, field, n))) return fail("detached");
  const kind: EntryKind = field === null ? entry.kind : "none";
  const d = draftOf(table);
  const redirect = mkRedirect(id, field, n, newId);
  d.redirects.set(redirectKey(redirect), redirect);
  d.entries.set(newId, mkEntry(newId, kind, [id]));
  const fresh = mkValue(newId, field, 1, only.key, only.text);
  d.values.set(valueKey(fresh), fresh);
  // the decisions about this text that concern the old entry concern the new one too: forgetting either takes them (review E1; the same rest as in E2)
  const textKey = normalizeTableValue(null, only.text);
  const bound = new Set(table.binds.filter((b) => b[1] === id).map((b) => b[0]));
  for (const n of table.decisions) if (n.key === textKey && bound.has(n.sid)) addBind(d, n.sid, newId);
  return ok(d, { placeholder: { carrier: carrierOf(kind), id: newId, field, n: 1 } });
}

/** Forgets an entry with every ID of its group: one mark, the values dropped. `keep` lists the detached values (their IDs) that stay; by default every
 *  value detached from the group stays, because it was detached to stay. Forgotten already: nothing changes. */
export function tableForget(table: PlaceholderTable, id: string, options: { readonly keep?: readonly string[] } = {}): TableResult<{ readonly forgotten: readonly string[] }> {
  if (!isPlaceholderId(id)) return fail("bad-id");
  const idx = indexOf(table);
  if (!idx.entries.has(id)) return fail("unknown-entry");
  if (idx.forgotten.has(id)) return { ok: true, table, forgotten: [] };
  const ids = idx.group().get(id) ?? [id];
  const children = table.entries.filter((e) => e.from.some((f) => ids.includes(f)) && !ids.includes(e.id) && !idx.forgotten.has(e.id)).map((e) => e.id);
  let keep: readonly string[] = children;
  const asked: unknown = options.keep;
  if (asked !== undefined) {
    if (!Array.isArray(asked) || asked.some((k) => typeof k !== "string" || !children.includes(k))) return fail("bad-keep");
    keep = asked as string[];
  }
  const d = draftOf(table);
  const m = mkMark(ids, keep);
  d.marks.set(markKey(m), m);
  let next = finish(d);
  // this device still knows the values that are dropped now: a decision about the same text that is bound to NOBODY (it was made before the person was known and
  // nothing bound it, or the value arrived through a merge) is bound to the forgotten entry now, so every device drops it. One that is bound to a living entry
  // stays: it is that entry's decision, whatever its text is called elsewhere.
  const goneBy = new Map<string, string>(); // normalized text of a dropped value -> the smallest forgotten ID it stood for
  const kept = new Set(next.values.map((v) => valueKey(v)));
  const forgottenNow = new Set(tableForgotten(next));
  const detachedTo = new Map<string, string>(); // slot -> the forgotten entry its value was detached to
  for (const r of next.redirects) if (forgottenNow.has(r.to)) detachedTo.set(slotKey(r.id, r.field, r.n), r.to);
  for (const v of table.values) {
    if (kept.has(valueKey(v))) continue;
    const owner = forgottenNow.has(v.id) ? v.id : detachedTo.get(slotKey(v.id, v.field, v.n));
    if (owner === undefined) continue;
    const k = normalizeTableValue(null, v.text);
    const had = goneBy.get(k);
    if (had === undefined || owner < had) goneBy.set(k, owner);
  }
  const bound = new Set(next.binds.map((b) => b[0]));
  const stale = next.decisions.filter((n) => goneBy.has(n.key) && !bound.has(n.sid));
  if (stale.length > 0) {
    const cleaned = draftOf(next);
    for (const n of stale) addBind(cleaned, n.sid, goneBy.get(n.key) as string);
    next = finish(cleaned);
  }
  next = tableBindDecisions(next);
  return { ok: true, table: next, forgotten: tableForgotten(next).filter((x) => !idx.forgotten.has(x)) };
}

function setNote(table: PlaceholderTable, text: string, present: boolean): TableResult {
  const key = normalizeTableValue(null, text);
  if (key === "") return fail("empty-value");
  const had = table.exceptions.find((n) => n.key === key);
  if (had === undefined ? !present : had.removed === !present) return { ok: true, table };
  const d = draftOf(table);
  d.exceptions.set(key, mkNote(key, text, (had?.counter ?? 0) + 1, !present));
  return ok(d, {});
}

/** Puts a text on the exception list (`present`) or takes it off. The change counts one up; a text that is in the state asked for changes nothing. The
 *  text is read as a name (case and blanks do not matter). */
export function tableSetException(table: PlaceholderTable, text: string, present: boolean): TableResult {
  return typeof text === "string" && typeof present === "boolean" ? setNote(table, text, present) : fail("bad-input");
}

/** The IDs of the entries that hold `text` as a live value: as a name, or as a mail, phone, address or IBAN. */
function holdersOf(idx: Index, text: string): string[] {
  const out = new Set<string>();
  for (const field of [null, ...FIELDS]) {
    const key = normalizeTableValue(field, text);
    if (key !== "") for (const v of idx.forms().get(formKey(field, key)) ?? []) out.add(v.id);
  }
  return [...out];
}

/** Records (`plain`) or revokes the decision to leave a text in the clear in one document. `doc` is whatever the caller calls a document; the text is read
 *  as a name. A new decision needs `options.id`, a fresh ID the caller drew (like an entry ID; this module never invents randomness): `bad-id` when it is
 *  missing, `id-taken` when a decision or a bind uses it already. A decision that exists is changed under its own ID, `id` is not read then. The decision
 *  is bound to the entries that hold the text (see `TableBind`), so it goes with them. */
export function tableSetPlain(table: PlaceholderTable, doc: string, text: string, plain: boolean, options: { readonly id?: string } = {}): TableResult {
  if (typeof doc !== "string" || doc === "" || typeof text !== "string" || typeof plain !== "boolean") return fail("bad-input");
  const key = normalizeTableValue(null, text);
  if (key === "") return fail("empty-value");
  const current = table.decisions.filter((n) => n.doc === doc && n.key === key).reduce<DocumentNote | undefined>((best, n) => docWinner(best, n), undefined);
  if (current === undefined && !plain) return { ok: true, table };
  const changed = current === undefined || current.removed === plain; // the state asked for differs from the one that stands
  if (!changed) return { ok: true, table }; // the state asked for stands already
  let sid: string;
  if (current !== undefined) sid = current.sid;
  else {
    const asked: unknown = options?.id;
    if (typeof asked !== "string" || !isPlaceholderId(asked)) return fail("bad-id");
    sid = asked;
    if (table.binds.some((b) => b[0] === sid) || table.decisions.some((n) => n.sid === sid)) return fail("id-taken");
  }
  const d = draftOf(table);
  d.decisions.set(decisionKey(sid, doc, key), mkDocNote(sid, doc, key, text, (current?.counter ?? 0) + 1, !plain));
  return ok(d, {}); // `ok` binds a decision that nothing is bound to yet to the holders of its text, a revoked one too: it still holds the text
}

/** The texts on the exception list, by normalized form. */
export function tableExceptions(table: PlaceholderTable): readonly string[] {
  return table.exceptions.filter((n) => !n.removed).map((n) => n.text);
}

/** Whether `text` is on the exception list. */
export function tableIsException(table: PlaceholderTable, text: string): boolean {
  const key = normalizeTableValue(null, text);
  return key !== "" && table.exceptions.some((n) => n.key === key && !n.removed);
}

/** Whether the decision "leave `text` in the clear in `doc`" stands. */
export function tableIsPlain(table: PlaceholderTable, doc: string, text: string): boolean {
  const key = normalizeTableValue(null, text);
  if (key === "") return false;
  const current = table.decisions.filter((n) => n.doc === doc && n.key === key).reduce<DocumentNote | undefined>((best, n) => docWinner(best, n), undefined);
  return current !== undefined && !current.removed;
}

/** The placeholder text of `parts`, German words (a convenience for display; see {@link formatPlaceholder}). */
export function tablePlaceholderText(parts: PlaceholderParts, lang: "de" | "en" = "de"): string | null {
  return formatPlaceholder(parts, lang);
}

// ---- serializing ------------------------------------------------------------------------------

/** The table as text (JSON, canonical order, no keys: they are computed again on reading). Equal knowledge gives equal text. The caller encrypts it. */
export function serializeTable(table: PlaceholderTable): string {
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    entries: table.entries.map((e) => ({ id: e.id, kind: e.kind, from: e.from })),
    links: table.links.map((l) => [l[0], l[1]]),
    values: table.values.map((v) => ({ id: v.id, field: v.field, n: v.n, text: v.text })),
    redirects: table.redirects.map((r) => ({ id: r.id, field: r.field, n: r.n, to: r.to })),
    marks: table.marks.map((m) => ({ ids: m.ids, keep: m.keep })),
    exceptions: table.exceptions.map((n) => ({ text: n.text, counter: n.counter, removed: n.removed })),
    decisions: table.decisions.map((n) => ({ id: n.sid, doc: n.doc, text: n.text, counter: n.counter, removed: n.removed })),
    binds: table.binds.map((b) => ({ decision: b[0], anchor: b[1] })),
  });
}

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const isId = (x: unknown): x is string => typeof x === "string" && isPlaceholderId(x);
const isCounter = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 1;

class Bad extends Error {
  constructor(readonly failure: ParseFailure, readonly path: string) {
    super(path);
  }
}

function list(o: Json, name: string): unknown[] {
  const v = o[name];
  if (!Array.isArray(v)) throw new Bad("shape", name);
  return v;
}

/** Reads a table written by {@link serializeTable}. Every field is checked, and a file that does not fit is refused with the reason and the place,
 *  never half read: wrong format or version, a missing field, an ID that is no ID, a value or link or mark of an ID with no entry. What the marks forget
 *  is dropped on reading (a mark wins), so the result may be smaller than the text. */
export function parseTable(text: string): ParseResult {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { ok: false, error: "syntax", path: "" };
  }
  try {
    if (!isObj(root) || root.format !== FORMAT) throw new Bad("format", "format");
    if (root.version !== VERSION) throw new Bad("version", "version");
    const d = emptyDraft();
    list(root, "entries").forEach((x, i) => {
      if (!isObj(x) || !isId(x.id) || !(x.kind === "person" || x.kind === "organisation" || x.kind === "none")) throw new Bad("shape", `entries[${i}]`);
      if (!Array.isArray(x.from) || x.from.some((f) => !isId(f) || f === x.id)) throw new Bad("shape", `entries[${i}].from`);
      d.entries.set(x.id, joinEntry(d.entries.get(x.id), mkEntry(x.id, x.kind, x.from as string[])));
    });
    const known = (id: string, path: string): void => {
      if (!d.entries.has(id)) throw new Bad("reference", path);
    };
    for (const e of d.entries.values()) for (const f of e.from) known(f, `entries.${e.id}.from`);
    list(root, "links").forEach((x, i) => {
      if (!Array.isArray(x) || x.length !== 2 || !isId(x[0]) || !isId(x[1]) || x[0] === x[1]) throw new Bad("shape", `links[${i}]`);
      known(x[0], `links[${i}]`);
      known(x[1], `links[${i}]`);
      const [a, b] = x[0] < x[1] ? [x[0], x[1]] : [x[1], x[0]];
      d.links.set(linkKey(a, b), Object.freeze([a, b] as const));
    });
    list(root, "values").forEach((x, i) => {
      if (!isObj(x) || !isId(x.id) || !validField(x.field) || typeof x.n !== "number" || !Number.isInteger(x.n) || x.n < 1 || x.n > MAX_N || typeof x.text !== "string") throw new Bad("shape", `values[${i}]`);
      const entry = d.entries.get(x.id);
      if (entry === undefined) throw new Bad("reference", `values[${i}].id`);
      const key = normalizeTableValue(x.field, x.text);
      if (key === "" || (x.field === null && entry.kind === "none")) throw new Bad("shape", `values[${i}]`);
      const v = mkValue(x.id, x.field, x.n, key, x.text);
      d.values.set(valueKey(v), joinValue(d.values.get(valueKey(v)), v));
    });
    list(root, "redirects").forEach((x, i) => {
      if (!isObj(x) || !isId(x.id) || !isId(x.to) || x.to === x.id || !validField(x.field) || typeof x.n !== "number" || !Number.isInteger(x.n) || x.n < 1 || x.n > MAX_N) throw new Bad("shape", `redirects[${i}]`);
      known(x.id, `redirects[${i}].id`);
      if (d.entries.get(x.to)?.from.includes(x.id) !== true) throw new Bad("reference", `redirects[${i}].to`);
      const r = mkRedirect(x.id, x.field, x.n, x.to);
      d.redirects.set(redirectKey(r), r);
    });
    list(root, "marks").forEach((x, i) => {
      if (!isObj(x) || !Array.isArray(x.ids) || !Array.isArray(x.keep) || x.ids.length === 0) throw new Bad("shape", `marks[${i}]`);
      const ids: string[] = [];
      const keep: string[] = [];
      for (const [src, dst] of [[x.ids, ids], [x.keep, keep]] as const) {
        for (const id of src) {
          if (!isId(id)) throw new Bad("shape", `marks[${i}]`);
          known(id, `marks[${i}]`);
          dst.push(id);
        }
      }
      const m = mkMark(ids, keep);
      d.marks.set(markKey(m), m);
    });
    list(root, "exceptions").forEach((x, i) => {
      if (!isObj(x) || typeof x.text !== "string" || !isCounter(x.counter) || typeof x.removed !== "boolean") throw new Bad("shape", `exceptions[${i}]`);
      const key = normalizeTableValue(null, x.text);
      if (key === "") throw new Bad("shape", `exceptions[${i}]`);
      d.exceptions.set(key, winner(d.exceptions.get(key), mkNote(key, x.text, x.counter, x.removed)));
    });
    list(root, "decisions").forEach((x, i) => {
      if (!isObj(x) || !isId(x.id) || typeof x.doc !== "string" || x.doc === "" || typeof x.text !== "string" || !isCounter(x.counter) || typeof x.removed !== "boolean") throw new Bad("shape", `decisions[${i}]`);
      const key = normalizeTableValue(null, x.text);
      if (key === "") throw new Bad("shape", `decisions[${i}]`);
      const k = decisionKey(x.id, x.doc, key);
      d.decisions.set(k, winner(d.decisions.get(k), mkDocNote(x.id, x.doc, key, x.text, x.counter, x.removed)));
    });
    list(root, "binds").forEach((x, i) => {
      if (!isObj(x) || !isId(x.decision) || !isId(x.anchor)) throw new Bad("shape", `binds[${i}]`);
      known(x.anchor, `binds[${i}].anchor`);
      addBind(d, x.decision, x.anchor);
    });
    return { ok: true, table: finish(d) };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, error: e.failure, path: e.path };
    throw e;
  }
}
