import type { Engine } from "../core/engine";
import type { MemoryTable } from "../core/memory-table";
import type { PluginState } from "../core/status";
import type { ApiError as PseudonymizerApiError, RestoreResult, TransformRequest, TransformResult } from "../vendor/kit/pseudonymizer-source";
import { findPlaceholders, placeholderIdFromBytes, restorePlaceholders, type RestoreResult as PlaceholderRestore } from "../vendor/kit/placeholder";
import { tableLookup, type PlaceholderTable } from "../vendor/kit/placeholder-table";
import { DEFAULT_SETTINGS, type RuleGroup } from "../core/settings";
import { applyPlan, decisionsOf, planTransform, uniqueCandidates, withMarks, markCandidates, type Answer, type Applied, type Candidate, type Mark, type PlanResult } from "../core/transform";
import type { PlaceRef, ReviewPart } from "../core/review-model";
import type { PersistResult, TableChange } from "./table-store";

/** Was die Engine vom Baustein der Gerätedateien braucht (`createTableStore`). */
export interface TableStorePort {
  refresh(): Promise<void>;
  persist(change?: TableChange): Promise<PersistResult>;
}

const NOT_READY: PseudonymizerApiError = { error: "not-ready", message: "the table is not set up" };
const LOCKED: PseudonymizerApiError = { error: "locked", message: "the table is locked" };

/** Ein bekannter Wert, der ohne Rückfrage ersetzt wird: der Wortlaut, wie er im Text stand, sein Platzhalter und die Stellen (für den Kopf des Prüffensters und die Ansicht des Textes). */
export interface KnownValue { value: string; placeholder: string; places: readonly PlaceRef[] }

/** Was das Prüffenster außer den Karten braucht. `places` sind ALLE Fundstellen (die Karten sind `uniqueCandidates`, je Wert eine); `parts` die Texte der Anfrage; `mark` liefert die Kandidaten zu Stellen,
 *  die der Nutzer von Hand markiert hat (dieselbe Funktion, mit der die Engine danach den Plan erweitert). */
export interface ReviewContext {
  documentKey: string;
  title?: string;
  table: PlaceholderTable;
  lang: "de" | "en";
  places: readonly Candidate[];
  parts: readonly ReviewPart[];
  known: readonly KnownValue[];
  mark(marks: readonly Mark[]): Candidate[];
}

/** Die Antwort des Prüffensters: die Antworten nach `candidateKey` und die von Hand markierten Stellen (deren Kandidaten die Engine selbst erzeugt). */
export interface ReviewResult { answers: ReadonlyMap<string, Answer>; marks?: readonly Mark[] }

/** Das Prüffenster (Aufgabe 14) als Stelle, die die Engine ruft, wenn offene Kandidaten da sind und `interactive` gilt: eine Karte je Wert (`uniqueCandidates`), die Antworten nach `candidateKey`;
 *  ein fehlender Schlüssel gilt als Vorgabe (ersetzen, Besitzer nur aus der Struktur). `null` heißt Abbruch: nichts wird geschrieben. */
export type ReviewFn = (candidates: Candidate[], ctx: ReviewContext) => Promise<ReviewResult | null>;

/** Was die Engine sonst braucht; alles hat eine Vorgabe, damit Tests nur nennen, was sie prüfen. */
export interface EngineOptions {
  /** Die eingeschalteten Regelgruppen, bei jedem Aufruf frisch gelesen (die Einstellungen ändern sich im Betrieb). */
  rules?: () => Record<RuleGroup, boolean>;
  /** Das Prüffenster; ohne es wird jeder offene Kandidat `deferred`. */
  review?: ReviewFn;
  /** Zufallsbytes für neue Kennungen; Vorgabe `crypto.getRandomValues`. Nur für Tests austauschbar. */
  random?: (length: number) => Uint8Array;
}

/** Die bekannten Werte des Plans, je Wortlaut einer, mit allen Stellen. */
function knownOf(plan: PlanResult): KnownValue[] {
  const out = new Map<string, { value: string; placeholder: string; places: PlaceRef[] }>();
  for (const e of plan.edits) {
    if (e.placeholder === null) continue;
    const had = out.get(e.value) ?? { value: e.value, placeholder: e.placeholder, places: [] };
    had.places.push({ partId: e.partId, start: e.start, end: e.end });
    out.set(e.value, had);
  }
  return [...out.values()];
}

const deferred = (count: number): PseudonymizerApiError => ({ error: "deferred", message: `${String(count)} value(s) need a decision` });
const CANCELLED: PseudonymizerApiError = { error: "cancelled", message: "the review was cancelled" };
const STORAGE_FAILED: PseudonymizerApiError = { error: "storage-failed", message: "the table could not be written" };

/** Das Kit liefert Platzhalter als Objekte mit Fundstelle, der Vertrag (Spec 8.7) nennt die Rohtexte, wie sie im Text standen. */
function toContract(r: PlaceholderRestore): RestoreResult {
  return { text: r.text, restored: r.restored, unknown: r.unknown.map((p) => p.raw), forgotten: r.forgotten.map((p) => p.raw) };
}

