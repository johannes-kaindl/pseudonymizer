import { Notice, SuggestModal } from "obsidian";
import type { App } from "obsidian";
import { filterPersons, type ForgetPlan, type PersonOption } from "../core/forget-plan";
import type { EntryKind } from "../vendor/kit/placeholder-table";
import { t } from "../vendor/kit/i18n";
import { confirmAction } from "../vendor/kit-obsidian/confirm";
import { showRecoveryCode } from "./code-modals";
import type { KeyActionsUi } from "./key-actions";

/** Personenwahl, Warndialoge und Meldungen von Obsidian für die Abläufe in `forget.ts` und `key-actions.ts`. Der Klartext steht nur in diesen Fenstern, solange sie offen sind. */

const KIND_KEY: Record<EntryKind, string> = {
  person: "modal.lookup.kind.person",
  organisation: "modal.lookup.kind.organisation",
  none: "modal.lookup.kind.none",
};

/** Vorschlagsdialog zur Wahl des Eintrags. `onChooseSuggestion` kommt in Obsidian NACH `onClose` (die Wahl schließt den Dialog zuerst): Abbrechen wird deshalb erst danach gemeldet. */
class PersonModal extends SuggestModal<PersonOption> {
  private done: ((id: string | null) => void) | null;

  constructor(app: App, private readonly options: readonly PersonOption[], done: (id: string | null) => void) {
    super(app);
    this.done = done;
    this.setPlaceholder(t("modal.forget.pick.placeholder"));
    this.emptyStateText = t("modal.forget.pick.empty");
    this.setInstructions([{ command: "↵", purpose: t("modal.forget.pick.select") }]);
  }

  getSuggestions(query: string): PersonOption[] {
    return filterPersons(this.options, query);
  }

  renderSuggestion(option: PersonOption, el: HTMLElement): void {
    el.createDiv({ cls: "pseu-suggest-label", text: option.label });
    el.createDiv({ cls: "pseu-suggest-meta", text: `${t(KIND_KEY[option.kind])} · ${t("modal.forget.pick.values", option.values.length)}` });
  }

  onChooseSuggestion(option: PersonOption): void {
    this.finish(option.id);
  }

  onClose(): void {
    super.onClose();
    // Nach einer Wahl läuft `onChooseSuggestion` unmittelbar nach `onClose`; erst danach darf „Abbrechen“ gelten.
    queueMicrotask(() => { this.finish(null); });
  }

  private finish(id: string | null): void {
    if (!this.done) return;
    const cb = this.done;
    this.done = null;
    cb(id);
  }
}

/** Die Zeilen des Warndialogs „Person vergessen“ (Spec 8.3): unumkehrbar, die Werte, Abhängen, Geräte ohne lesbare Fassung, Ausnahmeliste, wann vollständig vergessen ist, Rest des alten Schlüssels. */
export function forgetDialogLines(plan: ForgetPlan): string[] {
  const lines: string[] = [t("modal.forget.irreversible")];
  if (plan.option.values.length > 0) {
    lines.push(t("modal.forget.values"));
    for (const v of plan.option.values) lines.push(t("modal.forget.valueLine", v.placeholder, v.text));
    lines.push(t("modal.forget.detach"));
  }
  if (plan.unreadableDevices.length > 0) lines.push(t("modal.forget.devices", plan.unreadableDevices.join(", ")));
  if (plan.exceptionListed) lines.push(t("modal.forget.exception"));
  lines.push(t("modal.forget.complete"), t("modal.forget.keyLeft"));
  return lines;
}

export function createKeyActionsUi(app: App): KeyActionsUi {
  return {
    choosePerson: (options) => new Promise((resolve) => { new PersonModal(app, options, resolve).open(); }),
    confirmForget: (plan) => confirmAction(app, {
      title: t("modal.forget.title", plan.option.label),
      message: forgetDialogLines(plan),
      confirmLabel: t("modal.forget.confirm"),
      cancelLabel: t("modal.cancel"),
      warning: true,
    }),
    confirmReplaceKey: () => confirmAction(app, {
      title: t("modal.replace.title"),
      message: [t("modal.replace.message"), t("modal.replace.lost"), t("modal.replace.old")],
      confirmLabel: t("modal.replace.confirm"),
      cancelLabel: t("modal.cancel"),
      warning: true,
    }),
    confirmRemoveDevice: (device) => confirmAction(app, {
      title: t("modal.device.title", device.name),
      message: [device.readable ? t("modal.device.readable") : t("modal.device.unreadable"), t("modal.device.noAccess")],
      confirmLabel: t("modal.device.confirm"),
      cancelLabel: t("modal.cancel"),
      warning: true,
    }),
    showCode: (content, requireConfirmation) => showRecoveryCode(app, content, { requireConfirmation }),
    notify: (key, ...args) => { new Notice(t(key, ...args)); },
  };
}
