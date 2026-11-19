import { t } from "../vendor/kit/i18n";
import type { PersonsApi } from "./persons-actions";

/** Der Reiter „Ausnahmen“ im Zustand `ready` (Spec 8.2, 8.9): die Texte, die nie ersetzt werden. Die Liste liegt in der Tabelle, nie in `data.json`; hinzufügen und entfernen gehen über `persist`. */
export function renderExceptions(parent: HTMLElement, api: PersonsApi): void {
  const items = api.exceptions();
  const root = parent.createDiv({ cls: "pseu-exceptions-panel" });
  const add = (box: HTMLElement): void => {
    const b = box.createEl("button", { cls: "mod-cta pseu-exception-add", text: t("view.exceptions.add"), attr: { type: "button" } });
    b.addEventListener("click", () => { void api.addException(); });
  };
  if (items.length === 0) {
    const empty = root.createDiv({ cls: "pseu-empty" });
    empty.createDiv({ text: t("view.empty.exceptions") });
    add(empty.createDiv({ cls: "pseu-empty-actions" }));
    return;
  }
  root.createDiv({ cls: "pseu-note", text: t("view.exceptions.help") });
  const ul = root.createEl("ul", { cls: "pseu-exceptions" });
  items.forEach((text, i) => {
    const li = ul.createEl("li", { cls: "pseu-exception" });
    li.createSpan({ cls: "pseu-exception-text", text });
    const b = li.createEl("button", { cls: "pseu-exception-remove", text: t("view.exceptions.remove"), attr: { type: "button", "aria-label": t("view.exceptions.removeLabel", i + 1) } });
    b.addEventListener("click", () => { void api.removeException(text); });
  });
  add(root.createDiv({ cls: "pseu-exceptions-actions" }));
}
