import type { Engine } from "../core/engine";
import type { MemoryTable } from "../core/memory-table";
import type { PluginState } from "../core/status";
import type { ApiError as PseudonymizerApiError, RestoreResult, TransformRequest, TransformResult } from "../vendor/kit/pseudonymizer-source";
import { findPlaceholders, restorePlaceholders, type RestoreResult as PlaceholderRestore } from "../vendor/kit/placeholder";
import { tableLookup } from "../vendor/kit/placeholder-table";

const NOT_READY: PseudonymizerApiError = { error: "not-ready", message: "the table is not set up" };
const LOCKED: PseudonymizerApiError = { error: "locked", message: "the table is locked" };

/** Das Kit liefert Platzhalter als Objekte mit Fundstelle, der Vertrag (Spec 8.7) nennt die Rohtexte, wie sie im Text standen. */
function toContract(r: PlaceholderRestore): RestoreResult {
  return { text: r.text, restored: r.restored, unknown: r.unknown.map((p) => p.raw), forgotten: r.forgotten.map((p) => p.raw) };
}

/** Die Maschine hinter der Plugin-API. Teil 1 (Aufgabe 9): Platzhalter erkennen und zurücksetzen, auf der Tabelle im Arbeitsspeicher.
 *  `transform` (Aufgabe 13) und das Öffnen der Gerätedateien (Aufgabe 11) folgen; bis dahin bleibt der Zustand `not-set-up`,
 *  außer eine Tabelle wird in `MemoryTable` eingesetzt (Tests). Meldungen nennen nie einen Text aus der Anfrage. */
export class PseudonymizerEngine implements Engine {
  constructor(private readonly memory: MemoryTable) {}

  state(): PluginState { return this.memory.state(); }

  transform(_req: TransformRequest): Promise<TransformResult | PseudonymizerApiError> {
    return Promise.resolve({ ...NOT_READY });
  }

  restore(text: string, _caller: string): RestoreResult | PseudonymizerApiError {
    const table = this.memory.table();
    if (table === null) return this.memory.state() === "locked" ? { ...LOCKED } : { ...NOT_READY };
    return toContract(restorePlaceholders(text, tableLookup(table)));
  }

  /** Eine Frage an den Text allein: sie braucht keine Tabelle und gilt auch, solange das Plugin gesperrt oder nicht eingerichtet ist. */
  containsPlaceholder(text: string): boolean { return findPlaceholders(text).length > 0; }
}
