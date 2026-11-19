import { formatPlaceholder, parsePlaceholder, type PlaceholderField } from "../vendor/kit/placeholder";
import {
  lookupTablePlaceholder,
  normalizeTableValue,
  tableEntry,
  tableGroups,
  type EntryKind,
  type PlaceholderTable,
} from "../vendor/kit/placeholder-table";
import type { PlaceholderLanguage } from "./payload";

/** Eine Form eines Eintrags, wie die Nachschlage-Ansicht sie zeigt. `conflict`: der Platz trägt zwei Werte, beide stehen als eigene Zeilen da. */
export interface LookupForm { placeholder: string; field: PlaceholderField | null; value: string; conflict: boolean }

export type UnknownReason = "no-entry" | "carrier" | "no-slot";

/** Was „Platzhalter nachschlagen“ (Spec 8.9) über einen Platzhalter weiß. Nie ein Fehler, immer ein Wert; `placeholder` ist der Text, wie er gefragt wurde. */
export type LookupOutcome =
  | { status: "invalid" }
  | { status: "known"; placeholder: string; value: string; kind: EntryKind; field: PlaceholderField | null; forms: readonly LookupForm[] }
  | { status: "forgotten"; placeholder: string }
  | { status: "unknown"; placeholder: string; reason: UnknownReason }
  | { status: "conflict"; placeholder: string; values: readonly string[]; kind: EntryKind; field: PlaceholderField | null; forms: readonly LookupForm[] };

/** Die Formen des Eintrags, zu dem `id` gehört (samt zusammengeführter Einträge), mit Platzhaltern in der Sprache des Vaults. */
function formsOf(table: PlaceholderTable, id: string, lang: PlaceholderLanguage): { kind: EntryKind; forms: LookupForm[] } | null {
  const view = tableEntry(table, id);
  if (view === undefined) return null;
  const forms: LookupForm[] = [];
  for (const v of view.values) {
    const placeholder = formatPlaceholder(v.placeholder, lang);
    if (placeholder !== null) forms.push({ placeholder, field: v.value.field, value: v.value.text, conflict: v.conflict });
  }
  return { kind: view.kind, forms };
}

/** Schlägt einen ganzen Platzhalter in der Tabelle nach. Ein Konflikt zeigt beide Werte und bevorzugt keinen; vergessen und unbekannt nennen
 *  keinen Wert. Text, der als Ganzes kein Platzhalter ist (auch `Person_<id>_Mailbox`), ist `invalid`. */
export function lookupOutcome(table: PlaceholderTable, text: string, lang: PlaceholderLanguage): LookupOutcome {
  const parts = parsePlaceholder(text);
  if (parts === null) return { status: "invalid" };
  const found = lookupTablePlaceholder(table, parts);
  switch (found.status) {
    case "forgotten":
      return { status: "forgotten", placeholder: text };
    case "unknown":
      return { status: "unknown", placeholder: text, reason: found.reason };
    case "known": {
      const entry = formsOf(table, parts.id, lang);
      return { status: "known", placeholder: text, value: found.value, kind: entry?.kind ?? "none", field: parts.field, forms: entry?.forms ?? [] };
    }
    case "conflict": {
      const entry = formsOf(table, parts.id, lang);
      return { status: "conflict", placeholder: text, values: found.values, kind: entry?.kind ?? "none", field: parts.field, forms: entry?.forms ?? [] };
    }
  }
}

/** Was „Suchen mit Klarnamen“ an Obsidians Suche übergibt: die Kennungen aller zusammengeführten Einträge und die Suchanfrage daraus. */
export interface SearchPlan { ids: readonly string[]; query: string }

/** Die Anfrage für Obsidians Suche zu einem Namen (oder einem anderen Wert): `"<id>" OR "<id>"` über alle zusammengeführten Einträge, deren Formen
 *  den Wert tragen. Gelesen wird der Wert wie das Feld ihn liest (Groß und Klein, Leerraum, Schreibweise der Nummer), ganze Formen, keine Teile.
 *  Eine Kennung trifft alle Platzhalter des Eintrags samt Feldern, der Suchindex bleibt frei von Klartext. `null`: nichts gefunden, auch für Vergessene. */
export function searchPlan(table: PlaceholderTable, input: string): SearchPlan | null {
  if (input.trim() === "") return null;
  const ids = new Set<string>();
  for (const group of tableGroups(table)) {
    const first = group[0];
    const view = first === undefined ? undefined : tableEntry(table, first);
    if (view === undefined) continue;
    if (view.values.some((v) => normalizeTableValue(v.value.field, input) === v.value.key)) for (const id of view.ids) ids.add(id);
  }
  if (ids.size === 0) return null;
  const sorted = [...ids].sort();
  return { ids: sorted, query: sorted.map((id) => `"${id}"`).join(" OR ") };
}
