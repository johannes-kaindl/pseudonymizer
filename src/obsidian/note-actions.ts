import { Notice } from "obsidian";
import { listPersons, type PersonOption } from "../core/forget-plan";
import type { MemoryTable } from "../core/memory-table";
import { rewriteNote, splitNote } from "../core/note-parts";
import { applyPlan, planSelection, type Answer, type Applied, type CandidateKind } from "../core/transform";
import { t } from "../vendor/kit/i18n";
import { editAtomic, readNoteText, swapNote } from "../vendor/kit/note-edit";
import type { WritePorts } from "../vendor/kit/block-writer";
import { findPlaceholders, placeholderIdFromBytes } from "../vendor/kit/placeholder";
import { PSEUDONYMIZER_PLUGIN_ID, type PseudonymizerApi } from "../vendor/kit/pseudonymizer-source";
import type { PersistResult, TableChange } from "./table-store";

/** Die Befehle „Auswahl pseudonymisieren“ und „Diese Notiz pseudonymisieren“ (Bauplan Aufgabe 15; Spec 8.9, 11.1, 11.2). Importiert `obsidian` nur für `Notice`; Fenster und Editor kommen als Stellvertreter herein,
 *  damit der Ablauf ohne Obsidian prüfbar ist (`tests/note-actions.test.ts`).
 *
 *  Auswahl: erst die Tabelle (`persist`), DANN die Notiz (`editAtomic`). Scheitert `persist`, bleibt die Notiz unverändert. Steht die Auswahl nicht mehr an ihrer Stelle (die Notiz hat sich während der Fragen geändert),
 *  wird nichts geschrieben und eine Notice sagt es. GRENZE: Der Tabelleneintrag ist dann schon geschrieben und bleibt; er ist harmlos (ein Eintrag ohne Fundstelle in einer Notiz), und ein zweiter Lauf findet ihn wieder.
 *
 *  Notiz: ein `transform` mit Prüffenster über den Text und alle Text-Eigenschaften, EIN neuer Gesamttext, EIN `swapNote` (nur wenn die Notiz inzwischen unverändert ist; kein Teilerfolg). Keine Schnappschüsse
 *  (Spec 11.1: ein Vorher-Schnappschuss läge im Klartext im Plugin-Ordner); die Umkehr ist Obsidians Rückgängig und der Dateiverlauf, und die Bestätigung sagt das. Eine Notiz mit `mail_id` gehört mailstone und
 *  wird nicht angefasst. GRENZE wie oben: scheitert das Schreiben der Notiz nach dem `transform`, bleiben dessen neue Einträge in der Tabelle.
 *  Eigenschaften, deren gelesener Wert nicht belegt der ganze Wert ist (verschachtelt, Fortsetzungszeile, Kommentar, Blockskalar; Beleg: Gleichheit mit dem `metadataCache`), werden ausgelassen und mit Namen gemeldet (B1).
 *  Kein Klartext in einer Notice oder `console`: Meldungen nennen höchstens Platzhalter und Zahlen. */

/** Die Auswahl im Editor, wie der Befehl sie festhält, bevor er etwas fragt: Pfad, Spanne (Zeichen im Text des Editors) und der gewählte Text. */
export interface SelectionInfo { path: string; from: number; to: number; text: string }

/** Wer die gewählte Person ist: ein neuer Eintrag (bei einem Namen eine neue Person oder Organisation nach der Art, sonst „gehört niemandem“) oder ein vorhandener. */
export type OwnerPick = { kind: "new" } | { kind: "entry"; id: string };

/** Die Stellen, an denen die Befehle die Oberfläche berühren. Der Klartext steht nur in diesen Fenstern, solange sie offen sind. */
export interface NoteUi {
  chooseKind(): Promise<CandidateKind | null>;
  chooseOwner(kind: CandidateKind, options: readonly PersonOption[]): Promise<OwnerPick | null>;
  notify(key: string, ...args: (string | number)[]): void;
}

/** Was die Befehle vom Plugin brauchen. */
export interface NoteHost {
  memory: MemoryTable;
  /** Die Plugin-API: der Befehl für die Notiz geht über `transform`, nicht an ihr vorbei. */
  api: Pick<PseudonymizerApi, "transform">;
  /** Schreibt die Vereinigung aus dem frischen Stand und `change` in die eigene Gerätedatei (Warteschlange des Bausteins der Gerätedateien). */
  persist(change: TableChange): Promise<PersistResult>;
  ports(): WritePorts;
  /** Die Auswahl im aktiven Editor; `null` ohne Editor. */
  selection(): SelectionInfo | null;
  /** Die aktive Markdown-Notiz; `null` ohne. */
  activeNote(): { path: string; name: string } | null;
  /** Der Frontmatter-Teil von Obsidians `metadataCache` für die Notiz (`null` ohne Eintrag). Belegt, welche Eigenschaften der Kit-Leser ganz liest (B1). */
  frontmatter(path: string): Readonly<Record<string, unknown>> | null;
  ui: NoteUi;
  changed(): void;
  /** Zufallsbytes für neue Kennungen; Vorgabe `crypto.getRandomValues`. Nur für Tests austauschbar. */
  random?: (length: number) => Uint8Array;
}

