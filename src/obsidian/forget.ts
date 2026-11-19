// „Person vergessen“ als Ablauf (Bauplan Aufgabe 12; Spec 8.3 „Person vergessen“, „Grenzen des Vergessens“).
//
// Genau in dieser Reihenfolge: alle lesbaren Gerätedateien frisch lesen; den Eintrag wählen; den Plan aus dem frischen Stand rechnen (Werte, Geräte ohne lesbare Fassung, Ausnahmeliste);
// im Warndialog bestätigen; DANN erst vergessen (Marke, Werte weg, Stand n+1, Datei, dann Schlüssel; das macht `table-store.ts`). Importiert nichts aus `obsidian`.

import { listPersons, planForget } from "../core/forget-plan";
import { readyAfterRefresh, type KeyActionOutcome, type KeyActionsHost } from "./key-actions";

export async function runForget(h: KeyActionsHost): Promise<KeyActionOutcome> {
  if (!(await readyAfterRefresh(h))) return "failed";
  const table = h.memory.table();
  if (table === null) { h.ui.notify("notice.locked"); return "failed"; }
  const options = listPersons(table, h.memory.language());
  if (options.length === 0) { h.ui.notify("notice.forget.none"); return "nothing"; }
  const id = await h.ui.choosePerson(options);
  if (id === null) return "cancelled";
  // Der Plan beruht auf dem Stand nach dem Lesen und nach der Wahl; was dazwischen geschah, zeigt der nächste Lauf von `forget` (er liest ohnehin frisch).
  const now = h.memory.table();
  const plan = now === null ? null : planForget(now, h.memory.language(), id, h.memory.devices(), h.ownDeviceId());
  if (plan === null) { h.ui.notify("notice.forget.failed.unknown-entry"); return "failed"; }
  if (!(await h.ui.confirmForget(plan))) return "cancelled";
  const r = await h.store.forget(id);
  h.changed();
  if (r.ok) { h.ui.notify("notice.forget.done"); return "done"; }
  h.ui.notify(r.reason === "locked" ? "notice.locked" : r.reason === "not-ready" ? "notice.notSetUp" : `notice.forget.failed.${r.reason}`);
  return "failed";
}
