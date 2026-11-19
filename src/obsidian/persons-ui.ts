import { Notice } from "obsidian";
import type { App } from "obsidian";
import { t } from "../vendor/kit/i18n";
import { confirmAction } from "../vendor/kit-obsidian/confirm";
import { promptText } from "../vendor/kit-obsidian/prompt-text";
import { pickPerson } from "./key-actions-ui";
import type { PersonsUi } from "./persons-actions";

/** Die Fenster für Zusammenführen, Abhängen und die Ausnahmeliste. Der Klartext steht nur in diesen Fenstern, solange sie offen sind; die Meldungen (Notice) nennen nie einen Wert. */
export function createPersonsUi(app: App): PersonsUi {
  return {
    choosePartner: (_from, options) => pickPerson(app, options, "modal.merge.pick.select"),
    confirmMerge: (a, b) => confirmAction(app, {
      title: t("modal.merge.title"),
      message: [t("modal.merge.message", a.label, b.label), t("modal.merge.keeps"), t("modal.merge.irreversible")],
      confirmLabel: t("modal.merge.confirm"),
      cancelLabel: t("modal.cancel"),
      warning: false,
    }),
    confirmDetach: (from, value) => confirmAction(app, {
      title: t("modal.detach.title"),
      message: [t("modal.detach.message", value.text, from.label), t("modal.detach.keeps", value.placeholder), t("modal.detach.stays"), t("modal.detach.notes")],
      confirmLabel: t("modal.detach.confirm"),
      cancelLabel: t("modal.cancel"),
      warning: false,
    }),
    askException: () => promptText(app, {
      title: t("modal.exception.title"),
      message: t("modal.exception.message"),
      placeholder: t("modal.exception.placeholder"),
      okLabel: t("modal.exception.ok"),
      cancelLabel: t("modal.cancel"),
    }),
    notify: (key, ...args) => { new Notice(t(key, ...args)); },
  };
}
