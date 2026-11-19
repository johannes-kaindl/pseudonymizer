import type { PersonOption } from "../core/forget-plan";
import { filterPersons } from "../core/forget-plan";
import type { PlaceholderField } from "../vendor/kit/placeholder";
import type { EntryKind } from "../vendor/kit/placeholder-table";
import { t } from "../vendor/kit/i18n";
import type { PersonsApi } from "./persons-actions";

/** Was die Ansicht zwischen zwei Zeichnungen behält: die Suche, ob das Suchfeld den Fokus hat, und der aufgeklappte Eintrag. */
export interface PersonsPanelState { query: string; selected: string | null; focus?: boolean }

const KIND_KEY: Record<EntryKind, string> = {
  person: "modal.lookup.kind.person",
  organisation: "modal.lookup.kind.organisation",
  none: "modal.lookup.kind.none",
};
const FIELD_KEY: Record<PlaceholderField | "name", string> = {
  name: "view.persons.field.name",
  mail: "view.persons.field.mail",
  phone: "view.persons.field.phone",
  address: "view.persons.field.address",
  iban: "view.persons.field.iban",
};

function button(parent: HTMLElement, text: string, cls: string, onClick: () => void, attr: Record<string, string> = {}): HTMLElement {
  const b = parent.createEl("button", { text, cls, attr: { type: "button", ...attr } });
  b.addEventListener("click", onClick);
  return b;
}

/** Der Aufbau eines aufgeklappten Eintrags: alle Werte mit Feld, Platzhalter und Klartext (die Ansicht ist zum Ansehen da), je Wert „Wert abhängen“, darunter Zusammenführen und Vergessen. */
function renderDetail(li: HTMLElement, o: PersonOption, api: PersonsApi): void {
  const detail = li.createDiv({ cls: "pseu-person-detail" });
  if (o.ids.length > 1) detail.createDiv({ cls: "pseu-note", text: t("view.persons.merged", o.ids.length) });
  if (o.values.length === 0) detail.createDiv({ cls: "pseu-note", text: t("view.persons.noValues") });
  const forms = detail.createEl("ul", { cls: "pseu-forms" });
  for (const v of o.values) {
    const row = forms.createEl("li", { cls: "pseu-form" });
    const main = row.createDiv({ cls: "pseu-form-main" });
    main.createSpan({ cls: "pseu-form-field", text: t(FIELD_KEY[v.field ?? "name"]) });
    main.createSpan({ cls: "pseu-form-text", text: v.text });
    row.createDiv({ cls: "pseu-form-placeholder", text: v.placeholder });
    if (v.conflict) row.createDiv({ cls: "pseu-warning", text: t("view.persons.conflict") });
    else button(row, t("view.persons.detach"), "pseu-form-detach", () => { void api.detach(o.id, v.parts); }, { "aria-label": t("view.persons.detachLabel", v.placeholder) });
  }
  const actions = detail.createDiv({ cls: "pseu-person-actions" });
  button(actions, t("view.persons.merge"), "pseu-person-merge", () => { void api.merge(o.id); });
  button(actions, t("view.persons.forget"), "mod-warning pseu-person-forget", () => { void api.forget(o.id); });
}

/** Der Reiter „Personen“ im Zustand `ready` (Spec 8.9): suchen über alle Formen, Werte und Formen ansehen, zusammenführen, Wert abhängen, vergessen. Ohne Einträge steht der Leerzustand da. */
export function renderPersons(parent: HTMLElement, api: PersonsApi, state: PersonsPanelState): void {
  const all = api.list();
  if (all.length === 0) {
    parent.createDiv({ cls: "pseu-empty" }).createDiv({ text: t("view.empty.persons") });
    return;
  }
  const root = parent.createDiv({ cls: "pseu-persons-panel" });
  const search = root.createEl("input", { cls: "pseu-search", attr: { type: "search", placeholder: t("view.persons.search.placeholder"), "aria-label": t("view.persons.search.label"), value: state.query } });
  search.value = state.query;
  const list = root.createDiv({ cls: "pseu-persons-list" });

  const paint = (): void => {
    list.empty();
    const shown = filterPersons(all, state.query);
    list.createDiv({ cls: "pseu-note pseu-persons-count", text: t("view.persons.count", shown.length, all.length) });
    if (shown.length === 0) {
      list.createDiv({ cls: "pseu-empty" }).createDiv({ text: t("view.persons.noMatch") });
      return;
    }
    const ul = list.createEl("ul", { cls: "pseu-persons" });
    for (const o of shown) {
      const open = state.selected !== null && o.ids.includes(state.selected);
      const li = ul.createEl("li", { cls: open ? "pseu-person is-open" : "pseu-person" });
      const head = button(li, "", "pseu-person-head", () => { state.selected = open ? null : o.id; paint(); }, { "aria-expanded": open ? "true" : "false" });
      head.createSpan({ cls: "pseu-person-label", text: o.label });
      head.createSpan({ cls: "pseu-person-meta", text: `${t(KIND_KEY[o.kind])} · ${t("modal.forget.pick.values", o.values.length)}` });
      if (open) renderDetail(li, o, api);
    }
  };
  search.addEventListener("input", () => { state.query = search.value; paint(); });
  // Eine Änderung von außen zeichnet den Reiter neu. Das Suchfeld bekommt dann Fokus und Schreibmarke zurück, statt das Neuzeichnen zu sperren: ein gesperrtes Neuzeichnen verschluckte den ersten Klick nach dem Tippen
  // (der Fokuswechsel beim Drücken würde neu zeichnen und den Knopf unter der Maus austauschen).
  search.addEventListener("focus", () => { state.focus = true; });
  // Ein entferntes Feld meldet je nach Browser `blur`; das gilt nicht als „der Nutzer hat das Feld verlassen“.
  search.addEventListener("blur", () => { if (search.isConnected) state.focus = false; });
  paint();
  if (state.focus === true) {
    search.focus();
    search.setSelectionRange?.(search.value.length, search.value.length);
  }
}
