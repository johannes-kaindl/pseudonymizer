// Die Handlungen der Ansicht Personen und Ausnahmen (Bauplan Aufgabe 18; Spec 8.1 Leitplanke 2, 8.2, 8.9): zusammenführen, Wert abhängen, vergessen, Ausnahme hinzufügen und entfernen.
//
// Jede Änderung der Tabelle geht in EINEM `persist` durch die Warteschlange des Bausteins der Gerätedateien (frischer Stand, alles oder nichts); scheitert das Schreiben, trägt die Tabelle nichts davon und
// eine Meldung ohne Klartext sagt es. Vergessen ist KEIN zweiter Ablauf: die Ansicht startet `runForget` mit dem Eintrag. Dieser Baustein importiert nichts aus `obsidian`; die Fenster kommen als `PersonsUi`.
// Keine Meldung nennt einen Namen, Wert oder Platzhalter-Klartext.

import type { MemoryTable } from "../core/memory-table";
import { listPersons, type ForgetValue, type PersonOption } from "../core/forget-plan";
import { placeholderIdFromBytes, type PlaceholderParts } from "../vendor/kit/placeholder";
import { tableDetachValue, tableExceptions, tableIsException, tableLinkEntries, tableSetException, type PlaceholderTable, type TableError } from "../vendor/kit/placeholder-table";
import type { PersistResult, TableChange } from "./table-store";

/** Die Fenster der Handlungen. Der Obsidian-Anschluss steht in `persons-ui.ts`. */
export interface PersonsUi {
  /** Wählt den Eintrag, mit dem `from` zusammengeführt wird; `null` heißt Abbrechen. */
  choosePartner(from: PersonOption, options: readonly PersonOption[]): Promise<string | null>;
  /** Fragt vor dem Zusammenführen (es lässt sich in Version 1 nicht wieder trennen); `false` heißt Abbrechen. */
  confirmMerge(a: PersonOption, b: PersonOption): Promise<boolean>;
  /** Fragt vor dem Abhängen eines Wertes; `false` heißt Abbrechen. */
  confirmDetach(from: PersonOption, value: ForgetValue): Promise<boolean>;
  /** Fragt nach dem Text für die Ausnahmeliste; `null` heißt Abbrechen. */
  askException(): Promise<string | null>;
  /** Eine Meldung (Textschlüssel aus `strings.ts`); der Anschluss macht daraus eine Notice. */
  notify(key: string, ...args: (string | number)[]): void;
}

export interface PersonsHost {
  memory: Pick<MemoryTable, "table" | "language" | "state">;
  /** Schreibt die Vereinigung aus dem frischen Stand und `change` in die eigene Gerätedatei. */
  persist(change: TableChange): Promise<PersistResult>;
  /** Startet den Ablauf „Person vergessen“ mit diesem Eintrag vorgewählt (`runForget`). */
  forget(id: string): Promise<void>;
  ui: PersonsUi;
  /** Sagt Statusleiste und Ansicht, dass sich etwas geändert hat. */
  changed(): void;
  /** Zufallsbytes für neue Kennungen; Vorgabe `crypto.getRandomValues`. Nur für Tests austauschbar. */
  random?: (length: number) => Uint8Array;
}

/** Was die Ansicht von den Handlungen braucht. */
export interface PersonsApi {
  /** Die Einträge der Tabelle; leer, solange das Plugin nicht bereit ist. */
  list(): PersonOption[];
  /** Die Ausnahmeliste, nach Text sortiert. */
  exceptions(): string[];
  merge(id: string): Promise<void>;
  detach(id: string, slot: PlaceholderParts): Promise<void>;
  forget(id: string): Promise<void>;
  addException(): Promise<void>;
  removeException(text: string): Promise<void>;
}

/** Schreibt eine Änderung und meldet ein Scheitern. `storageKey` ist die Meldung für „Datei nicht schreibbar“ dieser Handlung. Ergebnis: ob geschrieben ist. Die Funktion `build` läuft auf dem frischen Stand
 *  in der Warteschlange und liefert die neue Tabelle oder den Fehler des Kits (dann bleibt der Stand, wie er ist, und der Fehler geht an `failKey`). */
async function write(h: PersonsHost, build: (current: PlaceholderTable) => { ok: true; table: PlaceholderTable } | { ok: false; error: TableError }, storageKey: string, failKey: (e: TableError) => string): Promise<boolean> {
  let failed: TableError | null = null;
  const res = await h.persist((current) => {
    const r = build(current);
    if (r.ok) return r.table;
    failed = r.error;
    return current;
  });
  h.changed();
  if (res !== undefined) {
    h.ui.notify(res.error === "locked" ? "notice.locked" : res.error === "not-ready" ? "notice.notSetUp" : storageKey);
    return false;
  }
  const error = failed as TableError | null;
  if (error !== null) { h.ui.notify(failKey(error)); return false; }
  return true;
}