/** Die Maschine hinter der Plugin-API. Teil 1 (Aufgabe 9): Platzhalter erkennen und zurücksetzen, auf der Tabelle im Arbeitsspeicher.
 *  `transform` (Aufgabe 13) und das Öffnen der Gerätedateien (Aufgabe 11) folgen; bis dahin bleibt der Zustand `not-set-up`,
 *  außer eine Tabelle wird in `MemoryTable` eingesetzt (Tests). Meldungen nennen nie einen Text aus der Anfrage. */
export class PseudonymizerEngine implements Engine {
  /** `store` ist eine Funktion, weil das Plugin den Baustein neu anlegt, wenn der Ordner der Tabelle geändert wird; ohne Baustein bleibt der Zustand, wie er ist. */
  constructor(private readonly memory: MemoryTable, private readonly store: () => TableStorePort | null = () => null, private readonly options: EngineOptions = {}) {}

  state(): PluginState { return this.memory.state(); }

  /** Schreibt die Vereinigung aus dem frischen Stand und `change` in die eigene Gerätedatei (Aufgabe 11). Erst danach trägt der Arbeitsspeicher die Änderung. */
  persist(change?: TableChange): Promise<PersistResult> {
    const s = this.store();
    return s === null ? Promise.resolve({ error: "not-ready" }) : s.persist(change);
  }

  /** Liest alle Gerätedateien neu und vereinigt sie in den Arbeitsspeicher. */
  async refresh(): Promise<void> {
    await this.store()?.refresh();
  }

  /** `transform` (Spec 8.7), ohne Fenster: Zustand prüfen, planen, bei offenen Kandidaten `deferred` (unbeaufsichtigt, oder ohne Prüffenster) oder das Prüffenster fragen, dann neue Einträge in EINEM
   *  `persist` schreiben und erst danach das Ergebnis liefern. Scheitert das Schreiben, trägt auch die Tabelle im Arbeitsspeicher nichts davon (alles oder nichts, Review-Fokus 5).
   *  Die Form der Anfrage prüft die API (`api.ts`) vor dem Aufruf; die Engine verlässt sich darauf. */
  async transform(req: TransformRequest): Promise<TransformResult | PseudonymizerApiError> {
    const table = this.memory.table();
    if (table === null) return this.memory.state() === "locked" ? { ...LOCKED } : { ...NOT_READY };
    const rules = this.options.rules?.() ?? DEFAULT_SETTINGS.rules;
    const lang = this.memory.language();
    const plan = planTransform(req, table, decisionsOf(table), rules, lang);
    const random = this.options.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
    const newId = (): string => placeholderIdFromBytes(random(7)) ?? "";
    const done = (a: Applied): TransformResult | PseudonymizerApiError => (a.ok ? { parts: a.parts, entities: a.entities, applied: a.applied } : { ...STORAGE_FAILED });

    if (plan.candidates.length === 0) return done(applyPlan(req, plan, table, new Map(), newId, lang));

    // Offene Kandidaten: ohne Erlaubnis zu fragen bleibt alles, wie es ist.
    const review = this.options.review;
    if (!req.interactive || review === undefined) return deferred(uniqueCandidates(plan.candidates).length);
    const result = await review(uniqueCandidates(plan.candidates), {
      documentKey: req.documentKey,
      ...(req.title !== undefined ? { title: req.title } : {}),
      table,
      lang,
      places: plan.candidates,
      parts: req.parts,
      known: knownOf(plan),
      mark: (marks) => markCandidates(req, plan, marks),
    });
    if (result === null) return { ...CANCELLED };
    const answers = result.answers;
    // Von Hand markierte Stellen gehören ab hier zum Plan (derselbe Weg wie im Fenster, `markCandidates`).
    const full = withMarks(req, plan, result.marks ?? []);

    // Das Anlegen läuft in der Warteschlange auf dem frischen Stand: hat ein anderer Weg denselben Wert inzwischen angelegt, gilt dessen Kennung.
    let outcome: Applied | null = null;
    const res = await this.persist((current) => {
      outcome = applyPlan(req, full, current, answers, newId, lang);
      return outcome.ok ? outcome.table : current;
    });
    if (res !== undefined) {
      if (res.error === "storage-failed") return { ...STORAGE_FAILED };
      return res.error === "locked" ? { ...LOCKED } : { ...NOT_READY };
    }
    return outcome === null ? { ...STORAGE_FAILED } : done(outcome);
  }

  restore(text: string, _caller: string): RestoreResult | PseudonymizerApiError {
    const table = this.memory.table();
    if (table === null) return this.memory.state() === "locked" ? { ...LOCKED } : { ...NOT_READY };
    return toContract(restorePlaceholders(text, tableLookup(table)));
  }

  /** Eine Frage an den Text allein: sie braucht keine Tabelle und gilt auch, solange das Plugin gesperrt oder nicht eingerichtet ist. */
  containsPlaceholder(text: string): boolean { return findPlaceholders(text).length > 0; }
}
