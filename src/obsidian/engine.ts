import type { Engine } from "../core/engine";
import type { MemoryTable } from "../core/memory-table";
import type { PluginState } from "../core/status";
import type { ApiError as PseudonymizerApiError, RestoreResult, TransformRequest, TransformResult } from "../vendor/kit/pseudonymizer-source";
import { findPlaceholders, restorePlaceholders, type RestoreResult as PlaceholderRestore } from "../vendor/kit/placeholder";
import { tableLookup } from "../vendor/kit/placeholder-table";
import type { PersistResult, TableChange } from "./table-store";

/** Was die Engine vom Baustein der Gerätedateien braucht (`createTableStore`). */
export interface TableStorePort {
  refresh(): Promise<void>;
  persist(change?: TableChange): Promise<PersistResult>;
}

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
  /** `store` ist eine Funktion, weil das Plugin den Baustein neu anlegt, wenn der Ordner der Tabelle geändert wird; ohne Baustein bleibt der Zustand, wie er ist. */
  constructor(private readonly memory: MemoryTable, private readonly store: () => TableStorePort | null = () => null) {}

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