const NAME_KINDS: ReadonlySet<CandidateKind> = new Set<CandidateKind>(["person", "organisation"]);
const WORD = /[\p{L}\p{N}_]/u;

type Spot = { from: number; to: number; value: string };
type SpotCheck = "ok" | "moved" | "boundary" | "mail";

/** Steht der Wert noch an seiner Stelle, und grenzt er außen an kein Wortzeichen? (Ein Platzhalter, der an Buchstaben klebt, würde vom Rückweg nicht gefunden.) */
function checkSpot(text: string, spot: Spot): SpotCheck {
  // Eine Notiz mit `mail_id` gehört mailstone (Spec 8.9): die Nachrichtenzone wäre sonst ein Konflikt für mailstone (K4b).
  if (splitNote(text, null).mailNote) return "mail";
  if (text.slice(spot.from, spot.to) !== spot.value) return "moved";
  const before = [...text.slice(Math.max(0, spot.from - 2), spot.from)].pop();
  const after = spot.to < text.length ? String.fromCodePoint(text.codePointAt(spot.to) ?? 0) : undefined;
  return (before !== undefined && WORD.test(before)) || (after !== undefined && WORD.test(after)) ? "boundary" : "ok";
}

function spotNotice(c: Exclude<SpotCheck, "ok">): string {
  return c === "mail" ? "notice.note.mailstone" : c === "moved" ? "notice.selection.moved" : "notice.selection.boundary";
}

/** Die Auswahl ohne Leerraum an den Rändern, mit der Spanne des Rests. */
function trimmed(sel: SelectionInfo): Spot {
  const lead = sel.text.length - sel.text.trimStart().length;
  const value = sel.text.trim();
  return { from: sel.from + lead, to: sel.from + lead + value.length, value };
}

function sayWhyNoTable(h: NoteHost): void {
  h.ui.notify(h.memory.state() === "locked" ? "notice.locked" : "notice.notSetUp");
}

function answerOf(kind: CandidateKind, pick: OwnerPick): Answer {
  if (NAME_KINDS.has(kind)) return pick.kind === "entry" ? { action: "replace", entry: pick.id } : { action: "replace", carrier: kind === "organisation" ? "organisation" : "person" };
  return { action: "replace", owner: pick.kind === "entry" ? { entry: pick.id } : "nobody" };
}

/** Die Einträge, die für diese Art zur Wahl stehen: ein Name kann nur zu einer Person oder Organisation gehören (ein Eintrag ohne Namensträger hat keinen Namen), ein Wert zu jedem Eintrag. */
function ownersFor(kind: CandidateKind, options: readonly PersonOption[]): PersonOption[] {
  return NAME_KINDS.has(kind) ? options.filter((o) => o.kind !== "none") : [...options];
}

function persistFailed(h: NoteHost, error: "locked" | "not-ready" | "storage-failed", storageKey: string): void {
  h.ui.notify(error === "locked" ? "notice.locked" : error === "not-ready" ? "notice.notSetUp" : storageKey);
}

