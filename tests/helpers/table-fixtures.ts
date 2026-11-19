import {
  emptyTable,
  mergeTables,
  tableAddEntry,
  tableAddValue,
  tableForget,
  tableLinkEntries,
  type PlaceholderTable,
  type TableResult,
} from "../../src/vendor/kit/placeholder-table";
import type { PlaceholderField } from "../../src/vendor/kit/placeholder";

/** Erfundene Kennungen und Werte (nie echte Daten). */
export const PERSON = "k3x9m2ab7q";
export const PERSON_B = "m4t8c6r2vp";
export const ORG = "q7d2w8n4tz";

/** Packt ein Ergebnis der Kit-Tabelle aus; ein Fehler macht den Test laut. */
export function must<T extends { table: PlaceholderTable }>(r: TableResult<T> | ({ ok: true; table: PlaceholderTable } & T) | { ok: false; error: string }): PlaceholderTable {
  if (!r.ok) throw new Error(`fixture: ${r.error}`);
  return r.table;
}

export function withValue(table: PlaceholderTable, id: string, field: PlaceholderField | null, text: string): PlaceholderTable {
  return must(tableAddValue(table, { id, field, text }));
}

/** Eine Person mit zwei Namensformen, einer Mail-Adresse und zwei Telefonnummern:
 *  `Person_k3x9m2ab7q` = Max Mustermann, `_2` = Max, `_Mail`, `_Telefon` = 030 1234567, `_Telefon_2` = 0171 2345678. */
export function sampleTable(): PlaceholderTable {
  let t = must(tableAddEntry(emptyTable(), PERSON, "person"));
  t = withValue(t, PERSON, null, "Max Mustermann");
  t = withValue(t, PERSON, null, "Max");
  t = withValue(t, PERSON, "mail", "max@example.org");
  t = withValue(t, PERSON, "phone", "030 1234567");
  t = withValue(t, PERSON, "phone", "0171 2345678");
  return t;
}

export function forgetPerson(table: PlaceholderTable, id = PERSON): PlaceholderTable {
  return must(tableForget(table, id));
}

/** Zwei Geräte tragen am selben Platz (`Person_k3x9m2ab7q_Mail_2`) je einen anderen Wert ein; die Vereinigung hat dort einen Konflikt. */
export function conflictTable(): PlaceholderTable {
  const base = withValue(must(tableAddEntry(emptyTable(), PERSON, "person")), PERSON, null, "Max Mustermann");
  const withMail = withValue(base, PERSON, "mail", "max@example.org");
  const a = withValue(withMail, PERSON, "mail", "max.a@example.org");
  const b = withValue(withMail, PERSON, "mail", "max.b@example.org");
  return mergeTables(a, b);
}

/** Zwei Einträge, die jemand bewusst zusammengeführt hat: beide Kennungen gelten weiter. */
export function linkedTable(): PlaceholderTable {
  let t = must(tableAddEntry(emptyTable(), PERSON, "person"));
  t = withValue(t, PERSON, null, "Max Mustermann");
  t = must(tableAddEntry(t, PERSON_B, "person"));
  t = withValue(t, PERSON_B, null, "M. Mustermann");
  return must(tableLinkEntries(t, PERSON, PERSON_B));
}