function sayWhyNoTable(h: PersonsHost): void {
  h.ui.notify(h.memory.state() === "locked" ? "notice.locked" : "notice.notSetUp");
}

const mergeFailKey = (e: TableError): string => (e === "unknown-entry" || e === "forgotten" ? "notice.persons.gone" : "notice.persons.failed");
const detachFailKey = (e: TableError): string => (e === "unknown-entry" || e === "forgotten" || e === "not-found" ? "notice.persons.gone" : e === "detached" ? "notice.persons.alreadyDetached" : e === "conflict" ? "notice.persons.conflict" : "notice.persons.failed");

export function createPersonsApi(h: PersonsHost): PersonsApi {
  const optionOf = (table: PlaceholderTable, id: string): PersonOption | undefined => listPersons(table, h.memory.language()).find((o) => o.ids.includes(id));
  const newId = (): string => placeholderIdFromBytes((h.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n))))(7)) ?? "";

  return {
    list: () => {
      const table = h.memory.table();
      return table === null ? [] : listPersons(table, h.memory.language());
    },
    exceptions: () => {
      const table = h.memory.table();
      return table === null ? [] : [...tableExceptions(table)].sort((a, b) => a.localeCompare(b));
    },

    async merge(id) {
      const table = h.memory.table();
      if (table === null) { sayWhyNoTable(h); return; }
      const from = optionOf(table, id);
      if (from === undefined) { h.ui.notify("notice.persons.gone"); return; }
      const others = listPersons(table, h.memory.language()).filter((o) => o.id !== from.id);
      if (others.length === 0) { h.ui.notify("notice.persons.mergeNone"); return; }
      const pick = await h.ui.choosePartner(from, others);
      if (pick === null) return;
      // Der Stand kann sich während der Wahl geändert haben: beide Einträge werden frisch gesucht.
      const now = h.memory.table();
      const a = now === null ? undefined : optionOf(now, from.id);
      const b = now === null ? undefined : optionOf(now, pick);
      if (a === undefined || b === undefined) { h.ui.notify("notice.persons.gone"); return; }
      if (a.id === b.id) { h.ui.notify("notice.persons.alreadyMerged"); return; }
      if (!(await h.ui.confirmMerge(a, b))) return;
      // Beide IDs gelten danach weiter; in den Notizen wird nichts umgeschrieben (Spec 8.1).
      const ok = await write(h, (current) => tableLinkEntries(current, a.id, b.id), "notice.persons.storage", mergeFailKey);
      if (ok) h.ui.notify("notice.persons.merged");
    },

    async detach(id, slot) {
      const table = h.memory.table();
      if (table === null) { sayWhyNoTable(h); return; }
      const from = optionOf(table, id);
      const value = from?.values.find((v) => v.parts.id === slot.id && v.parts.field === slot.field && v.parts.n === slot.n);
      if (from === undefined || value === undefined) { h.ui.notify("notice.persons.gone"); return; }
      if (value.conflict) { h.ui.notify("notice.persons.conflict"); return; }
      if (!(await h.ui.confirmDetach(from, value))) return;
      const fresh = newId();
      const ok = await write(h, (current) => tableDetachValue(current, { id: slot.id, field: slot.field, n: slot.n, newId: fresh }), "notice.persons.storage", detachFailKey);
      if (ok) h.ui.notify("notice.persons.detachDone");
    },

    async forget(id) {
      if (h.memory.table() === null) { sayWhyNoTable(h); return; }
      await h.forget(id);
    },

    async addException() {
      if (h.memory.table() === null) { sayWhyNoTable(h); return; }
      const text = await h.ui.askException();
      if (text === null) return;
      const before = h.memory.table();
      const already = before !== null && tableIsException(before, text);
      const ok = await write(h, (current) => tableSetException(current, text, true), "notice.exceptions.storage", () => "notice.exceptions.failed");
      if (ok) h.ui.notify(already ? "notice.exceptions.already" : "notice.exceptions.added");
    },

    async removeException(text) {
      if (h.memory.table() === null) { sayWhyNoTable(h); return; }
      const ok = await write(h, (current) => tableSetException(current, text, false), "notice.exceptions.storage", () => "notice.exceptions.failed");
      if (ok) h.ui.notify("notice.exceptions.removed");
    },
  };
}