/** Befehl „Auswahl pseudonymisieren“ (Spec 8.9): fragt Art und Person, schreibt die Tabelle, dann die Notiz. */
export async function pseudonymizeSelection(h: NoteHost): Promise<void> {
  try {
    const table = h.memory.table();
    if (table === null) { sayWhyNoTable(h); return; }
    const sel = h.selection();
    const spot = sel === null ? null : trimmed(sel);
    if (sel === null || spot === null || spot.value === "") { h.ui.notify("notice.selection.empty"); return; }
    if (findPlaceholders(spot.value).length > 0) { h.ui.notify("notice.selection.placeholder"); return; }
    const ports = h.ports();
    // Vorab auf demselben Stand prüfen, auf dem `editAtomic` später entscheidet: kein Fragen für eine Auswahl, die nicht ersetzbar ist.
    const pre = checkSpot(await readNoteText(ports, sel.path), spot);
    if (pre !== "ok") { h.ui.notify(spotNotice(pre)); return; }

    const kind = await h.ui.chooseKind();
    if (kind === null) return;
    const pick = await h.ui.chooseOwner(kind, ownersFor(kind, listPersons(table, h.memory.language())));
    if (pick === null) return;

    // 1. Die Tabelle. Läuft in der Warteschlange auf dem frischen Stand: hat ein anderer Weg den Wert inzwischen angelegt, gilt dessen Platzhalter.
    const lang = h.memory.language();
    const random = h.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
    const newId = (): string => placeholderIdFromBytes(random(7)) ?? "";
    const { req, plan, key } = planSelection(spot.value, kind);
    const answers = new Map<string, Answer>([[key, answerOf(kind, pick)]]);
    let outcome: Applied | null = null;
    const res = await h.persist((current) => {
      outcome = applyPlan(req, plan, current, answers, newId, lang);
      return outcome.ok ? outcome.table : current;
    });
    if (res !== undefined) { persistFailed(h, res.error, "notice.selection.storage"); return; }
    const applied = outcome as Applied | null;
    const placeholder = applied !== null && applied.ok ? applied.parts[0]?.value : undefined;
    if (placeholder === undefined || placeholder === "") { h.ui.notify("notice.selection.storage"); return; }
    h.changed();

    // 2. Erst danach die Notiz, nur an der Stelle, an der die Auswahl noch steht.
    const r = await editAtomic<SpotCheck>(ports, sel.path, (text) => {
      const c = checkSpot(text, spot);
      return { outcome: c, next: c === "ok" ? text.slice(0, spot.from) + placeholder + text.slice(spot.to) : null };
    });
    if (r.kind === "error") { h.ui.notify("notice.failed"); return; }
    if (r.outcome === "ok") h.ui.notify("notice.selection.done", placeholder);
    else h.ui.notify(spotNotice(r.outcome));
  } catch {
    // Der Text einer Ausnahme könnte Klartext tragen: er bleibt weg.
    h.ui.notify("notice.failed");
  }
}

/** Befehl „Diese Notiz pseudonymisieren“ (Spec 8.9): Prüffenster über Text und Text-Eigenschaften, ein neuer Gesamttext, ein `swapNote`. */
export async function pseudonymizeNote(h: NoteHost): Promise<void> {
  try {
    if (h.memory.table() === null) { sayWhyNoTable(h); return; }
    const note = h.activeNote();
    if (note === null) { h.ui.notify("notice.copy.noNote"); return; }
    const ports = h.ports();
    // Der Stand, gegen den getauscht wird, kommt aus derselben Quelle, über die geschrieben wird (offener Editor zuerst).
    const before = await readNoteText(ports, note.path);
    const split = splitNote(before, h.frontmatter(note.path));
    const skippedNote = (): void => { if (split.skipped.length > 0) h.ui.notify("notice.note.skipped", split.skipped.join(", ")); };
    if (split.mailNote) { h.ui.notify("notice.note.mailstone"); return; }
    if (split.parts.length === 0) { h.ui.notify("notice.note.empty"); skippedNote(); return; }

    const result = await h.api.transform({ caller: PSEUDONYMIZER_PLUGIN_ID, documentKey: note.path, interactive: true, title: note.name, parts: split.parts });
    h.changed();
    if ("error" in result) {
      switch (result.error) {
        case "not-ready": h.ui.notify("notice.notSetUp"); break;
        case "locked": h.ui.notify("notice.locked"); break;
        case "cancelled": h.ui.notify("notice.note.cancelled"); break;
        case "deferred": h.ui.notify("notice.note.deferred"); break;
        case "storage-failed": h.ui.notify("notice.note.storage"); break;
        default: h.ui.notify("notice.failed");
      }
      return;
    }
    const next = rewriteNote(split, result.parts);
    if (!next.ok) { h.ui.notify("notice.note.properties"); return; }
    if (next.text === split.work) { h.ui.notify("notice.note.none"); skippedNote(); return; }
    const swapped = await swapNote(ports, note.path, before, next.text);
    switch (swapped.kind) {
      case "swapped": h.ui.notify("notice.note.done", result.applied); skippedNote(); break;
      case "same": h.ui.notify("notice.note.none"); skippedNote(); break;
      case "stale": h.ui.notify("notice.note.stale"); break;
      default: h.ui.notify("notice.note.writeFailed");
    }
  } catch {
    h.ui.notify("notice.failed");
  }
}

/** Meldungen als Notice (Vorgabe für `NoteUi.notify`). */
export function noticeNotify(key: string, ...args: (string | number)[]): void {
  new Notice(t(key, ...args));
}
