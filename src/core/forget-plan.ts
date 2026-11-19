// Was der Dialog „Person vergessen“ vor dem Bestätigen wissen muss (Bauplan Aufgabe 12; Spec 8.3 „Person vergessen“, „Grenzen des Vergessens“).
//
// Rein: liest die geöffnete Tabelle und die Geräteliste und rechnet aus, was der Dialog zeigt. Die Texte setzt die Obsidian-Schicht; hier steht nur, WAS gesagt werden muss.
// Der Klartext (Name, Werte) steht in diesen Werten, weil der Dialog ihn zeigen soll (Spec 8.3 Punkt 1: „der Dialog listet alle Werte des Eintrags, die unlesbar werden“).
// Er geht nie in eine Meldung über einen Fehler, ein Protokoll oder `console`.
import { formatPlaceholder, type PlaceholderField, type PlaceholderParts } from "../vendor/kit/placeholder";
import { tableEntry, tableGroups, tableIsException, normalizeTableValue, type EntryKind, type PlaceholderTable } from "../vendor/kit/placeholder-table";
import type { PlaceholderLanguage } from "./payload";
import type { DeviceView } from "./protocol";

/** Ein Wert des Eintrags, wie der Dialog ihn zeigt: der Platzhalter und der Klartext dahinter. */
export interface ForgetValue {
  placeholder: string;
  /** Die Teile des Platzhalters (Eintrag, Feld, Platz): so findet „Wert abhängen“ den Platz in der Tabelle. */
  parts: PlaceholderParts;
  field: PlaceholderField | null;
  text: string;
  onExceptionList: boolean;
  /** Der Platz trägt zwei Werte (zwei Geräte haben gleichzeitig geschrieben); der Platzhalter löst dort auf keinen von beiden auf. */
  conflict: boolean;
}

/** Ein Eintrag, den man vergessen kann: eine Gruppe zusammengehöriger IDs, vertreten durch die kleinste. */
export interface PersonOption {
  /** Die ID, mit der vergessen wird (die kleinste der Gruppe); die Marke deckt die ganze Gruppe. */
  id: string;
  /** Alle IDs der Gruppe (auch die zusammengeführten), sortiert; enthält `id`. Jede löst weiter auf. */
  ids: readonly string[];
  kind: EntryKind;
  /** Anzeigename: der erste Name, sonst der erste Wert, sonst der Platzhalter des Eintrags. */
  label: string;
  values: readonly ForgetValue[];
}

/** Was der Bestätigungsdialog braucht: der Eintrag und die zwei Listen aus Spec 8.3 (Geräte, deren Fassung nicht gelesen werden konnte) und der Ausnahmeliste. */
export interface ForgetPlan {
  option: PersonOption;
  /** Namen der Geräte, deren Fassung nicht lesbar war (ohne dieses Gerät): bei ihnen kann ein zweiter Eintrag derselben Person bestehen. */
  unreadableDevices: readonly string[];
  /** Ob ein Wert des Eintrags auf der Ausnahmeliste steht. Die Liste gehört zu keiner Person, der Wert bleibt dort auch nach dem Vergessen stehen. */
  exceptionListed: boolean;
}

function valueOf(table: PlaceholderTable, lang: PlaceholderLanguage, view: NonNullable<ReturnType<typeof tableEntry>>["values"][number]): ForgetValue {
  const placeholder = formatPlaceholder(view.placeholder, lang) ?? "";
  return { placeholder, parts: view.placeholder, field: view.value.field, text: view.value.text, onExceptionList: tableIsException(table, view.value.text), conflict: view.conflict };
}

/** Die Einträge, die sich vergessen lassen (alle, die nicht vergessen sind), in der Reihenfolge der Tabelle. Leer, wenn es keine gibt. */
export function listPersons(table: PlaceholderTable, lang: PlaceholderLanguage): PersonOption[] {
  const out: PersonOption[] = [];
  for (const group of tableGroups(table)) {
    const id = group[0];
    if (id === undefined) continue;
    const view = tableEntry(table, id);
    if (view === undefined) continue;
    const values = view.values.map((v) => valueOf(table, lang, v));
    const name = values.find((v) => v.field === null);
    const label = (name ?? values[0])?.text ?? formatPlaceholder({ carrier: view.kind === "none" ? null : view.kind, id, field: null, n: 1 }, lang) ?? id;
    out.push({ id, ids: view.ids, kind: view.kind, label, values });
  }
  return out;
}

/** Die Einträge, deren Namen, Platzhalter oder Werte den Suchtext tragen; leere Suche: alle. Gelesen wird auf zwei Wegen: als Name (Groß und Klein und Leerraum spielen keine Rolle, Teilstück genügt)
 *  und in der Form des Feldes, in dem der Wert steht (Telefon: `+49…` gegen `0171 …`, IBAN ohne Leerraum, Mail), damit eine andere Schreibweise derselben Nummer denselben Eintrag findet. */
export function filterPersons(options: readonly PersonOption[], query: string): PersonOption[] {
  const q = normalizeTableValue(null, query);
  if (q === "") return [...options];
  const byField = new Map<PlaceholderField | null, string>();
  const asField = (f: PlaceholderField | null): string => {
    let k = byField.get(f);
    if (k === undefined) { k = normalizeTableValue(f, query); byField.set(f, k); }
    return k;
  };
  const hit = (v: ForgetValue): boolean => {
    if (normalizeTableValue(null, v.text).includes(q) || v.placeholder.toLowerCase().includes(q)) return true;
    const k = asField(v.field);
    return k !== "" && normalizeTableValue(v.field, v.text).includes(k);
  };
  return options.filter((o) => normalizeTableValue(null, o.label).includes(q) || o.values.some(hit));
}

/** Die Geräte, deren Fassung sich nicht lesen ließ, ohne dieses Gerät, nach Namen sortiert (Spec 8.3 Grenzen). */
export function unreadableDeviceNames(devices: readonly DeviceView[], ownDeviceId: string): string[] {
  return devices.filter((d) => d.deviceId !== ownDeviceId && !d.opened).map((d) => d.name).sort((a, b) => a.localeCompare(b));
}

/** Der Plan für einen Eintrag; `null`, wenn die ID in der Tabelle nicht (mehr) als vergessbarer Eintrag steht. */
export function planForget(table: PlaceholderTable, lang: PlaceholderLanguage, id: string, devices: readonly DeviceView[], ownDeviceId: string): ForgetPlan | null {
  const option = listPersons(table, lang).find((o) => o.id === id);
  if (option === undefined) return null;
  return { option, unreadableDevices: unreadableDeviceNames(devices, ownDeviceId), exceptionListed: option.values.some((v) => v.onExceptionList) };
}
