// „Person vergessen“ als Ablauf (Bauplan Aufgabe 12; Spec 8.3 „Person vergessen“, „Grenzen des Vergessens“).
//
// Genau in dieser Reihenfolge: alle lesbaren Gerätedateien frisch lesen; den Eintrag wählen; den Plan aus dem frischen Stand rechnen (Werte, Geräte ohne lesbare Fassung, Ausnahmeliste);
// im Warndialog bestätigen; DANN erst vergessen (Marke, Werte weg, Stand n+1, Datei, dann Schlüssel; das macht `table-store.ts`). Importiert nichts aus `obsidian`.

import { listPersons, planForget } from "../core/forget-plan";
import { readyAfterRefresh, type KeyActionOutcome, type KeyActionsHost } from "./key-actions";

/** `preselected`: der Eintrag ist schon gewählt (die Ansicht Personen startet den Ablauf mit ihm); die Personenwahl entfällt, alles andere bleibt: frisch lesen, Plan, Warndialog, vergessen. */
export async function runForget(h: KeyActionsHost, preselected?: string): Promise<KeyActionOutcome> {
  if (!(await readyAfterRefresh(h))) return "failed";
  const table = h.memory.table();
  if (table === null) { h.ui.notify("notice.locked"); return "failed"; }
  const options = listPersons(table, h.memory.language());
  if (options.length === 0) { h.ui.notify("notice.forget.none"); return "nothing"; }
  // Ein vorgewählter Eintrag gilt über jede seiner IDs (die Gruppe kann sich seit dem Zeichnen der Ansicht geändert haben, etwa durch einen frisch gelesenen Link).
  const id = preselected === undefined ? await h.ui.choosePerson(options) : (options.find((o) => o.ids.includes(preselected))?.id ?? null);
  if (id === null) {
    if (preselected !== undefined) h.ui.notify("notice.forget.failed.unknown-entry");
    return preselected === undefined ? "cancelled" : "failed";
  }
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
